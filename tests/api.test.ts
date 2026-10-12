import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, handleApi } from "../src/lib/api/errors";
import { createApiHandlers } from "../src/lib/api/handlers";
import { siteRepository } from "../src/lib/database/repository";
import type { ApiContext } from "../src/lib/api/context";

const userId = crypto.randomUUID();
const websiteId = crypto.randomUUID();
const context = { userId, supabase: {} } as ApiContext;
const jsonRequest = (body: unknown) => new Request("http://localhost/api/websites", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("unauthenticated requests stop before repository access", async () => {
  let called = false;
  const handlers = createApiHandlers(
    async () => { throw new ApiError(401, "UNAUTHENTICATED", "Sign in required"); },
    { ...siteRepository, list: async () => { called = true; return []; } },
    () => { throw new Error("worker should not be created"); },
  );
  const response = await handlers.listWebsites();
  assert.equal(response.status, 401);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), { error: { code: "UNAUTHENTICATED", message: "Sign in required" } });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("registration rejects invalid URLs before database access", async () => {
  let called = false;
  const handlers = createApiHandlers(async () => context, {
    ...siteRepository,
    create: async () => { called = true; throw new Error("should not be called"); },
  }, () => { throw new Error("worker should not be created"); });
  const response = await handlers.registerWebsite(jsonRequest({ name: "Bad", url: "http://127.0.0.1" }));
  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
});

test("website registration writes through the worker for the authenticated owner", async () => {
  const inserted: Record<string, unknown>[] = [];
  const userDb = { from() { throw new Error("user client must not write websites"); } } as unknown as ApiContext["supabase"];
  const worker = { from(table: string) {
    assert.equal(table, "websites");
    return { insert(value: Record<string, unknown>) {
      inserted.push(value);
      return { select() { return { async single() { return { data: { id: websiteId, ...value }, error: null }; } }; } };
    } };
  } } as unknown as ApiContext["supabase"];
  const website = await siteRepository.create({ userId, supabase: userDb }, {
    name: "Example", url: "https://example.com/health", monitor_interval_seconds: 300,
    failure_threshold: 2, recovery_threshold: 2, is_enabled: true,
  }, () => worker);
  assert.equal(inserted[0]?.owner_user_id, userId);
  assert.equal(inserted[0]?.normalized_host, "example.com");
  assert.equal(website.id, websiteId);
});

test("unowned website is rejected before a privileged mutation", async () => {
  const filters: Array<[string, string]> = [];
  const query = {
    select() { return this; },
    eq(key: string, value: string) { filters.push([key, value]); return this; },
    is() { return this; },
    async maybeSingle() { return { data: null, error: null }; },
  };
  const db = { from(table: string) {
    assert.equal(table, "websites");
    return query;
  } } as unknown as ApiContext["supabase"];
  await assert.rejects(
    siteRepository.update({ userId, supabase: db }, websiteId, { name: "Changed" },
      () => { throw new Error("privileged client must not be created"); }),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  assert.deepEqual(filters, [["id", websiteId], ["owner_user_id", userId]]);
});

test("history cannot be read without owning its website", async () => {
  let queriedChecks = false;
  const db = { from(table: string) {
    if (table === "health_checks") queriedChecks = true;
    assert.equal(table, "websites");
    const query = {
      select() { return this; }, eq() { return this; }, is() { return this; },
      async maybeSingle() { return { data: null, error: null }; },
    };
    return query;
  } } as unknown as ApiContext["supabase"];
  await assert.rejects(
    siteRepository.checks({ userId, supabase: db }, websiteId, 10),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  assert.equal(queriedChecks, false);
});

test("owned website update uses a worker scoped to the authenticated owner", async () => {
  const filters: Array<[string, string]> = [];
  const owned = { id: websiteId, owner_user_id: userId };
  const userDb = { from() { return {
    select() { return this; }, eq() { return this; }, is() { return this; },
    async maybeSingle() { return { data: owned, error: null }; },
  }; } } as unknown as ApiContext["supabase"];
  const query = {
    eq(key: string, value: string) { filters.push([key, value]); return this; },
    is() { return this; }, select() { return this; },
    async maybeSingle() { return { data: owned, error: null }; },
  };
  const worker = { from(table: string) {
    assert.equal(table, "websites");
    return { update() { return query; } };
  } } as unknown as ApiContext["supabase"];
  const result = await siteRepository.update({ userId, supabase: userDb }, websiteId,
    { name: "Changed" }, () => worker);
  assert.equal(result.id, websiteId);
  assert.deepEqual(filters, [["id", websiteId], ["owner_user_id", userId]]);
});

test("soft removal checks affected worker rows without returning the hidden row", async () => {
  const filters: Array<[string, string]> = [];
  const userDb = { from() { return {
    select() { return this; }, eq() { return this; }, is() { return this; },
    async maybeSingle() { return { data: { id: websiteId }, error: null }; },
  }; } } as unknown as ApiContext["supabase"];
  const query = {
    eq(key: string, value: string) { filters.push([key, value]); return this; },
    is() { return this; },
    then(resolve: (result: { count: number; error: null }) => void) {
      resolve({ count: 1, error: null });
    },
  };
  const worker = { from(table: string) {
    assert.equal(table, "websites");
    return { update(_value: unknown, options: { count: string }) {
      assert.equal(options.count, "exact");
      return query;
    } };
  } } as unknown as ApiContext["supabase"];
  await siteRepository.remove({ userId, supabase: userDb }, websiteId, () => worker);
  assert.deepEqual(filters, [["id", websiteId], ["owner_user_id", userId]]);
});

test("API errors are stable and do not leak internal exceptions", async () => {
  const invalid = await handleApi(async () => { throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json"); });
  assert.equal(invalid.status, 415);
  assert.deepEqual(await invalid.json(), { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Expected application/json" } });
  const failed = await handleApi(async () => { throw new Error("secret database detail"); });
  assert.equal(failed.status, 500);
  assert.equal(JSON.stringify(await failed.json()).includes("secret database detail"), false);
});

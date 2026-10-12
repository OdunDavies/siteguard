import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiContext } from "../src/lib/api/context";
import { ApiError } from "../src/lib/api/errors";
import { demoHealthResponse } from "../src/lib/recovery/demo-health";
import { failDemo } from "../src/lib/recovery/service";

function readOnlyDemo(state: "healthy" | "failed" | null, databaseError = false) {
  const id = crypto.randomUUID();
  const calls: string[] = [];
  const worker = { from(table: string) {
    calls.push(`from:${table}`);
    return {
      select(columns: string) { calls.push(`select:${columns}`); return this; },
      eq(column: string, value: string) { calls.push(`eq:${column}:${value}`); return this; },
      async maybeSingle() {
        return { data: state ? { state } : null,
          error: databaseError ? { code: "DATABASE_ERROR" } : null };
      },
    };
  } } as unknown as SupabaseClient;
  return { id, calls, worker };
}

test("public demo health reads persisted healthy state without writing or exposing owner data", async () => {
  const { id, calls, worker } = readOnlyDemo("healthy");
  const response = await demoHealthResponse(worker, id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { status: "healthy" });
  assert.deepEqual(calls, ["from:demo_services", "select:state", `eq:id:${id}`]);
});

test("failed demo health returns 503 and missing resources reveal no private data", async () => {
  const failed = readOnlyDemo("failed");
  const response = await demoHealthResponse(failed.worker, failed.id);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "failed" });

  const missing = readOnlyDemo(null);
  const missingResponse = await demoHealthResponse(missing.worker, missing.id);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { status: "unavailable" });

  const unavailable = readOnlyDemo(null, true);
  const unavailableResponse = await demoHealthResponse(unavailable.worker, unavailable.id);
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), { status: "unavailable" });
});

test("unowned demo failure is rejected before the privileged RPC", async () => {
  const id = crypto.randomUUID();
  const ctx = { userId: crypto.randomUUID(), supabase: { from(table: string) {
    assert.equal(table, "websites");
    return {
      select() { return this; }, eq() { return this; }, is() { return this; },
      async maybeSingle() { return { data: null, error: null }; },
    };
  } } } as unknown as ApiContext;
  let called = false;
  const worker = { async rpc() { called = true; return { error: null }; } } as unknown as SupabaseClient;
  await assert.rejects(failDemo(ctx, worker, id, "normal"),
    (error: unknown) => error instanceof ApiError && error.status === 404);
  assert.equal(called, false);
});

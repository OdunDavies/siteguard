import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { authenticatedSubject, authenticatedUser, signInExistingUser, signOutCurrentUser } from "../src/lib/auth/session";

type Auth = SupabaseClient["auth"];
const auth = (methods: Record<string, unknown>) => methods as unknown as Auth;

test("successful login uses existing Supabase password auth", async () => {
  let calls = 0;
  const result = await signInExistingUser(auth({ async signInWithPassword(input: { email: string; password: string }) {
    calls++;
    assert.deepEqual(input, { email: "person@example.com", password: "test-password" });
    return { data: { session: { access_token: "test" } }, error: null };
  } }), "person@example.com", "test-password");
  assert.equal(result, true);
  assert.equal(calls, 1);
});

test("invalid credentials cannot establish a login", async () => {
  const result = await signInExistingUser(auth({ async signInWithPassword() {
    return { data: { session: null }, error: { message: "Invalid login credentials" } };
  } }), "person@example.com", "wrong-password");
  assert.equal(result, false);
});

test("unauthenticated dashboard resolves no user", async () => {
  const user = await authenticatedUser(auth({ async getUser() {
    return { data: { user: null }, error: { message: "Missing session" } };
  } }));
  assert.equal(user, null);
});

test("authenticated dashboard receives the verified user", async () => {
  const user = await authenticatedUser(auth({ async getUser() {
    return { data: { user: { id: "owner-id", email: "person@example.com" } }, error: null };
  } }));
  assert.equal(user?.email, "person@example.com");
});

test("expired session cannot access the dashboard or protected API", async () => {
  const expired = auth({
    async getUser() { return { data: { user: null }, error: { message: "expired" } }; },
    async getClaims() { return { data: null, error: { message: "expired" } }; },
  });
  assert.equal(await authenticatedUser(expired), null);
  assert.equal(await authenticatedSubject(expired), null);
});

test("sign-out uses local Supabase scope and removes authenticated access", async () => {
  let signedOut = false;
  const client = auth({
    async signOut(options: { scope: string }) {
      assert.equal(options.scope, "local");
      signedOut = true;
      return { error: null };
    },
    async getUser() {
      return { data: { user: signedOut ? null : { email: "person@example.com" } }, error: null };
    },
  });
  assert.equal(await signOutCurrentUser(client), true);
  assert.equal(await authenticatedUser(client), null);
});

test("protected API accepts the same authenticated user's claims", async () => {
  const subject = await authenticatedSubject(auth({ async getClaims() {
    return { data: { claims: { sub: "owner-id" } }, error: null };
  } }));
  assert.equal(subject, "owner-id");
});

test("Supabase SSR browser session cookies can be read by its server client", async () => {
  const jar = new Map<string, string>();
  const cookies = {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (items: Array<{ name: string; value: string }>) => {
      for (const item of items) jar.set(item.name, item.value);
    },
  };
  const user = { id: "owner-id", email: "person@example.com", app_metadata: {}, user_metadata: {},
    aud: "authenticated", created_at: "2026-01-01T00:00:00Z" };
  const fetchMock: typeof fetch = async (input) => new Response(JSON.stringify(
    String(input).endsWith("/user") ? user : {
      access_token: "test-access-token", refresh_token: "test-refresh-token",
      token_type: "bearer", expires_in: 3600, user,
    },
  ), { status: 200, headers: { "content-type": "application/json" } });
  const browser = createBrowserClient("https://example.supabase.co", "sb_publishable_test", {
    cookies, global: { fetch: fetchMock }, auth: { autoRefreshToken: false }, isSingleton: false,
  });
  assert.equal(await signInExistingUser(browser.auth, "person@example.com", "test-password"), true);
  assert.ok(jar.size > 0);
  const server = createServerClient("https://example.supabase.co", "sb_publishable_test", {
    cookies, global: { fetch: fetchMock }, auth: { autoRefreshToken: false },
  });
  const { data, error } = await server.auth.getUser();
  assert.equal(error, null);
  assert.equal(data.user?.id, "owner-id");
  assert.equal(await signOutCurrentUser(browser.auth), true);
  const afterSignOut = createServerClient("https://example.supabase.co", "sb_publishable_test", {
    cookies, global: { fetch: fetchMock }, auth: { autoRefreshToken: false },
  });
  assert.equal((await afterSignOut.auth.getUser()).data.user, null);
});

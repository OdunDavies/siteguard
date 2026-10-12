import assert from "node:assert/strict";
import test from "node:test";
import { supabasePublicEnv } from "../src/lib/database/env";

const names = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

function withPublicEnv(values: Partial<Record<(typeof names)[number], string>>, run: () => void) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    run();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("prefers the publishable key when both public key settings exist", () => {
  withPublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "legacy-anon-key",
  }, () => {
    assert.deepEqual(supabasePublicEnv(), {
      url: "https://example.supabase.co", key: "sb_publishable_example",
    });
  });
});

test("uses the legacy anon key only when the publishable key is absent or empty", () => {
  for (const publishable of [undefined, ""]) {
    withPublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "legacy-anon-key",
    }, () => assert.equal(supabasePublicEnv().key, "legacy-anon-key"));
  }
});

test("rejects missing URL or public key without including credentials in errors", () => {
  withPublicEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example" }, () => {
    assert.throws(supabasePublicEnv, /public environment is not configured/);
  });
  withPublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }, () => {
    assert.throws(supabasePublicEnv, /public environment is not configured/);
  });
});

test("rejects secret and service-role keys in public configuration", () => {
  const serviceRoleJwt = `e30.${btoa(JSON.stringify({ role: "service_role" }))}.signature`;
  for (const key of ["sb_secret_example", serviceRoleJwt]) {
    withPublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
    }, () => assert.throws(supabasePublicEnv, /contains a privileged key/));
  }
  withPublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: serviceRoleJwt,
  }, () => assert.throws(supabasePublicEnv, /contains a privileged key/));
});

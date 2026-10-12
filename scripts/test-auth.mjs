import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sessionPath = join(projectRoot, ".siteguard-test-session.json");
class SafeSetupError extends Error {}

async function main() {
  process.loadEnvFile(join(projectRoot, ".env.local"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.SITEGUARD_TEST_EMAIL;
  const password = process.env.SITEGUARD_TEST_PASSWORD;

  if (!url || !publicKey || !email || !password) {
    throw new SafeSetupError("Configure Supabase URL, a public key, SITEGUARD_TEST_EMAIL, and SITEGUARD_TEST_PASSWORD in .env.local");
  }
  if (publicKey.startsWith("sb_secret_") ||
    publicKey === process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new SafeSetupError("A privileged Supabase key cannot be used for test sign-in");
  }

  const supabase = createClient(url, publicKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token || !data.session.expires_at) {
    throw new SafeSetupError("Test sign-in failed; check the disposable credentials and email confirmation");
  }

  const { data: verified, error: verificationError } =
    await supabase.auth.getUser(data.session.access_token);
  if (verificationError || !verified.user ||
    verified.user.id !== data.session.user.id ||
    verified.user.email?.toLowerCase() !== email.trim().toLowerCase()) {
    throw new SafeSetupError("Test session identity verification failed");
  }

  const expiresAt = new Date(data.session.expires_at * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new SafeSetupError("Test session is already expired");
  }

  const temporaryPath = `${sessionPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({
        access_token: data.session.access_token,
        expires_at: expiresAt.toISOString(),
      }) + "\n");
    } finally {
      await file.close();
    }
    await rename(temporaryPath, sessionPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  console.log("Disposable test user authenticated and verified.");
  console.log(`Session expires at ${expiresAt.toISOString()}.`);
  console.log("Access token saved to the Git-ignored local session file.");
}

main().catch((error) => {
  // Never print SDK errors or configuration values; they may contain sensitive data.
  console.error(error instanceof SafeSetupError ? error.message : "Test authentication failed");
  process.exitCode = 1;
});

export function supabasePublicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  assertSafePublicSupabaseKeys();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase public environment is not configured");
  }

  return { url, key };
}

export function assertSafePublicSupabaseKeys() {
  // Check both variables: Next.js can inline either one into client JavaScript.
  for (const key of [process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY]) {
    if (key && (key.startsWith("sb_secret_") || isServiceRoleJwt(key))) {
      throw new Error("Supabase public environment contains a privileged key");
    }
  }
}

function isServiceRoleJwt(key: string): boolean {
  const payload = key.split(".")[1];
  if (!payload) return false;
  try {
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded).role === "service_role";
  } catch {
    return false;
  }
}

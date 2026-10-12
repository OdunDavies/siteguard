import type { SupabaseClient } from "@supabase/supabase-js";

type Auth = SupabaseClient["auth"];

export async function signInExistingUser(auth: Auth, email: string, password: string): Promise<boolean> {
  const { data, error } = await auth.signInWithPassword({ email, password });
  return !error && Boolean(data.session);
}

export async function authenticatedUser(auth: Auth) {
  const { data, error } = await auth.getUser();
  return error ? null : data.user;
}

export async function signOutCurrentUser(auth: Auth): Promise<boolean> {
  const { error } = await auth.signOut({ scope: "local" });
  return !error;
}

export async function authenticatedSubject(auth: Auth): Promise<string | null> {
  const { data, error } = await auth.getClaims();
  return error ? null : data?.claims?.sub ?? null;
}

import { createBrowserClient } from "@supabase/ssr";
import { supabasePublicEnv } from "./env";

export function createBrowserSupabaseClient() {
  const { url, key } = supabasePublicEnv();
  return createBrowserClient(url, key);
}

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/database/server";
import { ApiError } from "./errors";

export type ApiContext = { supabase: SupabaseClient; userId: string };

export async function requireApiContext(): Promise<ApiContext> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getClaims();
  const subject = data?.claims?.sub;
  if (error || !subject) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
  return { supabase, userId: subject };
}

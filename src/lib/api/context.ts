import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/database/server";
import { authenticatedSubject } from "@/lib/auth/session";
import { ApiError } from "./errors";

export type ApiContext = { supabase: SupabaseClient; userId: string };

export async function requireApiContext(): Promise<ApiContext> {
  const supabase = await createServerSupabaseClient();
  const subject = await authenticatedSubject(supabase.auth);
  if (!subject) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
  return { supabase, userId: subject };
}

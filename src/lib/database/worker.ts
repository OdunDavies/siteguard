import "server-only";

import { createClient } from "@supabase/supabase-js";
import { supabasePublicEnv } from "./env";

// Restricted to the monitoring service. Never import this module from a client component.
export function createMonitoringWorkerClient() {
  const { url } = supabasePublicEnv();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Monitoring database credential is not configured");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

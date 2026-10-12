import "server-only";

import type { ApiContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/errors";
import type { HealthCheck, Incident, Website } from "@/types/domain";

export type DemoService = { id: string; state: "healthy" | "failed"; reset_behavior: string };
export type RecoveryGrant = {
  id: string; website_id: string; action_id: string; resource_id: string;
  enabled: boolean; expires_at: string; max_uses: number; uses_count: number; revoked_at: string | null;
};
export type AgentRunRecord = {
  id: string; website_id: string; incident_id: string; status: string; mode: string;
  diagnosis_json: unknown; neatlogs_trace_id: string | null; started_at: string; finished_at: string | null;
};
export type RecoveryAttemptRecord = {
  id: string; website_id: string; agent_run_id: string; status: string; action_id: string;
  result_code: string | null; verification_check_id: string | null; requested_at: string;
};
export type AuditEventRecord = {
  id: string; website_id: string; incident_id: string | null; agent_run_id: string | null;
  recovery_attempt_id: string | null; event_type: string; decision: string | null;
  reason_code: string | null; occurred_at: string;
};
export type DashboardSnapshot = {
  websites: Website[];
  demos: DemoService[];
  checks: HealthCheck[];
  incidents: Incident[];
  runs: AgentRunRecord[];
  grants: RecoveryGrant[];
  attempts: RecoveryAttemptRecord[];
  events: AuditEventRecord[];
  refreshedAt: string;
};

export async function loadDashboardSnapshot(ctx: ApiContext): Promise<DashboardSnapshot> {
  const websitesResult = await ctx.supabase.from("websites").select("*")
    .eq("owner_user_id", ctx.userId).is("deleted_at", null)
    .order("created_at", { ascending: false }).limit(100);
  if (websitesResult.error) throw new ApiError(500, "DASHBOARD_UNAVAILABLE", "Dashboard data could not be loaded");
  const websites = (websitesResult.data ?? []) as Website[];
  if (!websites.length) return {
    websites: [], demos: [], checks: [], incidents: [], runs: [], grants: [], attempts: [], events: [],
    refreshedAt: new Date().toISOString(),
  };
  const ids = websites.map((site) => site.id);
  const [demos, checks, incidents, runs, grants, attempts, events] = await Promise.all([
    ctx.supabase.from("demo_services").select("id,state,reset_behavior").in("id", ids),
    ctx.supabase.from("health_checks").select("*").in("website_id", ids)
      .order("checked_at", { ascending: false }).limit(100),
    ctx.supabase.from("incidents").select("*").in("website_id", ids)
      .order("started_at", { ascending: false }).limit(100),
    ctx.supabase.from("agent_runs")
      .select("id,website_id,incident_id,status,mode,diagnosis_json,neatlogs_trace_id,started_at,finished_at")
      .in("website_id", ids).order("started_at", { ascending: false }).limit(100),
    ctx.supabase.from("recovery_authorizations")
      .select("id,website_id,action_id,resource_id,enabled,expires_at,max_uses,uses_count,revoked_at")
      .in("website_id", ids).order("created_at", { ascending: false }).limit(100),
    ctx.supabase.from("recovery_attempts")
      .select("id,website_id,agent_run_id,status,action_id,result_code,verification_check_id,requested_at")
      .in("website_id", ids).order("requested_at", { ascending: false }).limit(100),
    ctx.supabase.from("audit_events")
      .select("id,website_id,incident_id,agent_run_id,recovery_attempt_id,event_type,decision,reason_code,occurred_at")
      .in("website_id", ids).order("occurred_at", { ascending: false }).limit(100),
  ]);
  if ([demos, checks, incidents, runs, grants, attempts, events].some((result) => result.error)) {
    throw new ApiError(500, "DASHBOARD_UNAVAILABLE", "Dashboard data could not be loaded");
  }
  return {
    websites,
    demos: (demos.data ?? []) as DemoService[],
    checks: (checks.data ?? []) as HealthCheck[],
    incidents: (incidents.data ?? []) as Incident[],
    runs: (runs.data ?? []) as AgentRunRecord[],
    grants: (grants.data ?? []) as RecoveryGrant[],
    attempts: (attempts.data ?? []) as RecoveryAttemptRecord[],
    events: (events.data ?? []) as AuditEventRecord[],
    refreshedAt: new Date().toISOString(),
  };
}

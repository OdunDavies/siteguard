import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/errors";
import { requireOwnedWebsite } from "@/lib/database/repository";
import { parseWebsiteUrl } from "@/lib/validation/website";
import type { DiagnosisState } from "@/lib/agents/diagnosis-graph";
import type { Incident } from "@/types/domain";

export type RunClaim = { run_id: string; is_new: boolean; run_status: string };
export type AttemptClaim = { attempt_id: string | null; decision: "allowed" | "denied" | "duplicate" };
export type Verification = { check_id: string | null; outcome: "recovered" | "retry" | "escalated"; checked_at: string | null };

function rpcError(): never {
  throw new ApiError(500, "RECOVERY_DATABASE_ERROR", "Recovery database operation failed");
}

export async function requireOwnedIncident(ctx: ApiContext, incidentId: string): Promise<Incident> {
  const { data, error } = await ctx.supabase.from("incidents").select("*")
    .eq("id", incidentId).maybeSingle();
  if (error) rpcError();
  if (!data) throw new ApiError(404, "NOT_FOUND", "Incident not found");
  const incident = data as Incident;
  await requireOwnedWebsite(ctx, incident.website_id);
  return incident;
}

export async function startAgentRun(ctx: ApiContext, worker: SupabaseClient,
  incidentId: string, requestKey: string, mode: "diagnosis" | "recovery"): Promise<RunClaim> {
  await requireOwnedIncident(ctx, incidentId);
  const { data, error } = await worker.rpc("agent_start_run", {
    p_incident_id: incidentId, p_owner_id: ctx.userId,
    p_request_key: requestKey, p_mode: mode,
  });
  if (error?.code === "23505") throw new ApiError(409, "RUN_CONFLICT", "Another run is active or the key is reused");
  if (error?.code === "22023") throw new ApiError(429, "RUN_UNAVAILABLE", "Run is unavailable or rate limited");
  if (error) rpcError();
  const claim = (data as RunClaim[] | null)?.[0];
  if (!claim) rpcError();
  return claim;
}

export async function storeDiagnosis(worker: SupabaseClient, state: DiagnosisState): Promise<void> {
  if (!state.diagnosis) throw new ApiError(500, "DIAGNOSIS_FAILED", "Diagnosis produced no result");
  const { error } = await worker.rpc("agent_store_diagnosis", {
    p_run_id: state.agentRunId,
    p_diagnosis: state.diagnosis,
    p_step_count: state.stepCount,
  });
  if (error) rpcError();
}

export async function failRun(worker: SupabaseClient, runId: string): Promise<void> {
  const { error } = await worker.rpc("agent_fail_run", {
    p_run_id: runId, p_reason: "diagnosis_failed",
  });
  if (error) rpcError();
}

export async function setAgentTraceId(worker: SupabaseClient, runId: string, traceId: string): Promise<void> {
  const { error } = await worker.rpc("agent_set_trace_id", {
    p_run_id: runId, p_trace_id: traceId,
  });
  if (error) rpcError();
}

export async function escalateRun(worker: SupabaseClient, runId: string,
  reason: "no_safe_action" | "authorization_denied" | "tool_failed" | "verification_failed" | "run_failed" | "incident_changed"): Promise<void> {
  const { error } = await worker.rpc("recovery_escalate_run", {
    p_run_id: runId, p_reason: reason,
  });
  if (error) rpcError();
}

export async function beginAttempt(worker: SupabaseClient, runId: string,
  ownerId: string, authorizationId: string, number: 1 | 2): Promise<AttemptClaim> {
  const { data, error } = await worker.rpc("recovery_begin_attempt", {
    p_run_id: runId, p_owner_id: ownerId,
    p_authorization_id: authorizationId,
    p_idempotency_key: `${runId}:reset_demo_service:${number}`,
  });
  if (error) rpcError();
  const claim = (data as AttemptClaim[] | null)?.[0];
  if (!claim) rpcError();
  return claim;
}

export async function verifyAttempt(worker: SupabaseClient, attemptId: string): Promise<Verification> {
  const { data, error } = await worker.rpc("recovery_verify_attempt", { p_attempt_id: attemptId });
  if (error) rpcError();
  const result = (data as Verification[] | null)?.[0];
  if (!result) rpcError();
  return result;
}

export async function demoResourceExists(ctx: ApiContext, websiteId: string): Promise<boolean> {
  await requireOwnedWebsite(ctx, websiteId);
  const { data, error } = await ctx.supabase.from("demo_services").select("id")
    .eq("id", websiteId).maybeSingle();
  if (error) rpcError();
  return Boolean(data);
}

function demoOrigin(): { origin: string; host: string } {
  const raw = process.env.SITEGUARD_DEMO_ORIGIN;
  if (!raw) throw new ApiError(503, "DEMO_NOT_CONFIGURED", "Controlled demo origin is not configured");
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError(503, "DEMO_NOT_CONFIGURED", "Controlled demo origin is invalid"); }
  if (url.protocol !== "https:" || url.origin !== raw || url.port || url.username || url.password ||
    !parseWebsiteUrl(`${raw}/api/demo/health/00000000-0000-4000-8000-000000000000`)) {
    throw new ApiError(503, "DEMO_NOT_CONFIGURED", "Controlled demo origin is invalid");
  }
  return { origin: raw, host: url.hostname };
}

export async function provisionDemo(ctx: ApiContext, worker: SupabaseClient): Promise<{ id: string; health_url: string }> {
  const { origin, host } = demoOrigin();
  const { data, error } = await worker.rpc("demo_provision", {
    p_owner_id: ctx.userId, p_origin: origin, p_host: host,
  });
  if (error || typeof data !== "string") rpcError();
  return { id: data, health_url: `${origin}/api/demo/health/${data}` };
}

export async function failDemo(ctx: ApiContext, worker: SupabaseClient,
  websiteId: string, behavior: "normal" | "no_effect" | "permanent_failure"): Promise<void> {
  await requireOwnedWebsite(ctx, websiteId);
  const { error } = await worker.rpc("demo_set_failed", {
    p_demo_id: websiteId, p_owner_id: ctx.userId, p_behavior: behavior,
  });
  if (error) rpcError();
}

export async function grantDemoRecovery(ctx: ApiContext, worker: SupabaseClient,
  websiteId: string, expiresAt: string, maxUses: number): Promise<{ id: string }> {
  await requireOwnedWebsite(ctx, websiteId);
  const { data, error } = await worker.rpc("demo_grant_recovery", {
    p_demo_id: websiteId, p_owner_id: ctx.userId,
    p_expires_at: expiresAt, p_max_uses: maxUses,
  });
  if (error || typeof data !== "string") rpcError();
  return { id: data };
}

export async function revokeDemoRecovery(ctx: ApiContext, worker: SupabaseClient,
  authorizationId: string): Promise<void> {
  const { data, error } = await worker.rpc("demo_revoke_recovery", {
    p_authorization_id: authorizationId, p_owner_id: ctx.userId,
  });
  if (error) rpcError();
  if (!data) throw new ApiError(404, "NOT_FOUND", "Authorization not found");
}

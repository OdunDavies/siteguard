// Run only against a disposable Supabase project after all three migrations are applied.
// This script leaves its fixture rows in place so their audit trail can be inspected.
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import type { ApiContext } from "../src/lib/api/context";
import type { DiagnosisModel } from "../src/lib/agents/model";
import { runRecoveryGraph } from "../src/lib/recovery/graph";
import { startAgentRun } from "../src/lib/recovery/service";
import { supabasePublicEnv } from "../src/lib/database/env";

const { url, key: publicKey } = supabasePublicEnv();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const accessToken = process.env.SITEGUARD_TEST_ACCESS_TOKEN;
const origin = process.env.SITEGUARD_DEMO_ORIGIN;
if (!serviceKey || !accessToken || !origin) {
  throw new Error("Integration test requires Supabase keys, SITEGUARD_TEST_ACCESS_TOKEN and SITEGUARD_DEMO_ORIGIN");
}

const worker = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userClient = createClient(url, publicKey, {
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: auth, error: authError } = await userClient.auth.getUser(accessToken);
assert.ifError(authError);
assert.ok(auth.user?.id, "A real authenticated test user is required");
const ctx: ApiContext = { supabase: userClient, userId: auth.user.id };
const host = new URL(origin).hostname;

function unwrap<T>(result: { data: unknown; error: { message: string } | null }, stage: string): T {
  if (result.error) throw new Error(`${stage}: ${result.error.message}`);
  if (result.data === null) throw new Error(`${stage}: no data returned`);
  return result.data as T;
}
function ensureNoError(result: { error: { message: string } | null }, stage: string): void {
  if (result.error) throw new Error(`${stage}: ${result.error.message}`);
}

const websiteId = unwrap(await worker.rpc("demo_provision", {
  p_owner_id: ctx.userId, p_origin: origin, p_host: host,
}), "provision demo") as string;
ensureNoError(await worker.rpc("demo_set_failed", {
  p_demo_id: websiteId, p_owner_id: ctx.userId, p_behavior: "normal",
}), "fail demo");

// Fixture setup writes two real observations and an incident. The recovery graph
// then reads them through the user's RLS client, not the privileged worker.
const checkRows = [0, 1].map((index) => ({
  website_id: websiteId,
  scheduled_for: new Date(Date.now() + index * 1000).toISOString(),
  status: "unhealthy", http_status: 500, latency_ms: 1,
  failure_kind: "http_error", error_code: "DEMO_UNHEALTHY",
}));
const checks = unwrap<Array<{ id: string }>>(await worker.from("health_checks").insert(checkRows).select("id"), "insert observations");
assert.equal(checks.length, 2);
const incident = unwrap<{ id: string }>(await worker.from("incidents").insert({
  website_id: websiteId, status: "open", failure_kind: "http_error",
  consecutive_failures: 2, last_check_id: checks[1].id,
}).select("id").single(), "open incident");
ensureNoError(await worker.from("health_checks").update({ incident_id: incident.id })
  .in("id", checks.map((check) => check.id)), "link observations");
const authorizationId = unwrap(await worker.rpc("demo_grant_recovery", {
  p_demo_id: websiteId, p_owner_id: ctx.userId,
  p_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), p_max_uses: 2,
}), "grant recovery") as string;

const model: DiagnosisModel = { async assess(input) {
  const parsed = JSON.parse(input) as { evidence: Array<{ ref: string }> };
  const ref = parsed.evidence.find((item) => item.ref.startsWith("check:"))?.ref;
  assert.ok(ref, "Expected actual failed-check evidence");
  return {
    observed_symptoms: ["Repeated HTTP 500 checks"],
    probable_causes: [{ cause: "Controlled service is failed", evidence_refs: [ref] }],
    unknowns: [], confidence: "high" as const, next_tool: "http_error_analysis" as const,
  };
} };
const claim = await startAgentRun(ctx, worker, incident.id, crypto.randomUUID(), "recovery");
assert.equal(claim.is_new, true);
const outcome = await runRecoveryGraph(ctx, worker, model, incident.id, authorizationId, claim.run_id);
assert.equal(outcome.outcome, "recovered");

const demo = unwrap<{ state: string }>(await worker.from("demo_services").select("state").eq("id", websiteId).single(), "read demo");
const savedRun = unwrap<{ status: string; incident_id: string; authorization_decision: string; selected_action: string; diagnosis_json: unknown }>(await worker.from("agent_runs").select("status,incident_id,authorization_decision,selected_action,diagnosis_json")
  .eq("id", claim.run_id).single(), "read run");
const savedIncident = unwrap<{ status: string; last_check_id: string }>(await worker.from("incidents").select("status,last_check_id")
  .eq("id", incident.id).single(), "read incident");
const attempts = unwrap<Array<{ id: string; agent_run_id: string; status: string; verification_check_id: string }>>(await worker.from("recovery_attempts").select("id,agent_run_id,status,verification_check_id")
  .eq("agent_run_id", claim.run_id), "read attempts");
assert.equal(demo.state, "healthy");
assert.equal(savedRun.status, "recovered");
assert.equal(savedRun.incident_id, incident.id);
assert.equal(savedRun.authorization_decision, "allowed");
assert.equal(savedRun.selected_action, "reset_demo_service");
assert.ok(savedRun.diagnosis_json);
assert.equal(savedIncident.status, "recovered");
assert.equal(attempts.length, 1);
assert.equal(attempts[0].agent_run_id, claim.run_id);
assert.equal(attempts[0].status, "succeeded");
assert.equal(attempts[0].verification_check_id, savedIncident.last_check_id);
const audit = unwrap<Array<{ event_type: string }>>(await worker.from("audit_events").select("event_type")
  .eq("agent_run_id", claim.run_id), "read audit");
assert.ok(audit.some((event) => event.event_type === "recovery.verified"));
console.log("Controlled integration recovery passed; run ID:", claim.run_id);

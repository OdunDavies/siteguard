import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiContext } from "../src/lib/api/context";
import type { DiagnosisModel } from "../src/lib/agents/model";
import { runRecoveryGraph } from "../src/lib/recovery/graph";
import { beginAttempt, requireOwnedIncident, startAgentRun } from "../src/lib/recovery/service";
import { actionInputSchema } from "../src/lib/recovery/validation";
import { createAgentTelemetry } from "../src/lib/observability/agent-telemetry";

type DemoBehavior = "normal" | "no_effect" | "permanent_failure";

function fixture(behavior: DemoBehavior = "normal", ambiguous = false) {
  const ownerId = crypto.randomUUID();
  const websiteId = crypto.randomUUID();
  const incidentId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const authorizationId = crypto.randomUUID();
  const firstCheckId = crypto.randomUUID();
  const website = { id: websiteId, owner_user_id: ownerId, deleted_at: null,
    monitor_interval_seconds: 300, failure_threshold: 2, recovery_threshold: 2, is_enabled: true };
  const incident = { id: incidentId, website_id: websiteId, status: "open",
    failure_kind: "http_error", consecutive_failures: 2, resolved_at: null };
  const checks = [0, 1].map((index) => ({
    id: index ? crypto.randomUUID() : firstCheckId, website_id: websiteId,
    checked_at: new Date(Date.now() - index * 60_000).toISOString(),
    status: "unhealthy", http_status: 500, latency_ms: 80,
    failure_kind: "http_error", error_code: "HTTP_ERROR",
  }));
  const demo = { id: websiteId, state: "failed", reset_behavior: behavior };
  const grant = { id: authorizationId, website_id: websiteId, action_id: "reset_demo_service",
    resource_id: websiteId, enabled: true, revoked_at: null as string | null,
    expires_at: new Date(Date.now() + 60_000).toISOString(), max_uses: 2, uses_count: 0 };
  const run = { id: runId, incident_id: incidentId, website_id: websiteId,
    status: "running", mode: "recovery", attempt_count: 0, diagnosis_json: null as unknown,
    neatlogs_trace_id: null as string | null };
  const attempts: Array<{ id: string; agent_run_id: string; authorization_id: string;
    idempotency_key: string; status: string; result_code: string | null;
    verification_check_id: string | null }> = [];
  const audit: string[] = [];
  const tables: Record<string, Record<string, unknown>[]> = {
    websites: [website], incidents: [incident], health_checks: checks,
    demo_services: [demo], agent_runs: [run], recovery_authorizations: [grant],
    recovery_attempts: attempts,
  };
  const ctx = { userId: ownerId, supabase: { from(table: string) {
    let rows = [...(tables[table] ?? [])];
    const query = {
      select() { return this; },
      eq(key: string, value: unknown) { rows = rows.filter((row) => row[key] === value); return this; },
      is(key: string, value: unknown) { rows = rows.filter((row) => row[key] === value); return this; },
      order() { return this; },
      limit(count: number) { rows = rows.slice(0, count); return this; },
      async maybeSingle() { return { data: rows[0] ?? null, error: null }; },
      then(resolve: (value: unknown) => void) { resolve({ data: rows, error: null }); },
    };
    return query;
  } } } as unknown as ApiContext;
  const worker = { async rpc(name: string, args: Record<string, unknown>) {
    if (name === "agent_set_trace_id") {
      run.neatlogs_trace_id = String(args.p_trace_id);
      return { data: null, error: null };
    }
    if (name === "agent_start_run") {
      if (args.p_owner_id !== ownerId) return { data: null, error: { code: "22023" } };
      return { data: [{ run_id: runId, is_new: true, run_status: run.status }], error: null };
    }
    if (name === "agent_store_diagnosis") {
      run.diagnosis_json = args.p_diagnosis;
      audit.push("diagnosis.recorded");
      return { data: null, error: null };
    }
    if (name === "recovery_begin_attempt") {
      const existing = attempts.find((attempt) => attempt.idempotency_key === args.p_idempotency_key);
      if (existing) return { data: [{ attempt_id: existing.id, decision: "duplicate" }], error: null };
      const valid = args.p_owner_id === ownerId && args.p_authorization_id === grant.id &&
        grant.enabled && !grant.revoked_at && Date.parse(grant.expires_at) > Date.now() &&
        grant.action_id === "reset_demo_service" && grant.resource_id === websiteId &&
        grant.uses_count < grant.max_uses && run.attempt_count < 2;
      if (!valid) {
        run.status = "escalated"; incident.status = "escalated";
        audit.push("recovery.denied");
        return { data: [{ attempt_id: null, decision: "denied" }], error: null };
      }
      const attempt = { id: crypto.randomUUID(), agent_run_id: runId,
        authorization_id: grant.id, idempotency_key: String(args.p_idempotency_key),
        status: "pending", result_code: null, verification_check_id: null };
      attempts.push(attempt);
      grant.uses_count++; run.attempt_count++;
      audit.push("recovery.authorized");
      return { data: [{ attempt_id: attempt.id, decision: "allowed" }], error: null };
    }
    if (name === "demo_execute_reset") {
      if (ambiguous) return { data: null, error: { code: "CONNECTION_LOST" } };
      const attempt = attempts.find((item) => item.id === args.p_attempt_id)!;
      if (!grant.enabled || grant.revoked_at) {
        attempt.status = "failed"; attempt.result_code = "AUTHORIZATION_REVOKED";
        run.status = "escalated"; incident.status = "escalated";
        return { data: [{ result_code: "AUTHORIZATION_REVOKED", retryable: false }], error: null };
      }
      if (demo.reset_behavior === "normal") demo.state = "healthy";
      attempt.status = demo.reset_behavior === "permanent_failure" ? "failed" : "succeeded";
      attempt.result_code = demo.reset_behavior === "normal" ? "RESET_APPLIED"
        : demo.reset_behavior === "no_effect" ? "RESET_NO_EFFECT" : "TOOL_PERMANENT_FAILURE";
      audit.push("recovery.executed");
      return { data: [{ result_code: attempt.result_code, retryable: demo.reset_behavior === "no_effect" }], error: null };
    }
    if (name === "recovery_verify_attempt") {
      const attempt = attempts.find((item) => item.id === args.p_attempt_id)!;
      const checkId = crypto.randomUUID();
      attempt.verification_check_id = checkId;
      checks.unshift({ id: checkId, website_id: websiteId, checked_at: new Date().toISOString(),
        status: demo.state === "healthy" ? "healthy" : "unhealthy",
        http_status: demo.state === "healthy" ? 200 : 500,
        latency_ms: 0, failure_kind: "http_error", error_code: "HTTP_ERROR" });
      const outcome = demo.state === "healthy" && (attempt.status === "succeeded" || attempt.status === "unknown")
        ? "recovered" : run.attempt_count >= 2 || attempt.result_code === "TOOL_PERMANENT_FAILURE"
          || attempt.status === "unknown" ? "escalated" : "retry";
      if (outcome !== "retry") { run.status = outcome; incident.status = outcome; }
      audit.push("recovery.verified");
      return { data: [{ check_id: checkId, outcome, checked_at: new Date().toISOString() }], error: null };
    }
    if (name === "recovery_escalate_run") {
      run.status = "escalated"; incident.status = "escalated";
      audit.push("recovery.escalated");
      return { data: null, error: null };
    }
    if (name === "recovery_mark_unknown") {
      const attempt = attempts.find((item) => item.id === args.p_attempt_id)!;
      attempt.status = "unknown"; attempt.result_code = "UNKNOWN_OUTCOME";
      return { data: null, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  } } as unknown as SupabaseClient;
  const model: DiagnosisModel = { async assess(input) {
    const ref = input.includes("pattern:http") ? "pattern:http" : `check:${firstCheckId}`;
    return { observed_symptoms: ["Repeated HTTP 500 checks"],
      probable_causes: [{ cause: "Possible application failure", evidence_refs: [ref] }],
      unknowns: ["Application logs unavailable"], confidence: "medium",
      next_tool: "http_error_analysis" };
  } };
  return { ctx, worker, model, ownerId, websiteId, incidentId, runId,
    authorizationId, website, incident, demo, grant, run, attempts, audit, checks };
}

test("authorized demo reset updates mocked persistent state and linked verification", async () => {
  const f = fixture();
  const result = await runRecoveryGraph(f.ctx, f.worker, f.model, f.incidentId, f.authorizationId, f.runId);
  assert.equal(f.demo.state, "healthy");
  assert.equal(result.outcome, "recovered");
  assert.equal(f.run.status, "recovered");
  assert.equal(f.incident.status, "recovered");
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].verification_check_id, result.verification?.check_id);
  assert.equal(f.attempts[0].agent_run_id, f.runId);
  assert.ok(f.run.diagnosis_json);
  assert.ok(f.audit.includes("recovery.authorized"));
  assert.ok(f.audit.includes("recovery.verified"));
});

for (const denial of ["missing", "expired", "revoked", "wrong_resource"] as const) {
  test(`${denial} authorization prevents execution`, async () => {
    const f = fixture();
    if (denial === "expired") f.grant.expires_at = new Date(Date.now() - 1_000).toISOString();
    if (denial === "revoked") f.grant.revoked_at = new Date().toISOString();
    if (denial === "wrong_resource") f.grant.resource_id = crypto.randomUUID();
    const authId = denial === "missing" ? crypto.randomUUID() : f.authorizationId;
    const result = await runRecoveryGraph(f.ctx, f.worker, f.model, f.incidentId, authId, f.runId);
    assert.equal(result.outcome, "escalated");
    assert.equal(f.demo.state, "failed");
    assert.equal(f.attempts.length, 0);
  });
}

test("duplicate attempt key cannot execute a second recovery action", async () => {
  const f = fixture();
  const first = await beginAttempt(f.worker, f.runId, f.ownerId, f.authorizationId, 1);
  const second = await beginAttempt(f.worker, f.runId, f.ownerId, f.authorizationId, 1);
  assert.equal(first.decision, "allowed");
  assert.equal(second.decision, "duplicate");
  assert.equal(f.grant.uses_count, 1);
  assert.equal(f.attempts.length, 1);
});

test("failed verification retries at most twice, then escalates", async () => {
  const f = fixture("no_effect");
  const result = await runRecoveryGraph(f.ctx, f.worker, f.model, f.incidentId, f.authorizationId, f.runId);
  assert.equal(result.outcome, "escalated");
  assert.equal(f.attempts.length, 2);
  assert.equal(f.demo.state, "failed");
  assert.equal(f.run.status, "escalated");
  assert.equal(f.checks.filter((check) => f.attempts.some((attempt) => attempt.verification_check_id === check.id)).length, 2);
});

test("permanent recovery tool failure escalates after one verified attempt", async () => {
  const f = fixture("permanent_failure");
  const result = await runRecoveryGraph(f.ctx, f.worker, f.model, f.incidentId, f.authorizationId, f.runId);
  assert.equal(result.outcome, "escalated");
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].result_code, "TOOL_PERMANENT_FAILURE");
  assert.ok(f.attempts[0].verification_check_id);
});

test("uncertain tool response is verified once and escalated without replay", async () => {
  const f = fixture("normal", true);
  const result = await runRecoveryGraph(f.ctx, f.worker, f.model, f.incidentId, f.authorizationId, f.runId);
  assert.equal(result.outcome, "escalated");
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].status, "unknown");
  assert.ok(f.attempts[0].verification_check_id);
  assert.equal(f.demo.state, "failed");
});

test("malformed diagnosis never reaches the recovery action", async () => {
  const f = fixture();
  const invalid = { async assess() { return { invalid: true }; } } as unknown as DiagnosisModel;
  const result = await runRecoveryGraph(f.ctx, f.worker, invalid, f.incidentId, f.authorizationId, f.runId);
  assert.equal(result.outcome, "escalated");
  assert.equal(f.attempts.length, 0);
  assert.equal(f.demo.state, "failed");
});

test("run creation checks ownership before a privileged RPC", async () => {
  const f = fixture();
  f.ctx.userId = crypto.randomUUID();
  await assert.rejects(startAgentRun(f.ctx, f.worker, f.incidentId, crypto.randomUUID(), "recovery"));
  await assert.rejects(requireOwnedIncident(f.ctx, f.incidentId));
});

test("tool inputs reject arbitrary action IDs and malformed resource IDs", () => {
  assert.equal(actionInputSchema.safeParse({ action_id: "shell_exec", resource_id: crypto.randomUUID(), attempt_id: crypto.randomUUID() }).success, false);
  assert.equal(actionInputSchema.safeParse({ action_id: "reset_demo_service", resource_id: "https://other.example.com", attempt_id: crypto.randomUUID() }).success, false);
});

function traceFixture() {
  const spans: Array<{ name: string; kind: string; attributes: Record<string, string | number | boolean> }> = [];
  let flushes = 0;
  const sdk = {
    async init() {},
    async trace<T>(options: { name: string; kind?: string; attributes?: Record<string, string | number | boolean> },
      callback: (span: { spanContext(): { traceId: string }; setAttribute(key: string, value: string | number | boolean): void;
        setStatus(status: { code: number }): void }) => Promise<T>): Promise<T> {
      const record = { name: options.name, kind: options.kind ?? "CHAIN", attributes: { ...options.attributes } };
      spans.push(record);
      return callback({ spanContext: () => ({ traceId: "b".repeat(32) }),
        setAttribute: (key, value) => { record.attributes[key] = value; },
        setStatus: () => {} });
    },
    async flush() { flushes++; return true; },
  } as unknown as Parameters<typeof createAgentTelemetry>[0];
  return { telemetry: createAgentTelemetry(sdk, () => "test-key"), spans,
    get flushes() { return flushes; } };
}

test("successful recovery trace links run, authorization, tool and verification", async () => {
  const f = fixture();
  const trace = traceFixture();
  const result = await runRecoveryGraph(f.ctx, f.worker, f.model, f.incidentId,
    f.authorizationId, f.runId, trace.telemetry);
  assert.equal(result.outcome, "recovered");
  assert.equal(f.run.neatlogs_trace_id, "b".repeat(32));
  assert.equal(trace.flushes, 1);
  assert.equal(trace.spans.filter((span) => span.name === "recovery.execute").length, 1);
  assert.equal(trace.spans.filter((span) => span.name === "recovery.verify").length, 1);
  assert.equal(trace.spans.find((span) => span.name === "recovery.authorize")?.attributes["siteguard.authorization_decision"], "allowed");
  assert.equal(trace.spans.find((span) => span.name === "recovery.verify")?.attributes["siteguard.verification_outcome"], "recovered");
  assert.equal(trace.spans.find((span) => span.name === "siteguard.agent_run")?.attributes["siteguard.final_outcome"], "recovered");
});

test("failed verification traces both bounded attempts and escalation", async () => {
  const f = fixture("no_effect");
  const trace = traceFixture();
  const result = await runRecoveryGraph(f.ctx, f.worker, f.model, f.incidentId,
    f.authorizationId, f.runId, trace.telemetry);
  assert.equal(result.outcome, "escalated");
  assert.equal(trace.spans.filter((span) => span.name === "recovery.execute").length, 2);
  assert.equal(trace.spans.filter((span) => span.name === "recovery.verify").length, 2);
  assert.equal(trace.spans.find((span) => span.name === "siteguard.agent_run")?.attributes["siteguard.final_outcome"], "escalated");
});

test("authorization denial trace contains no recovery execution span", async () => {
  const f = fixture();
  const trace = traceFixture();
  const result = await runRecoveryGraph(f.ctx, f.worker, f.model, f.incidentId,
    crypto.randomUUID(), f.runId, trace.telemetry);
  assert.equal(result.outcome, "escalated");
  assert.equal(trace.spans.filter((span) => span.name === "recovery.execute").length, 0);
  assert.equal(trace.spans.find((span) => span.name === "recovery.authorize")?.attributes["siteguard.authorization_decision"], "denied");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ApiContext } from "../src/lib/api/context";
import { runDiagnosis } from "../src/lib/agents/diagnosis-graph";
import type { DiagnosisModel } from "../src/lib/agents/model";
import type { HealthCheck, Incident, Website } from "../src/types/domain";

const ownerId = crypto.randomUUID();
const websiteId = crypto.randomUUID();
const incidentId = crypto.randomUUID();

function fixture(kind: "http_error" | "timeout", status: number | null, count = 3) {
  const website = {
    id: websiteId, owner_user_id: ownerId, deleted_at: null, name: "Fixture",
    url: "https://example.com/health", normalized_host: "example.com",
    monitor_interval_seconds: 300, failure_threshold: 2, recovery_threshold: 2,
    consecutive_failures: count, consecutive_successes: 0, is_enabled: true,
    next_check_at: new Date().toISOString(), last_checked_at: new Date().toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } satisfies Website & { deleted_at: null };
  const incident = {
    id: incidentId, website_id: websiteId, status: "open", failure_kind: kind,
    consecutive_failures: count, resolved_at: null,
  } as Incident;
  const checks = Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(), website_id: websiteId,
    checked_at: new Date(Date.now() - index * 300_000).toISOString(),
    status: "unhealthy", http_status: status, latency_ms: kind === "timeout" ? 8_000 : 110,
    failure_kind: kind, error_code: kind === "timeout" ? "MONITOR_TIMEOUT" : "HTTP_ERROR",
  })) as HealthCheck[];
  return { website, incident, checks };
}

function context(data: ReturnType<typeof fixture>, failHistory = false): ApiContext {
  const tables: Record<string, unknown[]> = {
    websites: [data.website], incidents: [data.incident], health_checks: data.checks,
  };
  const supabase = { from(table: string) {
    let rows = [...(tables[table] ?? [])] as Record<string, unknown>[];
    let failed = false;
    const query = {
      select() { return this; },
      eq(key: string, value: unknown) { rows = rows.filter((row) => row[key] === value); if (table === "incidents" && key === "website_id" && failHistory) failed = true; return this; },
      is(key: string, value: unknown) { rows = rows.filter((row) => row[key] === value); return this; },
      order() { return this; },
      limit(count: number) { rows = rows.slice(0, count); return this; },
      async maybeSingle() { return { data: rows[0] ?? null, error: failed ? { code: "TEST_FAILURE" } : null }; },
      then(resolve: (value: unknown) => void) { resolve({ data: rows, error: failed ? { code: "TEST_FAILURE" } : null }); },
    };
    return query;
  } } as unknown as ApiContext["supabase"];
  return { userId: ownerId, supabase };
}

function model(tool: "http_error_analysis" | "response_time_analysis" | "incident_history"): DiagnosisModel {
  return { async assess(input) {
    const ref = input.includes(`pattern:${tool === "http_error_analysis" ? "http" : "latency"}`)
      ? `pattern:${tool === "http_error_analysis" ? "http" : "latency"}`
      : `incident:${incidentId}`;
    return {
      observed_symptoms: ["Repeated failed checks"],
      probable_causes: [{ cause: "Possible application or upstream failure", evidence_refs: [ref] }],
      unknowns: ["Deployment and application logs are unavailable"],
      confidence: "medium", next_tool: tool,
    };
  } };
}

test("HTTP 500 diagnosis selects status analysis and returns advisory actions", async () => {
  const state = await runDiagnosis(context(fixture("http_error", 500)), incidentId, model("http_error_analysis"));
  assert.equal(state.executionStatus, "completed");
  assert.equal(state.diagnosis?.status, "conclusive");
  assert.equal(state.diagnosis?.probable_causes[0].evidence_refs[0], "pattern:http");
  assert.equal(state.diagnosis?.recommended_recovery_actions[0].action_id, "inspect_application_logs");
  assert.ok(state.selectedDiagnosticActions.includes("http_error_analysis"));
  assert.equal(state.modelCalls, 2);
});

test("timeout diagnosis selects response-time analysis without asserting a root cause as fact", async () => {
  const state = await runDiagnosis(context(fixture("timeout", null)), incidentId, model("response_time_analysis"));
  assert.ok(state.selectedDiagnosticActions.includes("response_time_analysis"));
  assert.equal(state.diagnosis?.supporting_evidence.some((item) => item.ref === "pattern:latency"), true);
  assert.equal(state.diagnosis?.recommended_recovery_actions[0].action_id, "inspect_application_logs");
  assert.match(state.diagnosis?.risk_assessment ?? "", /No recovery operation was executed/);
});

test("failed diagnostic tool records an error and tries a safe fallback", async () => {
  const state = await runDiagnosis(context(fixture("http_error", 500), true), incidentId, model("incident_history"));
  assert.ok(state.errorCodes.includes("TOOL_FAILED"));
  assert.ok(state.selectedDiagnosticActions.includes("incident_history"));
  assert.ok(state.selectedDiagnosticActions.includes("http_error_analysis"));
  assert.ok(state.diagnosis?.unknowns.includes("One or more diagnostic tools failed"));
  assert.ok(state.stepCount <= 15);
});

test("missing history produces an explicitly inconclusive result without calling the model", async () => {
  let called = false;
  const noModel: DiagnosisModel = { async assess() { called = true; throw new Error("Unexpected call"); } };
  const state = await runDiagnosis(context(fixture("http_error", 500, 0)), incidentId, noModel);
  assert.equal(called, false);
  assert.equal(state.diagnosis?.status, "inconclusive");
  assert.equal(state.diagnosis?.confidence, "low");
});

test("diagnosis refuses incidents whose website is not owned by the caller", async () => {
  const ctx = context(fixture("http_error", 500));
  ctx.userId = crypto.randomUUID();
  await assert.rejects(runDiagnosis(ctx, incidentId, model("http_error_analysis")),
    (error: unknown) => error instanceof Error && error.message === "Website not found");
});

test("invalid model output terminates with an inconclusive recommendation", async () => {
  const invalidModel = { async assess() { return { probable_causes: [{ cause: "unsupported", evidence_refs: ["invented"] }] }; } } as unknown as DiagnosisModel;
  const state = await runDiagnosis(context(fixture("http_error", 500)), incidentId, invalidModel);
  assert.equal(state.diagnosis?.status, "inconclusive");
  assert.equal(state.modelCalls, 2);
  assert.ok(state.errorCodes.includes("MODEL_FAILED"));
});

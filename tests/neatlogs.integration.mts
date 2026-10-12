// Optional authenticated Neatlogs check of the real diagnosis graph with synthetic inputs.
// It does not exercise Supabase persistence, the LiteLLM gateway, or recovery.
import assert from "node:assert/strict";
import { shutdown } from "neatlogs";
import type { ApiContext } from "../src/lib/api/context";
import type { DiagnosisModel } from "../src/lib/agents/model";
import { runDiagnosis } from "../src/lib/agents/diagnosis-graph";
import { agentTelemetry } from "../src/lib/observability/agent-telemetry";

if (!process.env.NEATLOGS_API_KEY) throw new Error("NEATLOGS_API_KEY is required");
const ownerId = crypto.randomUUID();
const websiteId = crypto.randomUUID();
const incidentId = crypto.randomUUID();
const runId = crypto.randomUUID();
const checkId = crypto.randomUUID();
const tables: Record<string, Record<string, unknown>[]> = {
  websites: [{ id: websiteId, owner_user_id: ownerId, deleted_at: null,
    monitor_interval_seconds: 300, failure_threshold: 2, recovery_threshold: 2,
    is_enabled: true }],
  incidents: [{ id: incidentId, website_id: websiteId, status: "open",
    failure_kind: "http_error", consecutive_failures: 2, resolved_at: null }],
  health_checks: [0, 1].map((index) => ({ id: index ? crypto.randomUUID() : checkId,
    website_id: websiteId, checked_at: new Date(Date.now() - index * 60_000).toISOString(),
    status: "unhealthy", http_status: 500, latency_ms: 20,
    failure_kind: "http_error", error_code: "HTTP_ERROR" })),
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
const model: DiagnosisModel = { async assess() {
  return { observed_symptoms: ["Repeated HTTP 500 checks"],
    probable_causes: [{ cause: "Possible service failure", evidence_refs: [`check:${checkId}`] }],
    unknowns: [], confidence: "medium", next_tool: "http_error_analysis" };
} };

let traceId: string | null = null;
try {
  const state = await agentTelemetry.run("diagnosis", { runId, incidentId },
    () => runDiagnosis(ctx, incidentId, model, runId),
    async (id) => { traceId = id; });
  assert.equal(state.diagnosis?.status, "conclusive");
  assert.ok(traceId, "SDK did not initialize and create a trace");
  console.log(JSON.stringify({ scenario: "synthetic_diagnosis_only", run_id: runId,
    trace_id: traceId, result: state.diagnosis.status }));
} finally {
  await shutdown();
}

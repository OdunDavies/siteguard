import assert from "node:assert/strict";
import test from "node:test";
import { activeGrant, canRunRecovery, dashboardCounts, latestDiagnosis } from "../src/lib/dashboard/view-model";
import type { DashboardSnapshot } from "../src/lib/dashboard/snapshot";

const websiteId = "76d6efef-9c99-4525-a165-22af42342f09";
const incidentId = "9f79f90a-980b-42be-ac2c-51bf67900067";
function fixture(): DashboardSnapshot {
  return {
    websites: [{ id: websiteId, owner_user_id: "owner", name: "Demo", url: "https://example.com", normalized_host: "example.com", monitor_interval_seconds: 300, failure_threshold: 2, recovery_threshold: 2, consecutive_failures: 2, consecutive_successes: 0, is_enabled: true, next_check_at: "2026-10-12T12:00:00Z", last_checked_at: "2026-10-12T11:00:00Z", created_at: "2026-10-12T10:00:00Z", updated_at: "2026-10-12T11:00:00Z" }],
    demos: [{ id: websiteId, state: "failed", reset_behavior: "normal" }],
    checks: [{ id: "check", website_id: websiteId, scheduled_for: "2026-10-12T11:00:00Z", checked_at: "2026-10-12T11:00:00Z", status: "unhealthy", http_status: 503, latency_ms: 42, failure_kind: "http_error", error_code: null, error_message: null, incident_id: incidentId }],
    incidents: [{ id: incidentId, website_id: websiteId, status: "open", started_at: "2026-10-12T11:00:00Z", resolved_at: null, failure_kind: "http_error", summary: null, consecutive_failures: 2, last_check_id: "check", created_at: "2026-10-12T11:00:00Z", updated_at: "2026-10-12T11:00:00Z" }],
    runs: [], grants: [], attempts: [], events: [], refreshedAt: "2026-10-12T11:00:00Z",
  };
}

test("dashboard uses actual latest check and incident rows for counts", () => {
  assert.deepEqual(dashboardCounts(fixture()), { total: 1, healthy: 0, unhealthy: 1, openIncidents: 1 });
});

test("recovery stays unavailable without an exact, active grant", () => {
  const data = fixture();
  assert.equal(canRunRecovery(data, websiteId, incidentId), false);
  data.grants.push({ id: "grant", website_id: websiteId, action_id: "reset_demo_service", resource_id: "other-resource", enabled: true, expires_at: "2026-10-12T12:00:00Z", max_uses: 1, uses_count: 0, revoked_at: null });
  assert.equal(canRunRecovery(data, websiteId, incidentId, Date.parse("2026-10-12T11:30:00Z")), false);
  data.grants[0].resource_id = websiteId;
  assert.equal(canRunRecovery(data, websiteId, incidentId, Date.parse("2026-10-12T11:30:00Z")), true);
  data.grants[0].uses_count = 1;
  assert.equal(activeGrant(data, websiteId, Date.parse("2026-10-12T11:30:00Z")), null);
  data.grants[0].uses_count = 0;
  assert.equal(activeGrant(data, websiteId, Date.parse("2026-10-12T12:00:00Z")), null);
  data.grants[0].revoked_at = "2026-10-12T11:20:00Z";
  assert.equal(activeGrant(data, websiteId, Date.parse("2026-10-12T11:30:00Z")), null);
});

test("only a persisted, schema-valid diagnosis is presented", () => {
  const data = fixture();
  data.runs.push({ id: "run", website_id: websiteId, incident_id: incidentId, status: "diagnosed", mode: "diagnosis", diagnosis_json: { confidence: "medium" }, neatlogs_trace_id: null, started_at: "2026-10-12T11:01:00Z", finished_at: null });
  assert.equal(latestDiagnosis(data, incidentId), null);
  data.runs[0].diagnosis_json = {
    agent_run_id: "fccf0ffc-f592-49c1-89ec-f655719437d2", incident_id: incidentId, website_id: websiteId,
    incident_summary: "HTTP error", observed_symptoms: ["HTTP 503"], probable_causes: [],
    supporting_evidence: [], unknowns: ["Cause unconfirmed"], confidence: "medium", status: "inconclusive",
    recommended_recovery_actions: [], risk_assessment: "Advisory", human_approval_required: true,
    diagnosed_at: "2026-10-12T11:03:00Z",
  };
  assert.equal(latestDiagnosis(data, incidentId)?.diagnosis.confidence, "medium");
  assert.equal(latestDiagnosis(data, "00000000-0000-4000-8000-000000000000"), null);
});

import { diagnosisSchema, type Diagnosis } from "@/lib/agents/diagnosis-schema";
import type { DashboardSnapshot, RecoveryGrant } from "./snapshot";

export function activeGrant(snapshot: DashboardSnapshot, websiteId: string, now = Date.now()): RecoveryGrant | null {
  return snapshot.grants.find((grant) => grant.website_id === websiteId &&
    grant.action_id === "reset_demo_service" && grant.resource_id === websiteId &&
    grant.enabled && !grant.revoked_at && Date.parse(grant.expires_at) > now &&
    grant.uses_count < grant.max_uses) ?? null;
}

export function latestDiagnosis(snapshot: DashboardSnapshot, incidentId: string): {
  runId: string; status: string; diagnosis: Diagnosis;
} | null {
  for (const run of snapshot.runs) {
    if (run.incident_id !== incidentId) continue;
    const parsed = diagnosisSchema.safeParse(run.diagnosis_json);
    if (parsed.success) return { runId: run.id, status: run.status, diagnosis: parsed.data };
  }
  return null;
}

export function dashboardCounts(snapshot: DashboardSnapshot) {
  const latest = new Map<string, string>();
  for (const check of snapshot.checks) if (!latest.has(check.website_id)) latest.set(check.website_id, check.status);
  return {
    total: snapshot.websites.length,
    healthy: snapshot.websites.filter((site) => latest.get(site.id) === "healthy").length,
    unhealthy: snapshot.websites.filter((site) => ["unhealthy", "error"].includes(latest.get(site.id) ?? "")).length,
    openIncidents: snapshot.incidents.filter((incident) => ["open", "recovering"].includes(incident.status)).length,
  };
}

export function canRunRecovery(snapshot: DashboardSnapshot, websiteId: string, incidentId: string, now = Date.now()) {
  const demo = snapshot.demos.find((row) => row.id === websiteId);
  const incident = snapshot.incidents.find((row) => row.id === incidentId && row.website_id === websiteId);
  return demo?.state === "failed" && incident?.status === "open" &&
    Boolean(activeGrant(snapshot, websiteId, now));
}

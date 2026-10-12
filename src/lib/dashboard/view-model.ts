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

export type DemoStage = "setup" | "healthy" | "failed" | "detected" | "investigating" | "fix_ready" | "approved" | "restoring" | "restored" | "escalated";

/** A presentation-only state derived from persisted records. */
export function demoStage(snapshot: DashboardSnapshot, websiteId: string, now = Date.parse(snapshot.refreshedAt)): DemoStage {
  const demo = snapshot.demos.find((item) => item.id === websiteId);
  if (!demo) return "setup";
  const incident = snapshot.incidents.find((item) => item.website_id === websiteId && ["open", "recovering"].includes(item.status))
    ?? snapshot.incidents.find((item) => item.website_id === websiteId);
  const run = incident && snapshot.runs.find((item) => item.incident_id === incident.id);
  const attempt = run && snapshot.attempts.find((item) => item.agent_run_id === run.id);
  const check = snapshot.checks.find((item) => item.website_id === websiteId);
  if (demo.state === "healthy") {
    if (incident?.status === "recovered" && attempt?.status === "succeeded" && attempt.verification_check_id &&
      snapshot.checks.some((item) => item.id === attempt.verification_check_id && item.status === "healthy")) return "restored";
    return "healthy";
  }
  if (incident?.status === "escalated" || run?.status === "escalated" || run?.status === "failed") return "escalated";
  if (incident?.status === "recovering" || (run?.mode === "recovery" && run.status === "running")) return "restoring";
  if (incident?.status !== "open") return "failed";
  if (activeGrant(snapshot, websiteId, now) && latestDiagnosis(snapshot, incident.id)) return "approved";
  if (latestDiagnosis(snapshot, incident.id)) return "fix_ready";
  if (run?.mode === "diagnosis" && run.status === "running") return "investigating";
  if (check?.status === "unhealthy" || check?.status === "error") return "detected";
  return "failed";
}

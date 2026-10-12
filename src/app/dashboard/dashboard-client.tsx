"use client";

import { useRef, useState } from "react";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";
import { activeGrant, canRunRecovery, dashboardCounts, latestDiagnosis } from "@/lib/dashboard/view-model";
import { SignOutButton } from "./sign-out-button";

type Action = "provision" | "fail" | "check" | "diagnose" | "authorize" | "recover" | "refresh";
const labels: Record<Action, string> = {
  provision: "Provisioning demo", fail: "Simulating failure", check: "Checking website",
  diagnose: "Running AI diagnosis", authorize: "Authorizing recovery", recover: "Running AI recovery",
  refresh: "Refreshing status",
};
const eventLabels: Record<string, string> = {
  "demo.failed": "Demo service failed", "incident.opened": "Incident opened",
  "incident.updated": "Incident updated", "incident.closed": "Incident resolved",
  "agent.started": "Agent run started", "diagnosis.recorded": "AI diagnosis recorded",
  "agent.failed": "Agent run failed", "recovery.granted": "Recovery authorized",
  "recovery.revoked": "Authorization revoked", "recovery.authorized": "Recovery attempt authorized",
  "recovery.executed": "Recovery action executed", "recovery.verified": "Recovery verified",
  "recovery.escalated": "Recovery escalated", "recovery.unknown": "Recovery outcome uncertain",
};
const time = (value?: string | null) => value ? new Date(value).toLocaleString() : "Not yet";
const shortId = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "good" | "bad" | "warn" | "neutral" }) {
  const color = { good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", bad: "border-rose-500/30 bg-rose-500/10 text-rose-300", warn: "border-amber-500/30 bg-amber-500/10 text-amber-300", neutral: "border-slate-600 bg-slate-800 text-slate-300" }[tone];
  return <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${color}`}>{children}</span>;
}
function Button({ children, onClick, disabled, variant = "secondary" }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; variant?: "primary" | "secondary" | "danger" }) {
  const color = { primary: "border-emerald-300 bg-emerald-300 text-slate-950 hover:bg-emerald-200", secondary: "border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700", danger: "border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20" }[variant];
  return <button type="button" disabled={disabled} onClick={onClick} className={`min-h-11 cursor-pointer rounded-xl border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-45 ${color}`}>{children}</button>;
}
function Panel({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-slate-700/70 bg-slate-900/80 p-5 shadow-xl shadow-black/10 sm:p-6"><p className="text-xs font-bold uppercase tracking-[.2em] text-emerald-400">{eyebrow}</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-white">{title}</h2><div className="mt-5">{children}</div></section>;
}
async function api(path: string, method: "GET" | "POST", body?: object) {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `Request failed (HTTP ${response.status})`);
  return payload.data;
}

export function DashboardClient({ initialSnapshot, email }: { initialSnapshot: DashboardSnapshot; email: string }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [busy, setBusy] = useState<Action | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const counts = dashboardCounts(snapshot);
  const snapshotTime = Date.parse(snapshot.refreshedAt);
  const demo = snapshot.demos[0];
  const website = snapshot.websites.find((site) => site.id === demo?.id) ?? snapshot.websites[0];
  const check = snapshot.checks.find((item) => item.website_id === website?.id);
  const incident = snapshot.incidents.find((item) => item.website_id === website?.id && ["open", "recovering"].includes(item.status)) ?? snapshot.incidents.find((item) => item.website_id === website?.id);
  const diagnosis = incident ? latestDiagnosis(snapshot, incident.id) : null;
  const grant = website ? activeGrant(snapshot, website.id, snapshotTime) : null;
  const run = snapshot.runs.find((item) => item.website_id === website?.id);
  const attempt = run && snapshot.attempts.find((item) => item.agent_run_id === run.id);
  const canRecover = website && incident ? canRunRecovery(snapshot, website.id, incident.id, snapshotTime) : false;
  const refresh = async () => setSnapshot(await api("/api/dashboard/overview", "GET") as DashboardSnapshot);

  async function act(action: Action) {
    if (inFlight.current) return;
    if (action === "authorize" && !window.confirm("Authorize one reset_demo_service use on this demo for 15 minutes? This does not execute recovery.")) return;
    if (action === "recover" && !window.confirm("Run AI recovery on this controlled demo now?")) return;
    inFlight.current = true; setBusy(action); setError(null); setNotice(null);
    try {
      if (action === "provision") await api("/api/demo/services", "POST", {});
      if (action === "fail" && demo) await api(`/api/demo/services/${demo.id}/fail`, "POST", { reset_behavior: "normal" });
      if (action === "check" && website) await api(`/api/websites/${website.id}/check`, "POST");
      if (action === "diagnose" && incident) await api(`/api/incidents/${incident.id}/diagnose`, "POST", { idempotency_key: crypto.randomUUID() });
      if (action === "authorize" && demo) await api(`/api/demo/services/${demo.id}/authorizations`, "POST", { expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), max_uses: 1 });
      let recoveryOutcome: string | null = null;
      let verifiedHttpStatus: number | null = null;
      if (action === "recover" && incident && grant && demo) {
        const result = await api(`/api/incidents/${incident.id}/recover`, "POST", { authorization_id: grant.id, idempotency_key: crypto.randomUUID() }) as { outcome: string };
        recoveryOutcome = result.outcome;
        const health = await fetch(`/api/demo/health/${demo.id}`, { cache: "no-store" });
        verifiedHttpStatus = health.status;
      }
      await refresh(); setNotice(action === "refresh" ? "Live status refreshed." : recoveryOutcome ? `Recovery outcome: ${recoveryOutcome}. Public demo health: HTTP ${verifiedHttpStatus}.` : `${labels[action]} completed. Live records refreshed.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Operation failed."); try { await refresh(); } catch { /* Keep the original error. */ } }
    finally { inFlight.current = false; setBusy(null); }
  }

  const timeline = [
    ...snapshot.events.filter((item) => !website || item.website_id === website.id).map((item) => ({ id: item.id, at: item.occurred_at, title: eventLabels[item.event_type] ?? item.event_type, detail: item.reason_code ?? item.decision ?? "Recorded event" })),
    ...snapshot.checks.filter((item) => !website || item.website_id === website.id).map((item) => ({ id: item.id, at: item.checked_at, title: "Website checked", detail: item.http_status ? `HTTP ${item.http_status} · ${item.status}` : `${item.status} · ${item.failure_kind ?? "no response"}` })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 20);

  return <div className="min-h-screen bg-[#090e19] text-slate-100"><div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_10%_0%,rgba(16,185,129,.12),transparent_40%),radial-gradient(ellipse_at_90%_10%,rgba(56,189,248,.07),transparent_35%)]" /><div className="relative mx-auto max-w-7xl px-4 pb-16 pt-5 sm:px-7 lg:px-10">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5"><div className="flex items-center gap-3"><div className="flex size-10 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-400/10 text-emerald-300" aria-hidden="true">✦</div><div><p className="text-lg font-bold">SiteGuard</p><p className="text-xs text-slate-400">Autonomous reliability control center</p></div></div><div className="flex flex-wrap items-center gap-3"><span className="max-w-48 truncate text-xs text-slate-400">{email}</span><Button disabled={!!busy} onClick={() => act("refresh")}>Refresh status</Button><SignOutButton /></div></header>
    <div className="mb-8 mt-9 flex flex-wrap items-end justify-between gap-5"><div><p className="text-xs font-bold uppercase tracking-[.25em] text-emerald-400">Operations overview</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Website command center</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">Monitor the controlled service, inspect incident evidence, and explicitly approve recovery.</p></div><div className="text-xs text-slate-500">Updated {time(snapshot.refreshedAt)}<br />Data from your Supabase records</div></div>
    {busy && <div role="status" aria-live="polite" className="mb-5 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">{labels[busy]}…</div>}{error && <div role="alert" className="mb-5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}{notice && <div role="status" className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{notice}</div>}
    <section aria-label="Overview metrics" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Monitored websites", counts.total], ["Healthy websites", counts.healthy], ["Unhealthy websites", counts.unhealthy], ["Open incidents", counts.openIncidents]].map(([title, value]) => <div key={title} className="rounded-2xl border border-slate-700/70 bg-slate-900/80 p-5"><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</p><p className="mt-3 text-3xl font-semibold tabular-nums">{value}</p></div>)}</section>
    <div className="mt-6 grid gap-5 lg:grid-cols-[1.25fr_.75fr]"><div className="space-y-5">
      <Panel eyebrow="Website status" title={website?.name ?? "No controlled demo yet"}>{website ? <><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><a className="break-all text-sm text-sky-300 underline decoration-sky-400/30 underline-offset-4 hover:text-sky-200" href={website.url} target="_blank" rel="noreferrer">{website.url}</a><p className="mt-2 font-mono text-xs text-slate-500">{website.id}</p></div><Badge tone={demo?.state === "failed" || check?.status === "unhealthy" ? "bad" : demo?.state === "healthy" || check?.status === "healthy" ? "good" : "neutral"}>{demo?.state ?? check?.status ?? "Not checked"}</Badge></div><dl className="mt-6 grid gap-4 border-t border-slate-800 pt-5 text-sm sm:grid-cols-2 xl:grid-cols-4"><div><dt className="text-slate-500">Last HTTP</dt><dd>{check?.http_status ?? "—"}</dd></div><div><dt className="text-slate-500">Response time</dt><dd>{check?.latency_ms == null ? "—" : `${check.latency_ms} ms`}</dd></div><div><dt className="text-slate-500">Last checked</dt><dd>{time(check?.checked_at)}</dd></div><div><dt className="text-slate-500">Failure streak</dt><dd>{website.consecutive_failures}</dd></div></dl></> : <p className="text-sm text-slate-400">Provision a controlled demo service to begin.</p>}<div className="mt-6 flex flex-wrap gap-2">{!demo && <Button variant="primary" disabled={!!busy} onClick={() => act("provision")}>Provision demo</Button>}{demo?.state === "healthy" && <Button variant="danger" disabled={!!busy} onClick={() => act("fail")}>Simulate failure</Button>}{website && <Button disabled={!!busy} onClick={() => act("check")}>Check website</Button>}</div><p className="mt-3 text-xs text-slate-500">Manual checks respect the server’s 30-second cooldown and lease.</p></Panel>
      <Panel eyebrow="Detection & diagnosis" title="Incident intelligence">{incident ? <><div className="flex flex-wrap items-center gap-3"><Badge tone={["open", "recovering"].includes(incident.status) ? "bad" : ["recovered", "closed"].includes(incident.status) ? "good" : "warn"}>{incident.status}</Badge><span className="font-mono text-xs text-slate-400" title={incident.id}>{shortId(incident.id)}</span></div><dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">Opened</dt><dd>{time(incident.started_at)}</dd></div><div><dt className="text-slate-500">Linked check</dt><dd className="font-mono text-xs" title={incident.last_check_id ?? ""}>{incident.last_check_id ? shortId(incident.last_check_id) : "—"}</dd></div><div><dt className="text-slate-500">Failure category</dt><dd>{incident.failure_kind ?? "Unknown"}</dd></div><div><dt className="text-slate-500">Consecutive failures</dt><dd>{incident.consecutive_failures}</dd></div></dl><div className="mt-6 border-t border-slate-800 pt-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">AI diagnosis</h3>{diagnosis && <Badge tone="warn">{diagnosis.diagnosis.confidence} confidence</Badge>}</div>{diagnosis ? <><p className="mt-3 text-sm text-slate-200">{diagnosis.diagnosis.incident_summary}</p><p className="mt-2 text-xs text-slate-400">Run {shortId(diagnosis.runId)} · {diagnosis.status} · root cause unconfirmed</p><ul className="mt-4 space-y-2 text-sm text-slate-300">{diagnosis.diagnosis.probable_causes.map((cause, index) => <li key={index} className="rounded-lg bg-slate-800/70 p-3">{cause.cause}</li>)}</ul><p className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-500">Supporting evidence</p><ul className="mt-2 space-y-2 text-xs text-slate-400">{diagnosis.diagnosis.supporting_evidence.filter((item) => !item.observation.includes("connection_error")).slice(0, 4).map((item) => <li key={item.ref}><span className="font-mono text-emerald-300">{item.ref}</span> · {item.observation}</li>)}</ul><p className="mt-4 text-xs text-amber-200">A prior connection error may reflect the corrected monitoring transport bug; it does not independently establish a network outage.</p><p className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-500">Recommended next steps</p><ul className="mt-2 space-y-1 text-sm text-slate-300">{diagnosis.diagnosis.recommended_recovery_actions.map((item) => <li key={item.action_id}>• {item.action_id.replaceAll("_", " ")}</li>)}</ul></> : <p className="mt-3 text-sm text-slate-400">No persisted diagnosis for this incident.</p>}{incident.status === "open" && !diagnosis && <div className="mt-5"><Button variant="primary" disabled={!!busy} onClick={() => act("diagnose")}>Run AI diagnosis</Button></div>}</div></> : <p className="text-sm text-slate-400">No incident recorded. Real monitoring checks must reach the failure threshold.</p>}</Panel>
    </div><div className="space-y-5"><Panel eyebrow="Owner approval required" title="Controlled recovery"><div className="rounded-xl border border-slate-700 bg-slate-950/70 p-4"><p className="text-xs text-slate-500">Allowlisted action</p><p className="mt-1 font-mono text-sm text-emerald-300">reset_demo_service</p><p className="mt-2 text-xs text-slate-400">Resource: {demo ? shortId(demo.id) : "No demo service"}</p></div><div className="mt-5 flex items-center justify-between gap-3"><span className="text-sm text-slate-400">Authorization</span><Badge tone={grant ? "good" : "neutral"}>{grant ? "Active" : "Not active"}</Badge></div>{grant && <p className="mt-2 text-xs text-slate-400">Expires {time(grant.expires_at)} · {grant.max_uses - grant.uses_count} use remaining</p>}<div className="mt-5 flex flex-wrap gap-2">{demo?.state === "failed" && incident?.status === "open" && diagnosis && !grant && <Button variant="primary" disabled={!!busy} onClick={() => act("authorize")}>Authorize recovery</Button>}{canRecover && <Button variant="danger" disabled={!!busy} onClick={() => act("recover")}>Run AI recovery</Button>}</div>{!canRecover && <p className="mt-3 text-xs leading-5 text-slate-500">Recovery requires a failed controlled demo, an open incident, and a current owner-approved grant. Authorization never triggers execution.</p>}<div className="mt-6 border-t border-slate-800 pt-5"><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Latest recovery result</p>{run?.mode === "recovery" ? <><p className="mt-2 text-sm">Run {shortId(run.id)} · {run.status}</p>{attempt && <p className="mt-1 text-xs text-slate-400">Attempt {shortId(attempt.id)} · {attempt.status} · {attempt.result_code ?? "Pending"}</p>}{attempt?.verification_check_id && <p className="mt-1 text-xs text-emerald-300">Verification check {shortId(attempt.verification_check_id)}</p>}</> : <p className="mt-2 text-sm text-slate-400">No recovery run yet.</p>}</div></Panel>
      <Panel eyebrow="Recorded events" title="Activity timeline">{timeline.length ? <ol>{timeline.map((item) => <li key={item.id} className="relative border-l border-slate-700 pb-5 pl-5 last:pb-0"><span className="absolute -left-1 top-1 size-2 rounded-full bg-emerald-400" /><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-xs text-slate-500">{item.detail}</p><time dateTime={item.at} className="mt-1 block text-xs text-slate-500">{time(item.at)}</time></li>)}</ol> : <p className="text-sm text-slate-400">No recorded activity yet.</p>}</Panel>
    </div></div><footer className="mt-10 border-t border-slate-800 pt-5 text-xs text-slate-500">SiteGuard · Controlled demo operations only · Actions use your authenticated session</footer>
  </div></div>;
}

"use client";

import { useRef, useState } from "react";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";
import { activeGrant, canRunRecovery, demoStage, latestDiagnosis } from "@/lib/dashboard/view-model";
import { SignOutButton } from "./sign-out-button";

type Action = "provision" | "fail" | "check" | "diagnose" | "authorize" | "recover" | "refresh";
const steps = ["Website healthy", "Problem detected", "Investigating", "Fix ready", "Your approval", "Website restored"];
const stages = {
  setup: ["GET STARTED", "Let's look after your website.", "Create a safe demo website to see SiteGuard in action.", -1, "slate"],
  healthy: ["ONLINE", "Your website is looking good.", "SiteGuard is ready to spot a problem and help you through it.", 0, "emerald"],
  failed: ["NEEDS ATTENTION", "We've spotted a problem.", "The demo website isn't responding normally. Check it to record what happened.", 1, "rose"],
  detected: ["PROBLEM FOUND", "SiteGuard found a problem.", "Failed checks were recorded. SiteGuard can now investigate.", 1, "rose"],
  investigating: ["INVESTIGATING", "SiteGuard is on it.", "We're reviewing recent checks to understand the problem.", 2, "amber"],
  fix_ready: ["FIX READY TO REVIEW", "We've found a possible next step.", "Review what SiteGuard found before deciding whether to allow a fix.", 3, "amber"],
  approved: ["APPROVED", "Your approval is recorded.", "The demo reset is allowed once. You can start the fix when you're ready.", 4, "amber"],
  restoring: ["RESTORING", "We're checking the fix.", "SiteGuard is applying the approved action and verifying the result.", 4, "amber"],
  restored: ["BACK ONLINE", "Your website is back online.", "The approved fix was applied and a fresh check confirmed recovery.", 5, "emerald"],
  escalated: ["NEEDS YOUR HELP", "The fix wasn't confirmed.", "SiteGuard stopped safely. Review the activity before trying again.", 4, "rose"],
} as const;
const tone = { slate: "border-slate-600 bg-slate-800 text-slate-200", emerald: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200", rose: "border-rose-400/40 bg-rose-400/10 text-rose-200", amber: "border-amber-400/40 bg-amber-400/10 text-amber-200" };
const events: Record<string, string> = {
  "demo.failed": "A demo problem was simulated", "incident.opened": "SiteGuard found a problem",
  "incident.updated": "The problem is still being tracked", "incident.closed": "The problem was closed",
  "agent.started": "SiteGuard started investigating", "diagnosis.recorded": "Investigation completed",
  "agent.failed": "The investigation could not finish", "recovery.granted": "You approved a fix",
  "recovery.revoked": "Approval was withdrawn", "recovery.authorized": "The fix was cleared to run",
  "recovery.executed": "The fix was applied", "recovery.verified": "The website was checked after the fix",
  "recovery.escalated": "SiteGuard needs your help", "recovery.unknown": "The result could not be confirmed",
};
const waiting: Record<Action, string> = { provision: "Setting up your demo website", fail: "Simulating a problem", check: "Checking your website", diagnose: "SiteGuard is investigating", authorize: "Recording your approval", recover: "Applying and checking the fix", refresh: "Getting the latest status" };
const time = (value?: string | null) => value ? new Date(value).toLocaleString() : "Not yet";
const approvalExpiry = () => new Date(Date.now() + 15 * 60_000).toISOString();

function Button({ children, onClick, disabled, secondary = false }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; secondary?: boolean }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={`min-h-11 rounded-xl px-5 py-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 ${secondary ? "border border-slate-600 bg-slate-800 text-white hover:bg-slate-700" : "bg-emerald-300 text-slate-950 hover:bg-emerald-200"}`}>{children}</button>;
}
async function api(path: string, method: "GET" | "POST", body?: object) {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? "That didn't work. Please refresh and try again.");
  return payload.data;
}

export function GuidedDemo({ initialSnapshot, email }: { initialSnapshot: DashboardSnapshot; email: string }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<"approval" | "execution" | null>(null);
  const inFlight = useRef(false);
  const demo = snapshot.demos[0];
  const website = snapshot.websites.find((item) => item.id === demo?.id);
  const check = snapshot.checks.find((item) => item.website_id === website?.id);
  const incident = snapshot.incidents.find((item) => item.website_id === website?.id && ["open", "recovering"].includes(item.status)) ?? snapshot.incidents.find((item) => item.website_id === website?.id);
  const diagnosis = incident ? latestDiagnosis(snapshot, incident.id) : null;
  const grant = website ? activeGrant(snapshot, website.id, Date.parse(snapshot.refreshedAt)) : null;
  const run = incident && snapshot.runs.find((item) => item.incident_id === incident.id);
  const attempt = run && snapshot.attempts.find((item) => item.agent_run_id === run.id);
  const stage = website ? demoStage(snapshot, website.id) : "setup";
  const [label, title, description, step, color] = stages[stage];
  const canApprove = demo?.state === "failed" && incident?.status === "open" && !!diagnosis && !grant;
  const canRecover = website && incident ? canRunRecovery(snapshot, website.id, incident.id, Date.parse(snapshot.refreshedAt)) : false;
  const needsCheck = demo?.state === "failed" && incident?.status !== "open";
  async function refresh() { setSnapshot(await api("/api/dashboard/overview", "GET") as DashboardSnapshot); }
  async function act(action: Action) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(action); setError(null); setNotice(null);
    try {
      if (action === "provision") await api("/api/demo/services", "POST", {});
      if (action === "fail" && demo) await api(`/api/demo/services/${demo.id}/fail`, "POST", { reset_behavior: "normal" });
      if (action === "check" && website) await api(`/api/websites/${website.id}/check`, "POST");
      if (action === "diagnose" && incident) await api(`/api/incidents/${incident.id}/diagnose`, "POST", { idempotency_key: crypto.randomUUID() });
      if (action === "authorize" && demo && canApprove) await api(`/api/demo/services/${demo.id}/authorizations`, "POST", { expires_at: approvalExpiry(), max_uses: 1 });
      if (action === "recover" && incident && grant && canRecover) await api(`/api/incidents/${incident.id}/recover`, "POST", { authorization_id: grant.id, idempotency_key: crypto.randomUUID() });
      await refresh();
      setReview(null);
      setNotice(action === "authorize" ? "Your one-use approval is recorded. The fix has not run yet." : action === "recover" ? "The latest recovery result is shown below." : action === "check" ? "Check complete. The latest result is shown below." : action === "diagnose" ? "Investigation complete. Review the findings below." : action === "fail" ? "A controlled problem is active. Check the website to detect it." : action === "provision" ? "Your demo website is ready." : "Status updated from your records.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again.");
      try { await refresh(); } catch { /* Keep the original error visible. */ }
    } finally { inFlight.current = false; setBusy(null); }
  }
  return <div className="min-h-screen bg-[#0b1013] text-slate-100"><div className="mx-auto max-w-6xl px-4 pb-12 sm:px-6 lg:px-8">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 py-5"><div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-emerald-300 text-xl font-black text-slate-950" aria-hidden="true">S</span><div><p className="text-lg font-bold tracking-tight">SiteGuard</p><p className="text-xs text-slate-400">Looking after your website</p></div></div><div className="flex flex-wrap items-center gap-3"><span className="max-w-44 truncate text-xs text-slate-400">{email}</span><button type="button" disabled={!!busy} onClick={() => act("refresh")} className="min-h-11 px-2 text-sm text-slate-300 underline-offset-4 hover:underline disabled:opacity-50">Refresh</button><SignOutButton /></div></header>
    <div className="grid gap-6 pt-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,.8fr)]"><div className="space-y-6">
      <section aria-labelledby="health-heading" className={`rounded-3xl border bg-[#141c20] p-7 shadow-xl shadow-black/20 sm:p-9 ${color === "emerald" ? "border-emerald-400/35" : color === "rose" ? "border-rose-400/35" : color === "amber" ? "border-amber-400/35" : "border-slate-700"}`}>
        <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold tracking-[.14em] ${tone[color]}`}>{label}</span><h1 id="health-heading" className="mt-6 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{title}</h1><p className="mt-3 max-w-xl text-base leading-7 text-slate-300">{description}</p>
        {website && <div className="mt-7 flex flex-wrap gap-x-8 gap-y-3 border-t border-white/10 pt-5 text-sm"><div><span className="text-slate-400">Website</span><p className="font-semibold">{website.name}</p></div><div><span className="text-slate-400">Last checked</span><p className="font-semibold">{time(check?.checked_at)}</p></div></div>}
        <div className="mt-7 flex flex-wrap gap-3">{stage === "setup" && <Button disabled={!!busy} onClick={() => act("provision")}>Create demo website</Button>}{(stage === "healthy" || stage === "restored") && <Button disabled={!!busy} onClick={() => act("fail")}>{stage === "restored" ? "Try another demo" : "Simulate a problem"}</Button>}{needsCheck && <Button disabled={!!busy} onClick={() => act("check")}>Check website</Button>}{stage === "detected" && <Button disabled={!!busy} onClick={() => act("diagnose")}>Investigate</Button>}{stage === "fix_ready" && <Button disabled={!!busy} onClick={() => setReview("approval")}>Review suggested fix</Button>}{stage === "approved" && <Button disabled={!!busy || !canRecover} onClick={() => setReview("execution")}>Apply approved fix</Button>}</div>
        {needsCheck && website && <p className="mt-3 text-sm text-slate-400">{Math.max(1, website.failure_threshold - website.consecutive_failures)} more failed check(s) needed to open a problem. Checks have a short cooldown.</p>}
      </section>
      {(busy || error || notice) && <div role={error ? "alert" : "status"} aria-live="polite" className={`rounded-xl border p-4 text-sm ${tone[error ? "rose" : busy ? "amber" : "emerald"]}`}>{error ?? (busy ? `${waiting[busy]}…` : notice)}</div>}
      <section aria-labelledby="findings-heading" className="rounded-3xl border border-white/10 bg-[#141c20] p-6 sm:p-7"><p className="text-xs font-bold tracking-[.18em] text-emerald-300">THE INVESTIGATION</p><h2 id="findings-heading" className="mt-2 text-2xl font-semibold">SiteGuard&apos;s findings</h2>
        {diagnosis ? <div className="mt-5 grid gap-5 text-sm leading-6 sm:grid-cols-2"><div><h3 className="font-semibold">What happened</h3><p className="mt-1 text-slate-300">{diagnosis.diagnosis.incident_summary}</p></div><div><h3 className="font-semibold">Why it might have happened</h3><p className="mt-1 text-slate-300">{diagnosis.diagnosis.probable_causes[0]?.cause ?? "We couldn't confirm the exact cause from the available checks."}</p></div><div><h3 className="font-semibold">What we can do</h3><p className="mt-1 text-slate-300">{diagnosis.diagnosis.recommended_recovery_actions.some((item) => item.action_id === "request_controlled_reset_approval") ? "With your approval, SiteGuard can try resetting this demo service." : "Review the suggested next steps before taking action."}</p></div><div><h3 className="font-semibold">What happens next</h3><p className="mt-1 text-slate-300">{diagnosis.diagnosis.status === "inconclusive" ? "The exact cause is still uncertain. Any reset needs your approval and a follow-up check." : "You can review the suggested fix and decide whether to approve it."}</p></div><p className="text-xs text-amber-200 sm:col-span-2">{diagnosis.diagnosis.confidence} confidence · {diagnosis.diagnosis.status === "inconclusive" ? "Cause unconfirmed" : "Based on recorded checks"}</p></div> : <p className="mt-4 text-sm text-slate-400">{incident?.status === "open" ? "A problem was recorded. Choose Investigate to review the evidence." : "When SiteGuard detects a problem, its findings will appear here."}</p>}
        {diagnosis && <details className="mt-5 border-t border-white/10 pt-4 text-sm text-slate-300"><summary className="cursor-pointer font-medium text-emerald-300">View investigation details</summary><p className="mt-3">Still unknown: {diagnosis.diagnosis.unknowns.join("; ") || "None recorded"}</p><ul className="mt-2 list-inside list-disc">{diagnosis.diagnosis.supporting_evidence.map((item) => <li key={item.ref}>{item.observation}</li>)}</ul><p className="mt-2">Risk: {diagnosis.diagnosis.risk_assessment}</p></details>}
      </section>
    </div><div className="space-y-6">
      <section aria-labelledby="journey-heading" className="rounded-3xl border border-white/10 bg-[#141c20] p-6 sm:p-7"><p className="text-xs font-bold tracking-[.18em] text-emerald-300">A GUIDED DEMO</p><h2 id="journey-heading" className="mt-2 text-2xl font-semibold">See SiteGuard in action</h2><p className="mt-2 text-sm leading-6 text-slate-400">Watch how SiteGuard spots a problem, investigates it, and fixes it with your approval.</p><ol className="mt-5 space-y-1">{steps.map((name, index) => { const done = stage === "restored" || (step > index && stage !== "escalated"); const current = step === index && stage !== "escalated" && stage !== "failed"; return <li key={name} aria-current={current ? "step" : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${current ? "bg-emerald-300/10 font-semibold text-emerald-200" : done ? "text-slate-200" : "text-slate-500"}`}><span aria-hidden="true" className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs ${done ? "border-emerald-400 text-emerald-200" : current ? "border-emerald-300" : "border-slate-700"}`}>{done ? "✓" : index + 1}</span>{name}</li>; })}</ol><p className="mt-4 text-xs text-slate-500">Progress follows recorded results, not a timer.</p></section>
      {(canApprove || grant || review || stage === "restoring" || stage === "escalated") && <section aria-labelledby="approval-heading" className="rounded-3xl border border-amber-400/25 bg-[#1a1c1b] p-6 sm:p-7"><p className="text-xs font-bold tracking-[.18em] text-amber-300">YOUR DECISION</p><h2 id="approval-heading" className="mt-2 text-xl font-semibold">SiteGuard can try to fix this.</h2><p className="mt-2 text-sm leading-6 text-slate-300">The available fix resets only this controlled demo service. It may briefly interrupt the demo. SiteGuard checks the result afterward.</p>{website && <p className="mt-3 text-sm text-slate-400">Affected website: <strong className="text-white">{website.name}</strong></p>}{grant && <p className="mt-3 text-sm text-emerald-300">{grant.max_uses - grant.uses_count} approved use(s) remaining until {time(grant.expires_at)}.</p>}
        {review === "approval" && canApprove && <div className="mt-5 rounded-xl border border-amber-400/30 p-4"><p className="text-sm font-semibold">Approve one reset of this demo service?</p><p className="mt-1 text-xs text-slate-300">Approval expires in 15 minutes and does not start the fix.</p><div className="mt-4 flex flex-wrap gap-2"><Button disabled={!!busy} onClick={() => act("authorize")}>Approve this fix</Button><Button secondary disabled={!!busy} onClick={() => setReview(null)}>Not now</Button></div></div>}
        {review === "execution" && canRecover && <div className="mt-5 rounded-xl border border-amber-400/30 p-4"><p className="text-sm font-semibold">Apply the approved fix now?</p><p className="mt-1 text-xs text-slate-300">SiteGuard will use your approval and check the service afterward.</p><div className="mt-4 flex flex-wrap gap-2"><Button disabled={!!busy} onClick={() => act("recover")}>Apply fix now</Button><Button secondary disabled={!!busy} onClick={() => setReview(null)}>Not now</Button></div></div>}
        {!review && canApprove && <div className="mt-5"><Button disabled={!!busy} onClick={() => setReview("approval")}>Review approval</Button></div>}{!review && canRecover && <div className="mt-5"><Button disabled={!!busy} onClick={() => setReview("execution")}>Apply approved fix</Button></div>}
        {attempt && <p className="mt-4 text-sm text-slate-300">Latest attempt: {attempt.status}. {attempt.verification_check_id ? "A follow-up check was recorded." : "No follow-up check is recorded yet."}</p>}
      </section>}
      <section aria-labelledby="activity-heading" className="rounded-3xl border border-white/10 bg-[#141c20] p-6 sm:p-7"><h2 id="activity-heading" className="text-xl font-semibold">What happened so far</h2>{snapshot.events.some((item) => item.website_id === website?.id) ? <ol className="mt-4 space-y-4">{snapshot.events.filter((item) => item.website_id === website?.id).slice(0, 5).map((item) => <li key={item.id} className="border-l-2 border-emerald-400/40 pl-4"><p className="text-sm font-medium">{events[item.event_type] ?? "Activity recorded"}</p><time dateTime={item.occurred_at} className="text-xs text-slate-400">{time(item.occurred_at)}</time></li>)}</ol> : <p className="mt-3 text-sm text-slate-400">No activity recorded yet.</p>}</section>
    </div></div>
    <details className="mt-6 rounded-2xl border border-white/10 bg-[#141c20] p-5 text-sm text-slate-300"><summary className="cursor-pointer font-semibold text-white">Technical information</summary><dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><div><dt>Website URL</dt><dd className="break-all">{website?.url ?? "Not set up"}</dd></div><div><dt>HTTP status</dt><dd>{check?.http_status ?? "Not checked"}</dd></div><div><dt>Response time</dt><dd>{check?.latency_ms == null ? "Not recorded" : `${check.latency_ms} ms`}</dd></div><div><dt>Failure category</dt><dd>{check?.failure_kind ?? "Not recorded"}</dd></div><div><dt>Incident ID</dt><dd className="break-all font-mono text-xs">{incident?.id ?? "None"}</dd></div><div><dt>Agent run ID</dt><dd className="break-all font-mono text-xs">{run?.id ?? diagnosis?.runId ?? "None"}</dd></div><div><dt>Attempt ID</dt><dd className="break-all font-mono text-xs">{attempt?.id ?? "None"}</dd></div><div><dt>Neatlogs trace ID</dt><dd className="break-all font-mono text-xs">{run?.neatlogs_trace_id ?? "None"}</dd></div><div><dt>Last check</dt><dd>{time(check?.checked_at)}</dd></div></dl></details>
    <footer className="py-7 text-xs text-slate-500">SiteGuard · Controlled demo · Actions use your signed-in session</footer>
  </div></div>;
}

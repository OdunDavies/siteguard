# SiteGuard — three-minute live demonstration

Use the authenticated `/dashboard` on the deployed SiteGuard origin. All transitions shown must come from live SiteGuard records. Before recording, complete the readiness checklist and begin with the controlled demo healthy. The current documented fixture is failed, so it needs an explicitly approved controlled recovery before recording a new healthy-to-failed cycle.

## 0:00–0:30 — Problem

“A website failure often means three separate jobs: notice it, work out what the evidence supports, and recover safely. SiteGuard connects those jobs while keeping the operator in control of recovery.” Show the overview metrics and the monitored website URL.

## 0:30–1:00 — Control center

Show the live website status, last HTTP response, response time, and recent activity. Explain that the controlled service state lives in Supabase and the health URL is a real HTTPS endpoint. Refresh the dashboard to show current records.

## 1:00–1:30 — Failure detection

Click **Simulate failure** on the healthy demo, then **Check website**. The endpoint should return HTTP 503. Respect the 30-second manual-check cooldown before a second check if the failure threshold is two. Point out the new open incident and its linked check; do not claim an incident before it appears.

## 1:30–2:00 — AI diagnosis

Click **Run AI diagnosis**. Show the persisted run, confidence, supporting HTTP evidence, and advisory next steps. Say: “The model suggests possible causes. It does not confirm the root cause. An older connection error may be from the monitoring transport defect and is not independent proof of a network outage.”

## 2:00–2:30 — Owner-authorized recovery

Point to the exact `reset_demo_service` action and resource. Click **Authorize recovery** and confirm the one-use, 15-minute grant. Explain that this does not execute recovery. Then click **Run AI recovery** and confirm execution. The existing LangGraph workflow checks the grant again before the allowlisted reset.

## 2:30–3:00 — Verification and close

Show the recovery run, attempt, linked verification check, audit timeline, and the public demo health HTTP status. Confirm HTTP 200 and the recorded incident outcome only if those live records show success. Say: “SiteGuard detected the failure, diagnosed the evidence, asked for scoped approval, and verified the controlled service after recovery.”

If a live action fails, show the actual error and persisted state. Do not substitute a mock result or claim a trace reached Neatlogs without dashboard confirmation.

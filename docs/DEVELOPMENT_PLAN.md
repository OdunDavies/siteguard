# SiteGuard MVP development plan

## Current state

The backend, monitoring engine, diagnosis graph, controlled Step 9 recovery path, and Neatlogs instrumentation are implemented locally. Credential-free unit tests exercise recovery and telemetry branches with mocked Supabase RPCs and telemetry. A later read-only audit found no SiteGuard objects in the configured Supabase project, conflicting with an earlier observation; confirm the target project before manual migration. RLS and live behavior remain unverified. Neatlogs Doctor local and authenticated probe passed; a synthetic diagnosis graph run flushed its trace, but its dashboard readback has not been independently checked. No real controlled recovery trace has been captured. Durable graph checkpoint/resume, deployment validation, and dashboard views remain.

| Priority | Work | Acceptance gate |
| --- | --- | --- |
| P0 — code complete, live verification pending | Review migration history in a disposable project; apply only missing migrations, including the trace-link migration. Verify RLS, exact advance grants, persistent demo state, linked fresh verification checks, two-attempt exhaustion, audit rows, and trace ID storage. | `FAILED -> DIAGNOSED -> AUTHORIZED -> RECOVERED -> VERIFIED` appears in real database records. |
| P1 — instrumentation implemented, live recovery trace pending | Exercise a controlled success, failed reset, and denied grant with Neatlogs. Compare trace IDs, nested spans, and run/attempt/check/audit rows. | Three actual controlled traces are visible and match their database outcomes. |
| P2 | Exercise Vercel function duration, scheduler frequency, and concurrent run behavior. Add durable checkpoint/resume or a worker if runtime limits require it. | Runs do not strand active or pending attempts on timeout. |
| P3 | Add a small authenticated operator UI for provisioning, failure simulation, grants/revocation, incidents, and run results. | A demo operator can execute and explain the flow without raw API calls. |

## Applying migrations

Review `supabase/migrations/202610110001_siteguard_foundation.sql`, `202610110002_monitoring_engine.sql`, `202610120001_controlled_recovery.sql`, and `202610120002_agent_trace.sql` against the intended Supabase project. A later read-only audit of the configured project found no SiteGuard tables or RPCs, conflicting with an earlier observation; confirm the project identity and actual migration history before execution. Apply **only missing migrations manually in filename order**, one complete transaction-wrapped file at a time in the Supabase SQL Editor, without adding an outer transaction. These files contain explicit `BEGIN`/`COMMIT`; verify a migration runner's transaction behavior in a disposable project before using `supabase db push` with them, so a runner-managed transaction is not ended by a file's `COMMIT`. This repository work applied none. Keep database credentials out of Git. Verify that authenticated clients cannot write websites directly, server API website writes remain owner-scoped, service-role-only RPC execution, own-read RLS, two-user isolation, grant replacement, and the exact-resource grant boundary before exposing the demo.

## Local controlled demo

Set Supabase public URL/key, service-role key, model configuration, and `SITEGUARD_DEMO_ORIGIN` in ignored `.env.local`. Use a public HTTPS origin of this deployment and put its exact hostname in `MONITOR_ALLOWLIST_HOSTS`. With an authenticated session:

1. `POST /api/demo/services` provisions the persistent demo and returns its health URL.
2. `POST /api/demo/services/<id>/authorizations` with `{ "expires_at": "<ISO timestamp within 24 hours>", "max_uses": 2 }` creates an exact advance grant. Save its ID.
3. `POST /api/demo/services/<id>/fail` with `{ "reset_behavior": "normal" }` makes the health endpoint return 503. For retry and escalation, use `no_effect` or `permanent_failure`.
4. Call `POST /api/websites/<id>/check` twice, at least 30 seconds apart, to open an incident. Read `GET /api/incidents/active` to obtain its ID.
5. `POST /api/incidents/<incidentId>/recover` with `{ "authorization_id": "<grant UUID>", "idempotency_key": "<fresh UUID>" }`. Read `GET /api/incidents/<incidentId>/runs` to inspect outcome, attempts, and linked verification check.
6. `DELETE /api/recovery/authorizations/<grantId>` revokes a grant. A revoked grant cannot authorize another attempt.

The demo health endpoint reflects PostgreSQL state across serverless invocations. It is public and read-only, using the private server worker key. Its unguessable resource URL exposes only the controlled fixture's health status; keep the URL within the test workflow. Provisioning, failure simulation, grant changes, diagnosis, and recovery all require a valid Supabase Auth session. A grant must predate the run. Recovery verification reads the persisted fixture state and links a new check to the attempt; it does not make a separate HTTP request.

## Tests

Run `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build`. The `npm test` recovery and telemetry suites use mocked RPC/database and SDK state; they do **not** prove SQL migration or hosted traces work. Run the installed Neatlogs Doctor local check and authenticated probe separately, then `node --env-file=.env.local --import tsx tests/neatlogs.integration.mts` for a synthetic diagnosis trace from real agent code with a mock data source. For real recovery persistence, use a disposable project with all required migrations confirmed and a real test user's access token in `SITEGUARD_TEST_ACCESS_TOKEN`, then run `node --env-file=.env.local --import tsx tests/recovery.integration.mts`. It uses a deterministic mock model but real Auth/RLS, RPCs, state transition, verification row, and audit rows. The scripts leave fixture records for inspection. Do not run them against production data.

For a separate small model gateway check, set `SITEGUARD_LLM_API_KEY`, `SITEGUARD_LLM_BASE_URL`, and `SITEGUARD_LLM_MODEL`, then run `node --env-file=.env.local --import tsx tests/gateway-smoke.mts`. That check does not exercise recovery.

## Known limits

The recovery graph runs within one request and has no durable LangGraph checkpoint/resume. An abrupt process termination may strand a `pending` attempt until an operator reconciles it; returned RPC timeouts become `unknown` and are verified without replay. The recovered check reads the trusted fixture row, not an external HTTP request. Monitoring of the public health endpoint is a separate SSRF-protected path. Neatlogs export is implemented but real recovery traces have not been verified; a Vercel scheduler is not configured. General infrastructure recovery is outside the MVP scope.

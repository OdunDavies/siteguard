# Autonomous agent state machine

## Diagnosis and controlled recovery

`src/lib/agents/diagnosis-graph.ts` currently implements `LOAD INCIDENT -> GATHER INITIAL EVIDENCE -> ANALYZE -> SELECT TOOL -> EXECUTE APPROVED READ-ONLY TOOL -> UPDATE EVIDENCE -> REASSESS -> VERIFY EVIDENCE REFERENCES -> GENERATE ADVISORY PLAN -> END`. It checks incident ownership with the authenticated Supabase client. Initial tools read up to 20 checks and service configuration; the model may choose HTTP status analysis, response-time analysis, or incident history. A failed tool yields a machine-readable error and one permitted fallback where capacity remains. The final Zod schema separates observations, probable causes, and unknowns; causes citing nonexistent evidence are omitted.

Diagnosis limits are 15 graph steps, four total read-only tool calls, two model assessments, a 30-second deadline, up to two explicit 8-second model attempts per assessment, and 500 output tokens per model attempt. The recovery graph adds a 47-second invocation cap and at most two reset attempts, reserving time for a bounded Neatlogs flush within the 60-second Route Handler limit. `agent_runs`, `recovery_attempts`, `health_checks`, and `audit_events` persist the important transitions through service-role-only database functions. The LangGraph state itself is per invocation; checkpoint/resume is not implemented.

## Trigger and state

A monitor creates or updates an incident after the configured failure threshold. An authenticated API call claims at most one active run per incident and uses a caller-supplied UUID idempotency key. The run stores incident and website IDs, structured diagnosis, selected action, authorization decision, attempt count, deadline, current state, and terminal outcome. Attempts store exact resource/grant references, status, and verification check ID. No secrets are stored in graph state.

```text
RECEIVED -> LOAD_HISTORY -> DIAGNOSE -> PLAN -> VALIDATE_AUTH
                                                | denied / no safe plan
                                                v
                                             ESCALATE
                                                |
                                                v
                                               RECORD

VALIDATE_AUTH -> EXECUTE -> VERIFY -> RECOVERED -> RECORD
                    |          |
                    |          +-- still unhealthy -> RETRY_DECISION
                    |                                 | bounded retry
                    |                                 +-> EXECUTE
                    |                                 | exhausted
                    +-- tool error ------------------> RETRY_DECISION

Any unrecoverable infrastructure/model/checkpoint error -> ESCALATE -> RECORD
```

| State | Required behavior | Persisted evidence / exit |
| --- | --- | --- |
| `RECEIVED` | Validate incident is open, acquire run lease, establish deadline and trace context. | Run ID and lease; duplicate delivery resumes or exits. |
| `LOAD_HISTORY` | Read recent checks, incident timeline, and the website's permitted resource metadata. | Bounded observation IDs and summary. |
| `DIAGNOSE` | Classify timeout, HTTP error, DNS/TLS failure, or other with a model; validate structured output. | Diagnosis, confidence, model metadata; invalid output escalates. |
| `PLAN` | Propose zero or one allowlisted recovery action for MVP, including expected result. | Structured action/resource IDs or `no_action`. |
| `VALIDATE_AUTH` | Deterministically check owner, active authorization, exact action/resource, expiry, revocation, limits, and current incident. | Durable allow/deny decision and reason. Denial cannot reach `EXECUTE`. |
| `EXECUTE` | Resolve fixed tool adapter; create idempotent attempt record before side effect; invoke with timeout. | Tool request ID, redacted response, status, and audit event. |
| `VERIFY` | After a short bounded settle delay, perform a fresh safe health check, possibly requiring consecutive healthy checks. | Check IDs, expected-vs-actual result. A tool success alone is insufficient. |
| `RETRY_DECISION` | Retry only a retryable, authorized action while remaining within deadline, attempt limit, and action budget. Recheck authorization. | Retry reason and next attempt number or escalation reason. |
| `RECOVERED` | Mark incident recovered only after verification. | Recovery timestamp and linked verification checks. |
| `ESCALATE` | Mark unresolved/manual attention with a precise reason; no more side effects. | Escalation reason and actionable timeline. |
| `RECORD` | Commit terminal incident/run outcome, release lease, finalize audit and Neatlogs trace. | Terminal status and correlation IDs. |

## Invariants and failure handling

1. Model text is untrusted data. The model cannot choose arbitrary tools, endpoints, SQL, shell commands, or credentials. A malformed plan takes the `no_action`/escalation path.
2. An explicit user authorization must predate execution and match the resource and action. Consent to monitor a site is not recovery authorization. Revocation takes effect before every attempt, including retries and resumes.
3. The tool registry contains only `reset_demo_service`, mapped to the fixed `demo_execute_reset` RPC. The idempotency key derives from `run ID + action ID + attempt number`. A row lock makes each claimed attempt single-use. Uncertain execution gets a fresh verification check and is never blindly retried.
4. A successful tool response never closes the incident. A fresh health check must pass after execution. Failed verification either retries within bounds or escalates.
5. Durable run, attempt, verification, and audit records carry incident/run/attempt IDs. Neatlogs custom spans use the same IDs; the root trace ID is written to `agent_runs.neatlogs_trace_id` when the trace-link migration is applied. A local Doctor pass, hosted Doctor probe, and synthetic diagnosis trace are distinct from a live recovery trace.
6. A timeout or function termination may leave an attempt ambiguous. The current RPC marks a returned timeout `unknown`, verifies once, and escalates if unhealthy. An abrupt process termination can leave a `pending` attempt; automatic checkpoint/resume/reconciliation is not implemented. The 60-second run deadline and one-active-run constraint prevent an unlimited active lease, but an operator must inspect an ambiguous pending attempt.
7. Bound total graph steps, model calls, action attempts, verification checks, history size, response size, and wall time in configuration. Exhaustion is a terminal escalation, not an unbounded loop.

## Demo acceptance scenario

Provision `POST /api/demo/services` with `SITEGUARD_DEMO_ORIGIN` set to a public HTTPS origin. Grant the exact action with `POST /api/demo/services/[id]/authorizations` before starting a run. Call `POST /api/demo/services/[id]/fail`, perform two monitoring checks, and observe an open incident. `POST /api/incidents/[incidentId]/recover` then diagnoses, claims the grant, resets the persistent fixture, records a new health check, and marks the incident recovered only if state is healthy. `GET /api/incidents/[incidentId]/runs` exposes correlated records and the trace ID after the new migration is applied. Revoked/expired/wrong-resource grants escalate before execution; `no_effect` retries once then escalates; `permanent_failure` escalates after one verified attempt. Mock telemetry tests exercise these three trace shapes. A real recovery trace still requires the new trace-link migration, a configured demo origin, and a valid test Auth session; see `docs/NEATLOGS_INTEGRATION.md`.

# Neatlogs integration

## Setup and trust boundary

SiteGuard uses the already installed Neatlogs TypeScript SDK `1.1.28`. Set `NEATLOGS_API_KEY` only in the server environment or ignored `.env.local`. `src/lib/observability/agent-telemetry.ts` awaits SDK `init()` once per warm runtime with workflow name `siteguard-agent`. A shared initialization state prevents duplicate setup across module import paths. Missing credentials or initialization failure make tracing a no-op; they do not change authorization or recovery. The SDK is never initialized in a client component.

The app uses Neatlogs `trace()` for explicit custom spans. It does not enable unsupported TypeScript automatic instrumentation. The model adapter wraps each `ChatOpenAI.invoke` in one semantic `LLM` span; it does not also attach `langchainHandler()`, which would duplicate spans and may capture raw monitoring evidence. The installed `@langchain/core` is 1.x while the current Neatlogs LangChain handler documentation lists a 0.3.x baseline. The explicit span records the configured model identifier, attempt number, duration supplied by the SDK, numeric token usage when returned, and sanitized failure type. LangChain's internal retry is disabled; SiteGuard performs at most two visible attempts per assessment.

Trace options and attributes contain run, incident, website, attempt, and verification check IDs; allowed tool names; result codes; counts; and outcome labels. No prompts, check bodies, URLs, user credentials, API keys, or raw exception messages are passed to Neatlogs. Span callback output is a bounded `{ outcome }` object instead of the function's raw result. Structured application logs likewise contain identifiers and codes only.

## Span tree and persistence

Each new diagnosis or recovery run creates one `siteguard.agent_run` `WORKFLOW` root. Diagnosis nodes trace incident loading, evidence gathering, model-backed analysis, diagnostic tool selection and execution, evidence validation, and advisory planning. Each diagnostic tool gets a `TOOL` span. Recovery adds action selection, exact-grant authorization, reset execution, fresh verification, retry/escalation, and database outcome writes. The graph's existing decision rules remain authoritative; telemetry does not choose actions or mark incidents recovered.

The root and child attributes share `siteguard.run_id` and `siteguard.incident_id`. Children add website, attempt, action, result, or verification check IDs when known. The root records `siteguard.final_outcome` for recovery. The new service-role-only `agent_set_trace_id` RPC in `202610120002_agent_trace.sql` stores the SDK trace ID in `agent_runs.neatlogs_trace_id`. This is auxiliary correlation; failure to store it is logged and does not replay a recovery action. Audit rows and verification checks remain the durable source of truth. **A later read-only audit found no SiteGuard objects in the configured project, conflicting with an earlier observation; no migration was applied by this work.**

Completed spans are flushed before diagnosis or recovery Route Handlers return, with an eight-second bound. The 47-second recovery graph cap leaves room under the handlers' 60-second maximum duration. A failed or timed-out flush is logged as possible telemetry loss and never changes the agent's decision. A warm serverless runtime is not shut down after each invocation.

## Verification levels

Run these separately from the project root:

```powershell
.\node_modules\.bin\neatlogs.cmd doctor --local --json
node --env-file=.env.local .\node_modules\neatlogs\dist\cli.mjs doctor --probe --json
node --env-file=.env.local --import tsx tests/neatlogs.integration.mts
```

The first command needs no credential and validates in-process SDK capture. The second needs `NEATLOGS_API_KEY` and verifies a synthetic four-span Doctor trace through hosted write, finalization, and authenticated readback. The third executes the **actual diagnosis graph** with synthetic incident/check rows and a deterministic mock model; it prints its run and trace IDs. It does not prove Supabase persistence, a real model call, or recovery. `npm test` uses a fake telemetry SDK and mocked database for routine initialization, nesting, model span metadata, denial, retry, verification, flush, and telemetry-failure tests.

After confirming all four migrations are present in a disposable Supabase project, run the controlled service flow in `DEVELOPMENT_PLAN.md` with a real Auth session and model gateway. Repeat it for:

1. `normal`: authorized reset changes the fixture from failed to healthy; the trace should show one authorization, one execution, a fresh successful verification, and `recovered`.
2. `no_effect` or `permanent_failure`: the trace should show failed verification and at most two executions, or one permanent failure, followed by `escalated`.
3. Missing, expired, or revoked grant: the trace should show `authorization_denied`, no execution span, and `escalated`.

These real recovery scenarios have **not** been run or captured yet. Do not label Doctor or mocked traces as recovered SiteGuard incidents.

## Finding and comparing traces

In the Neatlogs dashboard, open workflow `siteguard-agent` and search for the run ID or the exact trace ID returned by `GET /api/incidents/[incidentId]/runs` after migration. Compare root `siteguard.final_outcome`, authorization decision, `recovery.execute` result codes, `recovery.verify` outcome/check ID, and attempt counts. Match them against the same `agent_runs`, `recovery_attempts`, `health_checks`, and `audit_events` IDs in Supabase. A tool result of `RESET_APPLIED` is insufficient on its own; only a linked healthy verification check establishes recovery.

## Remaining limits

The configured Supabase project needs its identity and migration history confirmed before manual application; a later read-only audit found no SiteGuard objects there. RLS and a real recovery transition remain unverified. No real controlled recovery trace has been verified. The diagnosis graph has no durable LangGraph checkpoint/resume; process termination can leave a pending attempt. A flush can time out or be accepted without proving dashboard finalization, so inspect the exact trace for a live demo. Neatlogs Doctor's authenticated probe proves only its own synthetic trace. SiteGuard does not currently emit spans for scheduler checks outside an agent run.

References: [Neatlogs TypeScript SDK](https://docs.neatlogs.com/sdk/typescript), [SDK Doctor](https://docs.neatlogs.com/sdk/doctor), [Flush and Shutdown](https://docs.neatlogs.com/sdk/lifecycle).

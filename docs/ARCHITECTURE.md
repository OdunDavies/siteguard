# SiteGuard architecture

## Status and scope

The repository keeps the Next.js starter homepage and uses Next.js 16.4.0, React 19.3.0, TypeScript, Tailwind CSS 4, Supabase, Zod, LangGraph, and Neatlogs TypeScript SDK 1.1.28. Monitoring, incident detection, diagnosis, the controlled recovery path, and explicit agent tracing are implemented locally. A later read-only audit found no SiteGuard tables or RPCs in the configured Supabase project, conflicting with an earlier observation; confirm the target project before manually applying migrations. RLS and end-to-end behavior have not been verified. Durable LangGraph checkpoint/resume and dashboard views remain future work.

The architecture uses Next.js App Router for the UI and Node.js Route Handlers for request entry points. Keep business rules in server-only services, so the scheduler, authenticated API, and tests call the same logic. The existing `cacheComponents: true` setting means session-bound data must be read at request time and never placed in shared caches. Route Handlers are under `src/app/api/**/route.ts` and are uncached by default in this installed Next.js version.

## MVP system flow

```text
Supabase Auth session -> dashboard / authenticated Route Handlers
                                 |
                                 v
                      PostgreSQL + RLS
                                 ^
Scheduler -> protected tick -> claim due sites -> safe HTTP check
                                            | failure threshold
                                            v
                                    incident + agent run
                                            |
                         LangGraph: history -> diagnosis -> plan
                                            -> authorization gate
                                            -> allowlisted recovery tool
                                            -> verification / retry / escalation
                                            |
                         incident outcome + immutable audit events
                                            |
                               Neatlogs trace + structured logs
```

The authenticated manual endpoint and protected scheduler tick use the same monitoring service. A PostgreSQL RPC claims one website with a 30-second lease under a row lock; manual claims also enforce a 30-second per-website cooldown. The service fetches with a total timeout (default 8 seconds, maximum 20), at most three redirects, and a 16 KiB body cap. A second RPC atomically stores the check, advances the interval, and updates incident state. Two consecutive failures open one incident by default; two consecutive successes close it by default. Both thresholds are per-site settings from 1 to 5. A partial unique index allows only one `open` or `recovering` incident per site. Controlled recovery separately records a fresh post-action check. A claim whose lease expires before recording leaves the check unrecorded and is retried after the lease expires.

The scheduler entry point is `GET /api/monitor/tick`, authenticated with `Authorization: Bearer <CRON_SECRET>`. It selects at most two due websites and claims each in the database, so duplicate delivery cannot run the same website concurrently. Scheduling infrastructure is not configured by this repository work. `next_check_at` is updated on a recorded check; a failed invocation becomes eligible again after its lease expires. Recent history, 24-hour availability counts, and active incidents have authenticated read APIs.

The hackathon fixture is a `demo_services` PostgreSQL row bound to one website and owner. `GET /api/demo/health/[id]` reflects its persisted `healthy` or `failed` state. The sole executable action is `reset_demo_service`, implemented by a fixed database RPC. An explicit advance grant is scoped to that website ID and action. A reset can only change this row; it never accepts a URL, command, or external endpoint. `SITEGUARD_DEMO_ORIGIN` must be the exact public HTTPS deployment origin, and monitoring must allow its hostname. General recovery integrations are outside MVP scope.

The recovery entry point is `POST /api/incidents/[incidentId]/recover`. It verifies Supabase Auth ownership, claims an idempotent, rate-limited agent run, and invokes the LangGraph recovery workflow. The graph reuses diagnosis, selects the demo action only from conclusive failed-check evidence, claims an authorized attempt in a locked database transaction, executes the registered tool, and performs a fresh trusted read of demo state. A new `health_checks` row is linked to the attempt before an incident becomes `recovered`. A failed check can produce one more authorized attempt; denial, permanent failure, uncertain execution, exhaustion, or deadline causes escalation. `GET /api/incidents/[incidentId]/runs` exposes owned run/attempt results.

## Proposed modules

| Path | Responsibility |
| --- | --- |
| `src/app/(auth)` and `src/app/(dashboard)` | Login and responsive authenticated views; no secrets or recovery logic in client components. |
| `src/app/api` | Thin authenticated CRUD and incident endpoints, plus a separately authenticated scheduler endpoint. Validate inputs with Zod and delegate to services. |
| `src/components/ui`, `dashboard`, `monitoring`, `incidents` | Presentation components. |
| `src/lib/database` | Supabase user-session clients and repositories; a server-only service-role client performs authenticated, owner-scoped website mutations and monitoring/recovery writes. SQL migrations live under `supabase/migrations`. |
| `src/lib/monitoring` | Schedule claims, SSRF-safe HTTP transport, check evaluation, incident deduplication. |
| `src/lib/agents` | Bounded diagnosis graph and read-only evidence tools. |
| `src/lib/recovery` | Recovery graph, fixed tool registry, authorization RPC wrappers, and request validation. |
| `src/lib/observability` | Server-side Neatlogs lifecycle, safe custom spans, trace correlation, and bounded serverless flush. |
| `src/lib/validation`, `src/types`, `src/hooks` | Runtime schemas, shared types, optional UI hooks. |

Only add these directories as code requires them. The initial implementation should avoid a separate queue, message broker, or always-on worker.

## Boundaries and security

- **Identity and tenant access:** Supabase Auth identifies the user. Server handlers verify the session and resource ownership on every request. PostgreSQL row-level security (RLS) confines user-facing reads; authenticated roles cannot write website rows directly. The validated server API uses an owner-scoped worker write after authentication. A server-only privileged client never reaches browser bundles. Cache Components must not cache session-derived data across users.
- **Monitoring transport:** Treat every submitted URL as hostile. Registration accepts only `https`; the transport can follow `http` redirects for a deliberate controlled demo exception. Reject credentials, fragments, nonstandard ports, IP literals, local/special-use names, and overlong URLs. Resolve A and AAAA records, reject any non-public answer, then connect through a pinned Node socket lookup while preserving the hostname for TLS and Host validation. Redirects are handled explicitly and each destination is revalidated, including `MONITOR_ALLOWLIST_HOSTS` when set. Cap redirects, response bytes, and total time. Revalidate on every check. Configure an explicit public-host allowlist in deployment, especially for the controlled demo. Network egress policy is recommended as a second boundary.
- **Recovery:** The model emits a structured recommendation containing a known action ID, resource ID, and rationale. Zod and server policy validate it. A separate authorization row must already grant that exact action on that exact resource, with expiry, revocation, and limits checked immediately before execution. Only hard-coded adapters can perform side effects. No shell commands, arbitrary URLs, or model-selected credentials. A unique idempotency key prevents repeat execution on scheduler redelivery or graph resume.
- **Execution:** Each check, model call, and tool call has a timeout. The graph has a fixed step limit, retry count, and overall deadline. Errors persist as explicit states; exhaustion escalates rather than loops indefinitely. The controlled service credential has permission only for its reset operation.
- **Observability:** `siteguard.agent_run` is the Neatlogs root for each new diagnosis or recovery run. Custom nested spans cover existing graph nodes, diagnostic tools, individual model attempts, authorization, reset, verification, and final database writes. Span attributes carry bounded identifiers, codes, counts, model ID, and token usage where available; inputs, prompts, model responses, URLs, credentials, and raw errors are not captured. The root trace ID is stored in `agent_runs.neatlogs_trace_id` through a service-role-only RPC when the new migration is applied. Telemetry failure cannot authorize or replay recovery. A completed serverless request awaits a bounded flush without shutting down the warm SDK. See `docs/NEATLOGS_INTEGRATION.md`.

## Agent and model integration

The LangGraph diagnosis slice loads an owned incident, gathers bounded monitoring history and service metadata, asks a model to choose a read-only diagnostic tool, validates the choice, executes the tool, and reassesses the evidence. Tool failure can select one fallback. It has a 15-step, four-tool-call, two-model-call, 30-second budget. Agent outcomes are persisted in PostgreSQL; graph state itself is still in memory for one invocation. Durable graph checkpoints and resume remain a deployment task. Do not rely on process memory for resumability in Vercel functions.

The server-only model adapter uses `SITEGUARD_LLM_*` variables for a LiteLLM-compatible OpenAI-style endpoint, with an 8-second request timeout, one retry, and a 500-token output cap per call. A minimal gateway request returned a response that passed the assessment Zod schema. The model infers probable causes and selects from fixed read-only diagnostic tool IDs. Deterministic code validates evidence references and decides whether the sole controlled recovery action is eligible. Invalid or unavailable model output becomes an inconclusive diagnosis and cannot reach execution. Prompts and returned content are not logged.

The installed Neatlogs SDK is initialized asynchronously once per warm process for workflow `siteguard-agent`. The adapter uses `trace()` for safe explicit custom spans. It wraps `ChatOpenAI.invoke` in one semantic `LLM` span per explicit attempt and records the configured model ID and returned usage metadata. It does not attach `langchainHandler()` as well: that would duplicate model spans and capture the full monitoring evidence prompt. The installed LangChain core 1.x also differs from the SDK documentation's 0.3.x compatibility baseline. Local Doctor v2 and its authenticated hosted probe passed; these validate the SDK pipeline separately from the SiteGuard recovery workflow. [Neatlogs TypeScript SDK](https://docs.neatlogs.com/sdk/typescript), [SDK Doctor](https://docs.neatlogs.com/sdk/doctor).

## Deployment model and limits

Vercel serves the web app and protected tick Route Handler. A Vercel Cron schedule or external authenticated scheduler can trigger the tick, while `next_check_at` implements each website's configured interval. No cron deployment configuration is present yet. Scheduler delivery is not a guarantee of exact timing, so the database claim is atomic and each tick caps work at two checks. Vercel's Hobby plan currently permits cron only once per day; minute-level monitoring requires a plan or scheduler that supports it. Function duration and concurrency limits constrain long-running graph runs; persist progress and resume in bounded invocations, or use a dedicated worker later if needed. The demo can use the authenticated manual trigger without frequent cron. [Vercel Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Supabase PostgreSQL and Auth are external services. The graph checkpointer's PostgreSQL connection and pooling behavior must be tested against Supabase's supported connection mode before deployment. Neatlogs and the LiteLLM-compatible endpoint also require reachable external services and credentials; their failures must not silently authorize recovery. Static export is unsuitable because SiteGuard needs server Route Handlers and secrets.

## Dependency discipline

At implementation time, add only the packages justified by a working slice: Supabase client/SSR helpers, Zod, LangGraph and its compatible persistence adapter, a model client compatible with the chosen endpoint, and Neatlogs. Prefer built-in `fetch`, Node networking primitives, and database features over an extra HTTP framework, queue, or orchestration service. Check versions and APIs against current official documentation before installing.

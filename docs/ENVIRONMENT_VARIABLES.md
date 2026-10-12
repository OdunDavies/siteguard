# Environment variables

No real credentials belong in this file or in Git. Copy `.env.example` to local `.env.local` (ignored by Git) and configure deployed environments separately. Never return server secrets from a Route Handler or pass them to client components. User-facing API access requires `NEXT_PUBLIC_SUPABASE_URL` and one public key. Website mutations, monitoring, and controlled recovery require `SUPABASE_SERVICE_ROLE_KEY`; the scheduler endpoint requires `CRON_SECRET`.

| Variable | Exposure | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser and server; required now | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser and server; preferred | Current Supabase publishable key (`sb_publishable_...`). Used by the browser, server session client, and session proxy when present. Safe to expose only with correct RLS and grants. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser and server; temporary fallback | Legacy anon JWT. Used only when `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is absent or empty. Remove after all environments have migrated. Do not put a service-role or secret key in either public variable. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only; required for website mutations, monitoring, and recovery | Privileged website writes and monitoring/recovery RPCs through the dedicated worker module. Bypasses RLS; never use in browser code. Routes must authenticate the user and scope writes to the verified owner ID. |
| `SUPABASE_DB_URL` | Server/migrations only | PostgreSQL connection for migrations and possible durable LangGraph checkpointer. Use a connection mode compatible with the checkpointer; do not use in browser code. |
| `SITEGUARD_LLM_BASE_URL` | Server only; required for diagnosis | HTTPS base URL of the LiteLLM-compatible OpenAI-style model endpoint. |
| `SITEGUARD_LLM_API_KEY` | Server only; required for diagnosis | Model API credential. |
| `SITEGUARD_LLM_MODEL` | Server only; required for diagnosis | Exact deployed model identifier. |
| `NEATLOGS_API_KEY` | Server only; optional for tracing | Neatlogs project key for the fixed `siteguard-agent` workflow. If absent or initialization fails, agent execution continues without telemetry. Never prefix this variable with `NEXT_PUBLIC_`. |
| `CRON_SECRET` | Server only; required for scheduler tick | Shared secret used to authenticate `GET /api/monitor/tick` via a Bearer header. Without it the endpoint returns 503. |
| `SITEGUARD_DEMO_ORIGIN` | Server only; required for demo provisioning | Exact public HTTPS origin of this SiteGuard deployment, with no path, credentials, or explicit port. The demo health URL is formed from this origin and a controlled UUID. |
| `SITEGUARD_TEST_ACCESS_TOKEN` | Local integration test only | Short-lived Supabase Auth access token of a test user in a disposable migrated project. `scripts/test-auth.mjs` saves it with its expiration to ignored `.siteguard-test-session.json`; load it into the local test process only when needed. Never deploy or commit it. |
| `SITEGUARD_TEST_EMAIL` | Local authentication setup only | Email of the disposable Supabase Auth test user. Set in ignored `.env.local` for `node scripts/test-auth.mjs`. |
| `SITEGUARD_TEST_PASSWORD` | Local authentication setup only | Password of that disposable user. Keep only in ignored `.env.local`; never print or commit it. |
| `MONITOR_ALLOWLIST_HOSTS` | Server only; required for the controlled deployment | Comma-separated exact public hostnames eligible for monitoring, including the hostname of `SITEGUARD_DEMO_ORIGIN` and every allowed redirect host; no scheme, path, port, or wildcard. When set to an empty list, monitoring fails closed. |
| `MONITOR_TIMEOUT_MS` | Server only; optional | Total health-check deadline in milliseconds; integer from 1000 to 20000, default 8000. |

Set monitoring interval, failure threshold, recovery threshold, and per-site enablement in PostgreSQL, with hard-coded safe min/max bounds. Interval is 60–86400 seconds; both thresholds are 1–5. The monitoring request body cap is 16 KiB and redirect cap is three. Do not introduce a `NEXT_PUBLIC_` variable for model, Neatlogs, scheduler, database service role, or recovery credentials.

The diagnosis adapter validates all three `SITEGUARD_LLM_*` variables at creation. It requires HTTPS, caps model output at 500 tokens per attempt, and uses an 8-second request timeout. The previous `LITELLM_*` names in planning documents are superseded by these implemented names. No model key is sent to a client component. The recovery registry needs no external recovery token: it operates only on a controlled Supabase row through a service-role-only RPC.

The current model adapter performs up to two explicit 8-second attempts per assessment with LangChain automatic retries disabled, so each attempt has a distinct Neatlogs span. The workflow name is fixed in code as `siteguard-agent`; `NEATLOGS_WORKFLOW_NAME` is unused. The serverless route flushes completed spans for at most eight seconds and does not shut down a reusable runtime. Run the installed SDK Doctor local check without a key, then the authenticated probe with `NEATLOGS_API_KEY` loaded from a secret store or ignored `.env.local`. See `docs/NEATLOGS_INTEGRATION.md`.

Website URL validation at registration rejects obvious unsafe inputs, but does **not** authorize network access. The monitoring transport validates DNS A/AAAA answers and redirect destinations, rejects non-public addresses, and pins each connection to its validated IP. Configure `MONITOR_ALLOWLIST_HOSTS` for a controlled public demo host as a further boundary. Vercel Cron's `CRON_SECRET` convention and plan limits must be verified for the deployed project. See [Vercel Cron documentation](https://vercel.com/docs/cron-jobs) and [Neatlogs TypeScript SDK](https://docs.neatlogs.com/sdk/typescript).

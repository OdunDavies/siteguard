<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## SiteGuard project instructions

SiteGuard is a Next.js App Router, TypeScript, Tailwind application for autonomous website monitoring and explicitly authorized recovery. Read `docs/ARCHITECTURE.md`, `docs/AGENT_WORKFLOW.md`, `docs/DATABASE_SCHEMA.md`, `docs/DEVELOPMENT_PLAN.md`, and `docs/ENVIRONMENT_VARIABLES.md` before implementing related features. These are proposed designs; verify current repository state and provider APIs before coding.

- Preserve the existing Entire configuration, repository hooks, and checkpoints. Do not reinitialize the project.
- Before writing Next.js code, read the relevant installed guide under `node_modules/next/dist/docs/` as required above. This repository currently uses Next.js 16.4.0 with `cacheComponents: true`; treat authentication and private data as request-bound.
- Put request handling in thin `src/app/api/**/route.ts` files and business logic in server-only `src/lib` modules. Validate external input and model output with Zod. Keep API keys and privileged Supabase access off the client.
- Treat monitored URLs as SSRF inputs, including DNS results and redirect hops. Until the transport safely pins validated public destinations, restrict monitoring to the controlled allowlist.
- Never execute model-generated commands. Recovery requires a stored explicit grant for the exact predefined action and resource, checked immediately before each attempt. Make attempts idempotent, bounded, audited, and verified with a fresh health check.
- Preserve durable incident and agent state, record structured logs and Neatlogs traces, and escalate on failure or authorization denial.
- Prioritize a working end-to-end controlled-service agent and Neatlogs integration before dashboard polish. Add dependencies only for concrete implementation needs.

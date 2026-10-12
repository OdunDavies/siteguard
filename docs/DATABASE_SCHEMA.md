# Supabase database schema

## Conventions

Use PostgreSQL UUID primary keys, `timestamptz` UTC timestamps, explicit foreign keys, check constraints for finite statuses, and `created_at`/`updated_at` where mutable. `auth.users` is the identity source; no extra profile table is required. MVP ownership is one user per website; team accounts can be added later. The migrations are `supabase/migrations/202610110001_siteguard_foundation.sql`, `202610110002_monitoring_engine.sql`, `202610120001_controlled_recovery.sql`, and `202610120002_agent_trace.sql`. A later read-only audit found no SiteGuard objects in the configured project, conflicting with an earlier observation. Confirm the intended project and migration history before manual execution; live security behavior remains unverified.

## Tables

| Table | Core columns | Constraints and purpose |
| --- | --- | --- |
| `websites` | `id`, `owner_user_id -> auth.users.id`, `name`, `url`, `normalized_host`, `monitor_interval_seconds`, `failure_threshold`, `recovery_threshold`, `consecutive_failures`, `consecutive_successes`, `check_lease_token`, `check_lease_expires_at`, `last_manual_check_at`, `is_enabled`, `next_check_at`, `last_checked_at`, `created_at`, `updated_at` | One owner; bounded interval and thresholds; URL stored without credentials. A 30-second check lease prevents concurrent work and a 30-second manual cooldown limits repeated requests. Registration alone gives no recovery permission. |
| `health_checks` | `id`, `website_id -> websites.id`, `scheduled_for`, `checked_at`, `status` (`healthy`, `unhealthy`, `error`), `http_status`, `latency_ms`, `failure_kind`, `error_code`, `error_message`, `incident_id` nullable | Append-only bounded observation with sanitized error text, no response body or secrets. Unique `(website_id, scheduled_for)` for deduplication. Index `(website_id, checked_at desc)`. |
| `incidents` | `id`, `website_id -> websites.id`, `status` (`open`, `recovering`, `recovered`, `escalated`, `closed`), `started_at`, `resolved_at`, `failure_kind`, `summary`, `consecutive_failures`, `last_check_id -> health_checks.id` nullable, `created_at`, `updated_at` | Partial unique index on `website_id` while active (`open`, `recovering`) to prevent duplicate active incidents. Closing/reopening policy must be explicit. |
| `recovery_authorizations` | `id`, `website_id -> websites.id`, `granted_by -> auth.users.id`, `action_id`, `resource_id`, `enabled`, `expires_at`, `max_uses`, `uses_count`, `created_at`, `revoked_at` | Exact action/resource scope; no wildcard in MVP. Server-managed usage count; unique active grant as appropriate. Revocation/expiry checked immediately before each attempt. |
| `agent_runs` | `id`, `incident_id -> incidents.id`, `status` (`running`, `diagnosed`, `recovered`, `escalated`, `failed`), `request_key`, `mode`, `selected_action`, `authorization_decision`, `error_summary`, `current_state`, `diagnosis_json`, `attempt_count`, `step_count`, `deadline_at`, `lease_owner`, `lease_expires_at`, `version`, `neatlogs_trace_id` nullable, `started_at`, `finished_at` | One active run per incident; unique request key and 30-second same-mode cooldown. Diagnosis JSON size limited by the write RPC. A lease/version column exists, but automatic resume is not yet implemented. |
| `recovery_attempts` | `id`, `agent_run_id -> agent_runs.id`, `authorization_id -> recovery_authorizations.id`, `action_id`, `resource_id`, `idempotency_key`, `status` (`pending`, `succeeded`, `failed`, `unknown`), `requested_at`, `completed_at`, `tool_request_id`, `result_code`, `verification_check_id -> health_checks.id` nullable | Unique `idempotency_key`; create before side effect. Keep tool results redacted. `unknown` requires reconciliation, not blind replay. |
| `audit_events` | `id`, `website_id`, `incident_id` nullable, `agent_run_id` nullable, `recovery_attempt_id` nullable, `actor_type`, `actor_id` nullable, `event_type`, `decision`, `reason_code`, `metadata_json`, `occurred_at` | Append-only authorization decisions, grants/revocations, tool starts/results, verification and escalation. No API keys, prompts with secrets, or raw bodies. Index by incident/run/time. |
| `demo_services` | `id -> websites.id`, `owner_user_id`, `state` (`healthy`, `failed`), `reset_behavior` (`normal`, `no_effect`, `permanent_failure`), `last_failure_at`, `updated_at` | One controlled fixture per owner. The row persists across serverless invocations; only service-role RPCs mutate it. `id` and owner have a composite FK to the website. |

`202610120001_controlled_recovery.sql` is additive and follows the two 20261011 migrations. It changes the run status constraint and adds the columns above, the demo table and own-read RLS policy, and service-role-only functions for provisioning, failure simulation, exact grant/revocation, run claims, diagnosis storage, attempt claims, reset, uncertain outcomes, verification, and escalation. The configured project exposes its demo table and run columns, but this work did not apply or live validate the SQL.

`202610120002_agent_trace.sql` adds the service-role-only `agent_set_trace_id` RPC. It accepts a 32-character lowercase hexadecimal Neatlogs trace ID and updates only the run's existing `neatlogs_trace_id` field, refusing a different preexisting trace ID. It does not alter run status or recovery authorization.

Graph checkpoints may use the LangGraph PostgreSQL checkpointer's own tables in a separate schema. They are internal execution state, not a substitute for the domain tables or audit trail. Confirm package schema and connection compatibility before migration. Keep retention and cleanup rules separate for checks/checkpoints; never remove audit evidence as part of routine incident cleanup.

## Relationships

```text
auth.users 1--* websites 1--* health_checks
                      | 1--* incidents 1--* agent_runs 1--* recovery_attempts
                      | 1--* recovery_authorizations -----* recovery_attempts
                      +--* audit_events (also linked to incident/run/attempt)
```

The migration uses composite foreign keys to keep checks, incidents, runs, grants, attempts, and audit references tied to the same website. Foreign keys restrict deletion of incident, recovery, and audit history. The API soft deletes websites by setting `deleted_at` and disabling monitoring; an explicit retention process can follow later.

## Access control

- Enable RLS on every public table before exposing it. User read policies scope websites to `owner_user_id = auth.uid()`. Authenticated clients have no direct website INSERT or UPDATE grant or policy. The authenticated server endpoints validate URLs and intervals, confirm ownership for updates, and use a server-only service-role client for owner-scoped writes. Child-table read policies derive ownership through `websites`, with indexed foreign keys.
- Authenticated users may read their own checks, incidents, runs, attempts, and audit entries. They must **not** directly insert or update check results, incident outcomes, run states, attempt status, usage counts, or audit rows. Trusted server services perform those writes after their own authorization checks.
- Grant/revoke recovery authorization through authenticated server endpoints that validate ownership and the fixed tool/resource registry. Do not grant broad client `UPDATE` on `recovery_authorizations`; specifically protect `uses_count`, `resource_id`, and `action_id` from client mutation.
- Only the server's service-role client may execute the recovery RPCs. It must pass the authenticated caller's verified Supabase user ID; the SQL functions independently check website ownership, exact grant action/resource, expiry, revocation, usage budget, current incident, and run deadline under row locks. Browser roles have no execute grant or write policy for demo, run, attempt, grant, or audit rows.
- `recovery_begin_attempt` reserves one grant use and creates a unique attempt before the side effect. `demo_execute_reset` is single-use and rechecks the grant and controlled resource. `recovery_verify_attempt` inserts a new check tied to the attempt and only then records `recovered` or `escalated`. A returned timeout produces an `unknown` attempt and a verification check; it is never replayed.
- `demo_grant_recovery` locks the website, explicitly revokes an expired or exhausted demo grant with an audit event, then creates its replacement. A still-active grant must be revoked through the owner-scoped API before another grant can be created. The unique active-grant index remains time-independent.
- A Supabase service-role/secret key bypasses RLS; keep it server-only, use it in narrow worker/repository modules, and still scope every query by resource/owner as defense in depth. Never prefix it with `NEXT_PUBLIC_`. The browser may receive only Supabase URL and publishable/anon key, with RLS enforced.
- The scheduler route is authenticated by a dedicated secret and has no user session. It receives only the ability to claim due checks and drive bounded work. Recovery execution still requires a stored user grant.
- Add transaction/RPC boundaries for atomic due-site claims, active-incident creation, lease acquisition, authorization usage, and attempt idempotency. Application-side read-then-write checks alone are race-prone.

The monitoring migration adds `monitor_claim_check` and `monitor_record_check` RPC functions. Both execute only for `service_role`, not `anon` or `authenticated`. The claim locks the website row, verifies a due scheduled check or owner-scoped manual claim, and stores a lease. The record function locks the same row, checks the lease token, inserts a check, advances the schedule, updates streaks, opens or closes the active incident at the configured thresholds, and writes audit events in one transaction. The partial active-incident index remains a second concurrency guard. These functions and RLS behavior still require validation against a real Supabase project after manual migration application.

Reference: [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

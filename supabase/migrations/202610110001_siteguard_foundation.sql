-- SiteGuard foundation. Apply manually after reviewing against the target Supabase project.
begin;
create table public.websites (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 100),
  url text not null check (
    char_length(url) between 12 and 2048
    and url ~ '^https://[^/]+(/.*)?$'
  ),
  normalized_host text not null check (char_length(normalized_host) between 4 and 253 and normalized_host = lower(normalized_host)),
  monitor_interval_seconds integer not null default 300 check (monitor_interval_seconds between 60 and 86400),
  failure_threshold smallint not null default 2 check (failure_threshold between 1 and 5),
  is_enabled boolean not null default true,
  next_check_at timestamptz not null default now(),
  last_checked_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);
create index websites_owner_idx on public.websites(owner_user_id) where deleted_at is null;
create index websites_due_idx on public.websites(next_check_at) where is_enabled and deleted_at is null;

create table public.health_checks (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  scheduled_for timestamptz not null,
  checked_at timestamptz not null default now(),
  status text not null check (status in ('healthy', 'unhealthy', 'error')),
  http_status integer check (http_status between 100 and 599),
  latency_ms integer check (latency_ms >= 0),
  failure_kind text,
  error_code text,
  incident_id uuid,
  unique (website_id, scheduled_for),
  unique (id, website_id)
);
create index health_checks_website_time_idx on public.health_checks(website_id, checked_at desc);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  status text not null check (status in ('open', 'recovering', 'recovered', 'escalated', 'closed')),
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  failure_kind text,
  summary text check (char_length(summary) <= 2000),
  consecutive_failures integer not null default 1 check (consecutive_failures >= 1),
  last_check_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, website_id),
  foreign key (last_check_id, website_id) references public.health_checks(id, website_id) on delete restrict
);
create unique index incidents_one_active_per_website_idx on public.incidents(website_id)
  where status in ('open', 'recovering');
create index incidents_website_time_idx on public.incidents(website_id, started_at desc);
alter table public.health_checks add constraint health_checks_incident_same_website_fk
  foreign key (incident_id, website_id) references public.incidents(id, website_id) on delete restrict;

create table public.recovery_authorizations (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  granted_by uuid not null,
  action_id text not null check (char_length(action_id) between 1 and 100),
  resource_id text not null check (char_length(resource_id) between 1 and 200),
  enabled boolean not null default true,
  expires_at timestamptz not null,
  max_uses integer not null check (max_uses between 1 and 100),
  uses_count integer not null default 0 check (uses_count >= 0 and uses_count <= max_uses),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (id, website_id),
  foreign key (website_id, granted_by) references public.websites(id, owner_user_id) on delete restrict
);
create index recovery_authorizations_website_idx on public.recovery_authorizations(website_id);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  incident_id uuid not null,
  status text not null check (status in ('running', 'recovered', 'escalated', 'failed')),
  current_state text not null,
  diagnosis_json jsonb,
  plan_json jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  step_count integer not null default 0 check (step_count >= 0),
  deadline_at timestamptz not null,
  lease_owner text,
  lease_expires_at timestamptz,
  version integer not null default 1 check (version >= 1),
  neatlogs_trace_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id, website_id),
  foreign key (incident_id, website_id) references public.incidents(id, website_id) on delete restrict
);
create unique index agent_runs_one_active_per_incident_idx on public.agent_runs(incident_id)
  where status = 'running';

create table public.recovery_attempts (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  agent_run_id uuid not null,
  authorization_id uuid not null,
  action_id text not null,
  resource_id text not null,
  idempotency_key text not null unique,
  status text not null check (status in ('pending', 'succeeded', 'failed', 'unknown')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  tool_request_id text,
  result_code text,
  verification_check_id uuid,
  unique (id, website_id),
  foreign key (agent_run_id, website_id) references public.agent_runs(id, website_id) on delete restrict,
  foreign key (authorization_id, website_id) references public.recovery_authorizations(id, website_id) on delete restrict,
  foreign key (verification_check_id, website_id) references public.health_checks(id, website_id) on delete restrict
);
create index recovery_attempts_run_idx on public.recovery_attempts(agent_run_id, requested_at desc);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  incident_id uuid,
  agent_run_id uuid,
  recovery_attempt_id uuid,
  actor_type text not null check (actor_type in ('user', 'system', 'agent')),
  actor_id uuid references auth.users(id) on delete restrict,
  event_type text not null check (char_length(event_type) between 1 and 100),
  decision text,
  reason_code text,
  metadata_json jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata_json) = 'object'),
  occurred_at timestamptz not null default now(),
  foreign key (incident_id, website_id) references public.incidents(id, website_id) on delete restrict,
  foreign key (agent_run_id, website_id) references public.agent_runs(id, website_id) on delete restrict,
  foreign key (recovery_attempt_id, website_id) references public.recovery_attempts(id, website_id) on delete restrict
);
create index audit_events_website_time_idx on public.audit_events(website_id, occurred_at desc);
create index audit_events_incident_time_idx on public.audit_events(incident_id, occurred_at desc);

create function public.siteguard_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function public.siteguard_touch_updated_at() from public, anon, authenticated;
create trigger websites_touch_updated_at before update on public.websites
  for each row execute function public.siteguard_touch_updated_at();
create trigger incidents_touch_updated_at before update on public.incidents
  for each row execute function public.siteguard_touch_updated_at();

alter table public.websites enable row level security;
alter table public.health_checks enable row level security;
alter table public.incidents enable row level security;
alter table public.recovery_authorizations enable row level security;
alter table public.agent_runs enable row level security;
alter table public.recovery_attempts enable row level security;
alter table public.audit_events enable row level security;

-- Supabase projects may have broad default grants. Remove them before adding narrow grants.
revoke all on public.websites, public.health_checks, public.incidents,
  public.recovery_authorizations, public.agent_runs, public.recovery_attempts,
  public.audit_events from public, anon, authenticated;
grant select, insert, update, delete on public.websites, public.health_checks,
  public.incidents, public.recovery_authorizations, public.agent_runs,
  public.recovery_attempts, public.audit_events to service_role;
grant select on public.websites, public.health_checks, public.incidents,
  public.recovery_authorizations, public.agent_runs, public.recovery_attempts,
  public.audit_events to authenticated;

create policy websites_select_own on public.websites for select to authenticated
  using (owner_user_id = (select auth.uid()) and deleted_at is null);

create policy health_checks_select_own on public.health_checks for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_user_id = (select auth.uid()) and w.deleted_at is null));
create policy incidents_select_own on public.incidents for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_user_id = (select auth.uid()) and w.deleted_at is null));
create policy recovery_authorizations_select_own on public.recovery_authorizations for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_user_id = (select auth.uid()) and w.deleted_at is null));
create policy agent_runs_select_own on public.agent_runs for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_user_id = (select auth.uid()) and w.deleted_at is null));
create policy recovery_attempts_select_own on public.recovery_attempts for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_user_id = (select auth.uid()) and w.deleted_at is null));
create policy audit_events_select_own on public.audit_events for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_user_id = (select auth.uid()) and w.deleted_at is null));
commit;

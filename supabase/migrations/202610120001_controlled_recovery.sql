-- Apply manually after 202610110002_monitoring_engine.sql.
-- Public RPCs below are executable only by service_role; never call them from a browser.
begin;

create table public.demo_services (
  id uuid primary key references public.websites(id) on delete restrict,
  owner_user_id uuid not null unique,
  state text not null default 'healthy' check (state in ('healthy', 'failed')),
  reset_behavior text not null default 'normal' check (reset_behavior in ('normal', 'no_effect', 'permanent_failure')),
  last_failure_at timestamptz,
  foreign key (id, owner_user_id) references public.websites(id, owner_user_id) on delete restrict,
  updated_at timestamptz not null default now()
);
create trigger demo_services_touch_updated_at before update on public.demo_services
  for each row execute function public.siteguard_touch_updated_at();
alter table public.demo_services enable row level security;
revoke all on public.demo_services from public, anon, authenticated;
grant select, insert, update, delete on public.demo_services to service_role;
grant select on public.demo_services to authenticated;
create policy demo_services_select_own on public.demo_services for select to authenticated
  using (exists (select 1 from public.websites w where w.id = demo_services.id
    and w.owner_user_id = (select auth.uid()) and w.deleted_at is null));

create function public.demo_provision(p_owner_id uuid, p_origin text, p_host text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  if p_owner_id is null or p_host is null or
    p_host !~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$' or
    p_origin <> 'https://' || p_host then
    raise exception 'invalid demo origin' using errcode = '22023';
  end if;
  insert into public.websites (id, owner_user_id, name, url, normalized_host,
    monitor_interval_seconds, failure_threshold, is_enabled)
  values (v_id, p_owner_id, 'SiteGuard controlled demo',
    p_origin || '/api/demo/health/' || v_id::text, p_host, 300, 2, true);
  insert into public.demo_services (id, owner_user_id) values (v_id, p_owner_id);
  return v_id;
end;
$$;

create function public.demo_set_failed(p_demo_id uuid, p_owner_id uuid, p_behavior text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_site public.websites%rowtype; v_demo public.demo_services%rowtype;
begin
  if p_behavior not in ('normal', 'no_effect', 'permanent_failure') then
    raise exception 'invalid demo behavior' using errcode = '22023';
  end if;
  select * into v_site from public.websites where id = p_demo_id for update;
  if not found or v_site.owner_user_id is distinct from p_owner_id
    or v_site.deleted_at is not null then
    raise exception 'demo unavailable' using errcode = '22023';
  end if;
  select * into v_demo from public.demo_services where id = p_demo_id for update;
  if not found or v_demo.last_failure_at > clock_timestamp() - interval '10 seconds' then
    raise exception 'demo unavailable or rate limited' using errcode = '22023';
  end if;
  update public.demo_services set state = 'failed', reset_behavior = p_behavior,
    last_failure_at = clock_timestamp() where id = p_demo_id;
  insert into public.audit_events (website_id, actor_type, actor_id, event_type, reason_code)
    values (p_demo_id, 'user', p_owner_id, 'demo.failed', p_behavior);
end;
$$;

alter table public.agent_runs
  drop constraint agent_runs_status_check,
  add constraint agent_runs_status_check
    check (status in ('running', 'diagnosed', 'recovered', 'escalated', 'failed')),
  add column request_key uuid unique,
  add column mode text not null default 'diagnosis' check (mode in ('diagnosis', 'recovery')),
  add column selected_action text,
  add column authorization_decision text,
  add column error_summary text check (char_length(error_summary) <= 200);
create unique index recovery_one_active_demo_grant_idx on public.recovery_authorizations(website_id)
  where action_id = 'reset_demo_service' and enabled and revoked_at is null;

create function public.demo_grant_recovery(p_demo_id uuid, p_owner_id uuid,
  p_expires_at timestamptz, p_max_uses integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_site public.websites%rowtype;
  v_id uuid;
  v_replaced_id uuid;
  v_replacement_reason text;
begin
  select * into v_site from public.websites where id = p_demo_id for update;
  if not found or v_site.owner_user_id is distinct from p_owner_id
    or v_site.deleted_at is not null
    or not exists (select 1 from public.demo_services where id = p_demo_id)
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '24 hours'
    or p_max_uses not between 1 and 2 then
    raise exception 'authorization unavailable' using errcode = '22023';
  end if;
  -- The website lock serializes grant creation. Expired or spent grants are
  -- explicitly revoked before the unique active-grant index is checked.
  select id, case when expires_at <= clock_timestamp()
    then 'expired_replaced' else 'exhausted_replaced' end
    into v_replaced_id, v_replacement_reason
  from public.recovery_authorizations
  where website_id = p_demo_id and action_id = 'reset_demo_service'
    and enabled and revoked_at is null
    and (expires_at <= clock_timestamp() or uses_count >= max_uses)
  for update;
  if v_replaced_id is not null then
    update public.recovery_authorizations set enabled = false,
      revoked_at = clock_timestamp() where id = v_replaced_id;
    insert into public.audit_events (website_id, actor_type, event_type,
      decision, reason_code, metadata_json)
    values (p_demo_id, 'system', 'recovery.revoked', 'deny',
      v_replacement_reason, jsonb_build_object('authorization_id', v_replaced_id));
  end if;
  insert into public.recovery_authorizations (website_id, granted_by,
    action_id, resource_id, expires_at, max_uses)
  values (p_demo_id, p_owner_id, 'reset_demo_service', p_demo_id::text,
    p_expires_at, p_max_uses) returning id into v_id;
  insert into public.audit_events (website_id, actor_type, actor_id,
    event_type, decision, reason_code)
  values (p_demo_id, 'user', p_owner_id, 'recovery.granted', 'allow', 'advance_grant');
  return v_id;
end;
$$;

create function public.demo_revoke_recovery(p_authorization_id uuid, p_owner_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_grant public.recovery_authorizations%rowtype;
begin
  select * into v_grant from public.recovery_authorizations
    where id = p_authorization_id for update;
  if not found or not exists (select 1 from public.websites where id = v_grant.website_id
    and owner_user_id = p_owner_id and deleted_at is null) then return false; end if;
  if v_grant.revoked_at is null then
    update public.recovery_authorizations set enabled = false,
      revoked_at = clock_timestamp() where id = p_authorization_id;
    insert into public.audit_events (website_id, actor_type, actor_id,
      event_type, decision, reason_code)
    values (v_grant.website_id, 'user', p_owner_id, 'recovery.revoked', 'deny', 'owner_revoked');
  end if;
  return true;
end;
$$;

create function public.agent_start_run(p_incident_id uuid, p_owner_id uuid, p_request_key uuid, p_mode text)
returns table (run_id uuid, is_new boolean, run_status text)
language plpgsql security invoker set search_path = '' as $$
declare
  v_incident public.incidents%rowtype;
  v_site public.websites%rowtype;
  v_existing public.agent_runs%rowtype;
begin
  if p_mode not in ('diagnosis', 'recovery') or p_owner_id is null or p_request_key is null then
    raise exception 'invalid run request' using errcode = '22023';
  end if;
  select * into v_incident from public.incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident unavailable' using errcode = '22023';
  end if;
  select * into v_site from public.websites where id = v_incident.website_id;
  if v_site.owner_user_id is distinct from p_owner_id or v_site.deleted_at is not null then
    raise exception 'incident unavailable' using errcode = '22023';
  end if;
  select * into v_existing from public.agent_runs where request_key = p_request_key;
  if found then
    if v_existing.incident_id <> p_incident_id or v_existing.mode <> p_mode then
      raise exception 'idempotency key conflict' using errcode = '23505';
    end if;
    run_id := v_existing.id; is_new := false; run_status := v_existing.status;
    return next; return;
  end if;
  if v_incident.status not in ('open', 'recovering') then
    raise exception 'incident unavailable' using errcode = '22023';
  end if;
  update public.agent_runs set status = 'failed', current_state = 'expired',
    error_summary = 'run_deadline_exceeded', finished_at = clock_timestamp()
  where incident_id = p_incident_id and status = 'running' and deadline_at < clock_timestamp();
  if exists (select 1 from public.agent_runs where incident_id = p_incident_id and status = 'running') then
    raise exception 'run already active' using errcode = '23505';
  end if;
  if exists (select 1 from public.agent_runs where incident_id = p_incident_id
    and mode = p_mode and started_at > clock_timestamp() - interval '30 seconds') then
    raise exception 'run rate limited' using errcode = '22023';
  end if;
  insert into public.agent_runs (website_id, incident_id, status, current_state, deadline_at,
    request_key, mode, lease_owner, lease_expires_at)
  values (v_incident.website_id, p_incident_id, 'running', 'diagnose',
    clock_timestamp() + interval '60 seconds', p_request_key, p_mode,
    p_owner_id::text, clock_timestamp() + interval '60 seconds') returning id into run_id;
  insert into public.audit_events (website_id, incident_id, agent_run_id, actor_type, actor_id,
    event_type, reason_code) values (v_incident.website_id, p_incident_id, run_id,
    'user', p_owner_id, 'agent.started', p_mode);
  is_new := true; run_status := 'running'; return next;
end;
$$;

create function public.agent_store_diagnosis(p_run_id uuid, p_diagnosis jsonb, p_step_count integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_run public.agent_runs%rowtype;
begin
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.status <> 'running' or v_run.deadline_at <= clock_timestamp()
    or p_step_count < 0 or p_step_count > 20 or p_diagnosis is null
    or octet_length(p_diagnosis::text) > 16000 then
    raise exception 'run unavailable' using errcode = '22023';
  end if;
  update public.agent_runs set diagnosis_json = p_diagnosis, step_count = p_step_count,
    current_state = case when v_run.mode = 'diagnosis' then 'diagnosed' else 'select_action' end,
    status = case when v_run.mode = 'diagnosis' then 'diagnosed' else status end,
    finished_at = case when v_run.mode = 'diagnosis' then clock_timestamp() else null end
  where id = p_run_id;
  insert into public.audit_events (website_id, incident_id, agent_run_id, actor_type,
    event_type, reason_code) values (v_run.website_id, v_run.incident_id, p_run_id,
    'agent', 'diagnosis.recorded', 'completed');
end;
$$;

create function public.agent_fail_run(p_run_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_run public.agent_runs%rowtype;
begin
  if p_reason not in ('diagnosis_failed', 'run_deadline_exceeded') then
    raise exception 'invalid failure reason' using errcode = '22023';
  end if;
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.status <> 'running' then return; end if;
  update public.agent_runs set status = 'failed', current_state = 'failed',
    error_summary = p_reason, finished_at = clock_timestamp() where id = p_run_id;
  insert into public.audit_events (website_id, incident_id, agent_run_id,
    actor_type, event_type, reason_code)
  values (v_run.website_id, v_run.incident_id, v_run.id,
    'agent', 'agent.failed', p_reason);
end;
$$;

create function public.recovery_escalate_run(p_run_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_run public.agent_runs%rowtype;
begin
  if p_reason not in ('no_safe_action', 'authorization_denied', 'tool_failed',
    'verification_failed', 'run_failed', 'incident_changed') then
    raise exception 'invalid escalation reason' using errcode = '22023';
  end if;
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.status <> 'running' then return; end if;
  update public.agent_runs set status = 'escalated', current_state = 'escalated',
    error_summary = p_reason,
    authorization_decision = case when p_reason = 'authorization_denied' then 'denied'
      else authorization_decision end,
    finished_at = clock_timestamp() where id = p_run_id;
  update public.incidents set status = 'escalated' where id = v_run.incident_id
    and status in ('open', 'recovering');
  insert into public.audit_events (website_id, incident_id, agent_run_id, actor_type,
    event_type, reason_code) values (v_run.website_id, v_run.incident_id, p_run_id,
    'agent', 'recovery.escalated', p_reason);
end;
$$;

create function public.recovery_begin_attempt(p_run_id uuid, p_owner_id uuid,
  p_authorization_id uuid, p_idempotency_key text)
returns table (attempt_id uuid, decision text)
language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.agent_runs%rowtype;
  v_site public.websites%rowtype;
  v_grant public.recovery_authorizations%rowtype;
  v_existing public.recovery_attempts%rowtype;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) > 150 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  select * into v_run from public.agent_runs where id = p_run_id for update;
  if not found or v_run.mode <> 'recovery' or v_run.status <> 'running'
    or v_run.diagnosis_json is null
    or v_run.deadline_at <= clock_timestamp() then
    raise exception 'run unavailable' using errcode = '22023';
  end if;
  select * into v_site from public.websites where id = v_run.website_id;
  if v_site.owner_user_id is distinct from p_owner_id or v_site.deleted_at is not null then
    raise exception 'run unavailable' using errcode = '22023';
  end if;
  select * into v_existing from public.recovery_attempts where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.agent_run_id <> p_run_id then
      raise exception 'idempotency key conflict' using errcode = '23505';
    end if;
    attempt_id := v_existing.id; decision := 'duplicate'; return next; return;
  end if;
  update public.agent_runs set selected_action = 'reset_demo_service',
    current_state = 'authorize' where id = p_run_id;
  select * into v_grant from public.recovery_authorizations
    where id = p_authorization_id and website_id = v_run.website_id for update;
  if not found or v_grant.action_id <> 'reset_demo_service'
    or v_grant.resource_id <> v_run.website_id::text or not v_grant.enabled
    or v_grant.revoked_at is not null or v_grant.expires_at <= clock_timestamp()
    or v_grant.uses_count >= v_grant.max_uses or v_grant.created_at > v_run.started_at
    or v_run.attempt_count >= 2
    or not exists (select 1 from public.demo_services where id = v_run.website_id)
    or not exists (select 1 from public.incidents where id = v_run.incident_id
      and status in ('open', 'recovering')) then
    perform public.recovery_escalate_run(p_run_id, 'authorization_denied');
    attempt_id := null; decision := 'denied'; return next; return;
  end if;
  update public.recovery_authorizations set uses_count = uses_count + 1 where id = v_grant.id;
  insert into public.recovery_attempts (website_id, agent_run_id, authorization_id,
    action_id, resource_id, idempotency_key, status)
  values (v_run.website_id, p_run_id, v_grant.id, 'reset_demo_service',
    v_run.website_id::text, p_idempotency_key, 'pending') returning id into attempt_id;
  update public.agent_runs set attempt_count = attempt_count + 1,
    selected_action = 'reset_demo_service', authorization_decision = 'allowed',
    current_state = 'execute' where id = p_run_id;
  insert into public.audit_events (website_id, incident_id, agent_run_id,
    recovery_attempt_id, actor_type, actor_id, event_type, decision, reason_code)
  values (v_run.website_id, v_run.incident_id, p_run_id, attempt_id,
    'user', p_owner_id, 'recovery.authorized', 'allow', 'exact_grant');
  decision := 'allowed'; return next;
end;
$$;

create function public.demo_execute_reset(p_attempt_id uuid)
returns table (result_code text, retryable boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  v_attempt public.recovery_attempts%rowtype;
  v_run public.agent_runs%rowtype;
  v_grant public.recovery_authorizations%rowtype;
  v_demo public.demo_services%rowtype;
  v_result_code text;
begin
  select * into v_attempt from public.recovery_attempts where id = p_attempt_id for update;
  if not found or v_attempt.status <> 'pending' then
    raise exception 'attempt unavailable' using errcode = '22023';
  end if;
  select * into v_run from public.agent_runs where id = v_attempt.agent_run_id for update;
  select * into v_grant from public.recovery_authorizations
    where id = v_attempt.authorization_id for update;
  select * into v_demo from public.demo_services where id = v_attempt.website_id for update;
  if v_run.status <> 'running' or v_run.deadline_at <= clock_timestamp()
    or v_grant.id is null or not v_grant.enabled or v_grant.revoked_at is not null
    or v_grant.expires_at <= clock_timestamp() or v_grant.action_id <> 'reset_demo_service'
    or v_grant.resource_id <> v_attempt.resource_id or v_demo.id is null
    or v_demo.id::text <> v_attempt.resource_id
    or v_run.selected_action <> 'reset_demo_service'
    or not exists (select 1 from public.websites w where w.id = v_attempt.website_id
      and w.deleted_at is null and w.owner_user_id = v_grant.granted_by)
    or not exists (select 1 from public.incidents i where i.id = v_run.incident_id
      and i.status in ('open', 'recovering')) then
    update public.recovery_attempts set status = 'failed', completed_at = clock_timestamp(),
      result_code = 'AUTHORIZATION_REVOKED' where id = p_attempt_id;
    perform public.recovery_escalate_run(v_attempt.agent_run_id, 'authorization_denied');
    result_code := 'AUTHORIZATION_REVOKED'; retryable := false; return next; return;
  end if;
  if v_demo.reset_behavior = 'permanent_failure' then
    result_code := 'TOOL_PERMANENT_FAILURE'; retryable := false;
    update public.recovery_attempts set status = 'failed', completed_at = clock_timestamp(),
      result_code = 'TOOL_PERMANENT_FAILURE' where id = p_attempt_id;
  else
    if v_demo.reset_behavior = 'normal' then
      update public.demo_services set state = 'healthy' where id = v_demo.id;
    end if;
    v_result_code := case when v_demo.reset_behavior = 'normal' then 'RESET_APPLIED' else 'RESET_NO_EFFECT' end;
    result_code := v_result_code;
    retryable := v_demo.reset_behavior = 'no_effect';
    update public.recovery_attempts set status = 'succeeded', completed_at = clock_timestamp(),
      result_code = v_result_code where id = p_attempt_id;
  end if;
  insert into public.audit_events (website_id, incident_id, agent_run_id,
    recovery_attempt_id, actor_type, event_type, reason_code)
  values (v_run.website_id, v_run.incident_id, v_run.id, p_attempt_id,
    'agent', 'recovery.executed', result_code);
  return next;
end;
$$;

create function public.recovery_mark_unknown(p_attempt_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_attempt public.recovery_attempts%rowtype; v_run public.agent_runs%rowtype;
begin
  select * into v_attempt from public.recovery_attempts where id = p_attempt_id for update;
  if not found or v_attempt.status <> 'pending' then return; end if;
  select * into v_run from public.agent_runs where id = v_attempt.agent_run_id;
  update public.recovery_attempts set status = 'unknown', completed_at = clock_timestamp(),
    result_code = 'UNKNOWN_OUTCOME' where id = p_attempt_id;
  insert into public.audit_events (website_id, incident_id, agent_run_id,
    recovery_attempt_id, actor_type, event_type, reason_code)
  values (v_run.website_id, v_run.incident_id, v_run.id, p_attempt_id,
    'agent', 'recovery.unknown', 'execution_uncertain');
end;
$$;

create function public.recovery_verify_attempt(p_attempt_id uuid)
returns table (check_id uuid, outcome text, checked_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare
  v_attempt public.recovery_attempts%rowtype;
  v_run public.agent_runs%rowtype;
  v_demo public.demo_services%rowtype;
  v_incident public.incidents%rowtype;
  v_healthy boolean;
begin
  select * into v_attempt from public.recovery_attempts where id = p_attempt_id for update;
  if not found or v_attempt.completed_at is null then
    raise exception 'attempt not completed' using errcode = '22023';
  end if;
  if v_attempt.verification_check_id is not null then
    select hc.checked_at into recovery_verify_attempt.checked_at from public.health_checks hc
      where hc.id = v_attempt.verification_check_id;
    check_id := v_attempt.verification_check_id;
    select status into outcome from public.agent_runs where id = v_attempt.agent_run_id;
    return next; return;
  end if;
  select * into v_run from public.agent_runs where id = v_attempt.agent_run_id for update;
  select * into v_incident from public.incidents where id = v_run.incident_id for update;
  select * into v_demo from public.demo_services where id = v_attempt.website_id for update;
  if v_run.status <> 'running' or v_incident.status not in ('open', 'recovering')
    or v_demo.id is null then
    raise exception 'verification unavailable' using errcode = '22023';
  end if;
  checked_at := clock_timestamp();
  v_healthy := v_demo.state = 'healthy';
  insert into public.health_checks (website_id, scheduled_for, checked_at, status,
    http_status, latency_ms, failure_kind, error_code, incident_id)
  values (v_run.website_id, checked_at, checked_at,
    case when v_healthy then 'healthy' else 'unhealthy' end,
    case when v_healthy then 200 else 500 end, 0,
    case when v_healthy then null else 'demo_failed' end,
    case when v_healthy then null else 'DEMO_UNHEALTHY' end, v_run.incident_id)
  returning id into check_id;
  update public.recovery_attempts set verification_check_id = check_id where id = p_attempt_id;
  if v_healthy and v_attempt.status in ('succeeded', 'unknown') then
    update public.agent_runs set status = 'recovered', current_state = 'verified',
      finished_at = checked_at where id = v_run.id;
    update public.incidents set status = 'recovered', resolved_at = checked_at,
      last_check_id = check_id where id = v_incident.id;
    outcome := 'recovered';
  elsif v_attempt.status = 'unknown' or v_run.attempt_count >= 2
    or v_attempt.result_code = 'TOOL_PERMANENT_FAILURE' then
    perform public.recovery_escalate_run(v_run.id, case when v_attempt.result_code = 'TOOL_PERMANENT_FAILURE'
      then 'tool_failed' else 'verification_failed' end);
    outcome := 'escalated';
  else
    update public.agent_runs set current_state = 'retry' where id = v_run.id;
    outcome := 'retry';
  end if;
  insert into public.audit_events (website_id, incident_id, agent_run_id,
    recovery_attempt_id, actor_type, event_type, reason_code,
    metadata_json) values (v_run.website_id, v_run.incident_id, v_run.id,
    p_attempt_id, 'agent', 'recovery.verified', outcome,
    jsonb_build_object('check_id', check_id));
  return next;
end;
$$;

revoke all on function public.demo_provision(uuid, text, text),
  public.demo_set_failed(uuid, uuid, text),
  public.demo_grant_recovery(uuid, uuid, timestamptz, integer),
  public.demo_revoke_recovery(uuid, uuid),
  public.agent_start_run(uuid, uuid, uuid, text),
  public.agent_store_diagnosis(uuid, jsonb, integer),
  public.agent_fail_run(uuid, text),
  public.recovery_escalate_run(uuid, text),
  public.recovery_begin_attempt(uuid, uuid, uuid, text),
  public.demo_execute_reset(uuid), public.recovery_mark_unknown(uuid),
  public.recovery_verify_attempt(uuid)
  from public, anon, authenticated;
grant execute on function public.demo_provision(uuid, text, text),
  public.demo_set_failed(uuid, uuid, text),
  public.demo_grant_recovery(uuid, uuid, timestamptz, integer),
  public.demo_revoke_recovery(uuid, uuid),
  public.agent_start_run(uuid, uuid, uuid, text),
  public.agent_store_diagnosis(uuid, jsonb, integer),
  public.agent_fail_run(uuid, text),
  public.recovery_escalate_run(uuid, text),
  public.recovery_begin_attempt(uuid, uuid, uuid, text),
  public.demo_execute_reset(uuid), public.recovery_mark_unknown(uuid),
  public.recovery_verify_attempt(uuid)
  to service_role;
commit;

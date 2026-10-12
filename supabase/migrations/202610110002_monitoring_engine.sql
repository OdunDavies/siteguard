-- Apply manually after 202610110001_siteguard_foundation.sql.
-- Only service_role may claim work or write monitoring outcomes.
begin;
alter table public.websites
  add column recovery_threshold smallint not null default 2 check (recovery_threshold between 1 and 5),
  add column consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  add column consecutive_successes integer not null default 0 check (consecutive_successes >= 0),
  add column check_lease_token uuid,
  add column check_lease_expires_at timestamptz,
  add column last_manual_check_at timestamptz;

alter table public.health_checks
  add column error_message text check (char_length(error_message) <= 200);

create function public.monitor_claim_check(
  p_website_id uuid,
  p_mode text,
  p_owner_id uuid default null
) returns table (lease_token uuid, website_url text, claimed_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare
  v_site public.websites%rowtype;
  v_now timestamptz := clock_timestamp();
  v_token uuid := gen_random_uuid();
begin
  if p_mode not in ('manual', 'scheduled') then
    raise exception 'invalid monitoring mode' using errcode = '22023';
  end if;

  select * into v_site from public.websites where id = p_website_id for update;
  if not found or v_site.deleted_at is not null or not v_site.is_enabled then
    return;
  end if;
  if p_mode = 'manual' and (p_owner_id is null or p_owner_id <> v_site.owner_user_id) then
    return;
  end if;
  if v_site.check_lease_expires_at > v_now then
    return;
  end if;
  if p_mode = 'manual' and v_site.last_manual_check_at > v_now - interval '30 seconds' then
    return;
  end if;
  if p_mode = 'scheduled' and v_site.next_check_at > v_now then
    return;
  end if;

  update public.websites set
    check_lease_token = v_token,
    check_lease_expires_at = v_now + interval '30 seconds',
    last_manual_check_at = case when p_mode = 'manual' then v_now else last_manual_check_at end
  where id = p_website_id;

  lease_token := v_token;
  website_url := v_site.url;
  claimed_at := v_now;
  return next;
end;
$$;

create function public.monitor_record_check(
  p_website_id uuid,
  p_lease_token uuid,
  p_claimed_at timestamptz,
  p_status text,
  p_http_status integer,
  p_latency_ms integer,
  p_failure_kind text,
  p_error_code text,
  p_error_message text
) returns table (check_id uuid, incident_id uuid, incident_status text)
language plpgsql security invoker set search_path = '' as $$
declare
  v_site public.websites%rowtype;
  v_incident public.incidents%rowtype;
  v_check_id uuid;
  v_incident_id uuid;
  v_incident_status text;
  v_failures integer;
  v_successes integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_status not in ('healthy', 'unhealthy', 'error') then
    raise exception 'invalid check status' using errcode = '22023';
  end if;
  select * into v_site from public.websites where id = p_website_id for update;
  if not found or p_lease_token is null or v_site.check_lease_token is null
    or v_site.check_lease_token is distinct from p_lease_token
    or v_site.check_lease_expires_at is null or v_site.check_lease_expires_at <= v_now then
    raise exception 'monitoring lease expired or absent' using errcode = '22023';
  end if;

  insert into public.health_checks (
    website_id, scheduled_for, checked_at, status, http_status, latency_ms,
    failure_kind, error_code, error_message
  ) values (
    p_website_id, p_claimed_at, v_now, p_status, p_http_status, p_latency_ms,
    p_failure_kind, p_error_code, p_error_message
  ) returning id into v_check_id;

  select * into v_incident from public.incidents
    where website_id = p_website_id and status in ('open', 'recovering') for update;

  if p_status = 'healthy' then
    v_failures := 0;
    v_successes := v_site.consecutive_successes + 1;
    if v_incident.id is not null then
      update public.health_checks set incident_id = v_incident.id where id = v_check_id;
      if v_successes >= v_site.recovery_threshold then
        update public.incidents set status = 'closed', resolved_at = v_now,
          last_check_id = v_check_id where id = v_incident.id;
        insert into public.audit_events (website_id, incident_id, actor_type, event_type, reason_code)
          values (p_website_id, v_incident.id, 'system', 'incident.closed', 'health_restored');
        v_incident_status := 'closed';
      else
        v_incident_status := v_incident.status;
      end if;
      v_incident_id := v_incident.id;
    end if;
  else
    v_failures := v_site.consecutive_failures + 1;
    v_successes := 0;
    if v_incident.id is not null then
      update public.incidents set consecutive_failures = v_failures,
        last_check_id = v_check_id where id = v_incident.id;
      insert into public.audit_events (website_id, incident_id, actor_type, event_type, reason_code)
        values (p_website_id, v_incident.id, 'system', 'incident.updated', 'check_failed');
      v_incident_id := v_incident.id;
      v_incident_status := v_incident.status;
    elsif v_failures >= v_site.failure_threshold then
      insert into public.incidents (website_id, status, failure_kind, summary,
        consecutive_failures, last_check_id)
      values (p_website_id, 'open', p_failure_kind, 'Monitoring failure threshold reached',
        v_failures, v_check_id) returning id into v_incident_id;
      insert into public.audit_events (website_id, incident_id, actor_type, event_type, reason_code)
        values (p_website_id, v_incident_id, 'system', 'incident.opened', 'failure_threshold');
      v_incident_status := 'open';
    end if;
    if v_incident_id is not null then
      update public.health_checks set incident_id = v_incident_id where id = v_check_id;
    end if;
  end if;

  update public.websites set
    consecutive_failures = v_failures,
    consecutive_successes = v_successes,
    last_checked_at = v_now,
    next_check_at = v_now + (v_site.monitor_interval_seconds * interval '1 second'),
    check_lease_token = null,
    check_lease_expires_at = null
  where id = p_website_id;

  insert into public.audit_events (website_id, incident_id, actor_type, event_type, reason_code,
    metadata_json)
  values (p_website_id, v_incident_id, 'system', 'check.recorded', p_status,
    jsonb_build_object('check_id', v_check_id));

  check_id := v_check_id;
  incident_id := v_incident_id;
  incident_status := v_incident_status;
  return next;
end;
$$;

revoke all on function public.monitor_claim_check(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.monitor_record_check(uuid, uuid, timestamptz, text, integer, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.monitor_claim_check(uuid, text, uuid) to service_role;
grant execute on function public.monitor_record_check(uuid, uuid, timestamptz, text, integer, integer, text, text, text)
  to service_role;
commit;

-- Apply manually after 202610120001_controlled_recovery.sql.
begin;
create function public.agent_set_trace_id(p_run_id uuid, p_trace_id text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_trace_id !~ '^[0-9a-f]{32}$' then
    raise exception 'invalid trace id' using errcode = '22023';
  end if;
  update public.agent_runs set neatlogs_trace_id = p_trace_id
  where id = p_run_id and (neatlogs_trace_id is null or neatlogs_trace_id = p_trace_id);
  if not found then
    raise exception 'run unavailable' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.agent_set_trace_id(uuid, text) from public, anon, authenticated;
grant execute on function public.agent_set_trace_id(uuid, text) to service_role;
commit;

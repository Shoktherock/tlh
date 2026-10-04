begin;
create table public.activity_state(user_id uuid primary key references auth.users(id),revision integer not null default 0,state jsonb not null default '{"version":1,"events":[]}');
create table public.activity_audit(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),revision integer not null,at timestamptz not null default clock_timestamp(),kind text not null,reason text not null,provenance jsonb,unique(user_id,revision));
create table public.prepared_activity(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),created_at timestamptz not null default now(),plan jsonb not null,result jsonb);
alter table public.activity_state enable row level security;
alter table public.activity_audit enable row level security;
alter table public.prepared_activity enable row level security;
revoke all on public.activity_state,public.activity_audit,public.prepared_activity from public,anon,authenticated;
grant select on public.activity_state,public.activity_audit to authenticated;
grant all on public.activity_state,public.activity_audit,public.prepared_activity to service_role;
create policy activity_owner on public.activity_state for select to authenticated using(user_id=auth.uid());
create policy activity_audit_owner on public.activity_audit for select to authenticated using(user_id=auth.uid());
create function public.read_activity(p_user uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('revision',coalesce((select revision from public.activity_state where user_id=p_user),0),'state',coalesce((select state from public.activity_state where user_id=p_user),'{"version":1,"events":[]}'::jsonb),'accounts',public.analysis_input_accounts(p_user),'audit',coalesce((select jsonb_agg(to_jsonb(a) order by revision desc) from (select * from public.activity_audit where user_id=p_user order by revision desc limit 100) a),'[]'::jsonb));
$$;
create function public.prepare_activity(p_user uuid,p_plan jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare prepared uuid;
begin
 if p_plan->'accounts' is distinct from public.analysis_input_accounts(p_user) then raise exception 'Account inventory changed'; end if;
 insert into public.prepared_activity(user_id,plan) values(p_user,p_plan) returning id into prepared;
 return prepared;
end $$;
create function public.commit_activity(p_user uuid,p_prepared uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.prepared_activity; rev integer; next_state jsonb; event_index integer; receipt jsonb; accepted_at timestamptz:=clock_timestamp();
begin
 insert into public.activity_state(user_id) values(p_user) on conflict do nothing;
 select revision into rev from public.activity_state where user_id=p_user for update;
 select * into job from public.prepared_activity where id=p_prepared and user_id=p_user for update;
 if not found then raise exception 'Review unavailable'; end if;
 if job.result is not null then return job.result; end if;
 if job.plan->>'baseRevision' is distinct from rev::text then raise exception 'Review is stale'; end if;
 if job.created_at<now()-interval '24 hours' then raise exception 'Review expired'; end if;
 perform 1 from public.accounts where user_id=p_user order by id for share;
 if job.plan->'accounts' is distinct from public.analysis_input_accounts(p_user) then raise exception 'Account inventory changed'; end if;
 next_state:=job.plan->'after';
 if job.plan->>'kind' <> 'restore' then
  event_index:=jsonb_array_length(next_state->'events')-1;
  next_state:=jsonb_set(next_state,array['events',event_index::text],(next_state->'events'->event_index)||jsonb_build_object('actor',p_user,'at',accepted_at));
 end if;
 insert into public.activity_audit(user_id,revision,kind,reason,provenance) values(p_user,rev+1,job.plan->>'kind',job.plan->>'reason',jsonb_build_object('accounts',job.plan->'accounts','review',job.plan->'review','restoredHash',job.plan->'restoredHash'));
 update public.activity_state set revision=rev+1,state=next_state where user_id=p_user;
 receipt:=jsonb_build_object('revision',rev+1);
 update public.prepared_activity set result=receipt,plan=jsonb_build_object('completed',true) where id=job.id;
 return receipt;
end $$;
revoke all on function public.read_activity(uuid),public.prepare_activity(uuid,jsonb),public.commit_activity(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_activity(uuid),public.prepare_activity(uuid,jsonb),public.commit_activity(uuid,uuid) to service_role;
commit;

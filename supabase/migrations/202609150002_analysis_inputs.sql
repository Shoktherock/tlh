begin;
create table public.analysis_inputs (
 user_id uuid primary key references auth.users(id), revision integer not null default 0 check(revision>=0), input jsonb
);
create table public.analysis_input_events (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 revision integer not null, saved_at timestamptz not null default clock_timestamp(),
 kind text not null check(kind in ('save','restore')), reason text not null,
 input jsonb not null, accounts jsonb not null, provenance jsonb, unique(user_id,revision)
);
create table public.prepared_analysis_inputs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 created_at timestamptz not null default now(), plan jsonb not null, result jsonb
);
alter table public.analysis_inputs enable row level security;
alter table public.analysis_input_events enable row level security;
alter table public.prepared_analysis_inputs enable row level security;
revoke all on public.analysis_inputs,public.analysis_input_events,public.prepared_analysis_inputs from public,anon,authenticated;
grant select on public.analysis_inputs,public.analysis_input_events to authenticated;
grant all on public.analysis_inputs,public.analysis_input_events,public.prepared_analysis_inputs to service_role;
create policy own_analysis_inputs on public.analysis_inputs for select to authenticated using(user_id=auth.uid());
create policy own_analysis_input_events on public.analysis_input_events for select to authenticated using(user_id=auth.uid());

create function public.analysis_input_accounts(p_user uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,'type',a.account_type,'portfolioName',p.name) order by a.id),'[]'::jsonb)
 from public.accounts a join public.portfolios p on p.id=a.portfolio_id where a.user_id=p_user;
$$;
create function public.read_analysis_inputs(p_user uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('revision',coalesce((select revision from public.analysis_inputs where user_id=p_user),0),
 'input',(select input from public.analysis_inputs where user_id=p_user),'accounts',public.analysis_input_accounts(p_user),
 'history',coalesce((select jsonb_agg(to_jsonb(e) order by revision desc) from (select id,user_id,revision,saved_at,kind,reason,input,accounts,provenance from public.analysis_input_events where user_id=p_user order by revision desc limit 50) e),'[]'::jsonb));
$$;
create function public.prepare_analysis_inputs(p_user uuid,p_plan jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare prepared uuid;
begin
 if p_plan->'accounts' is distinct from public.analysis_input_accounts(p_user) then raise exception 'Account inventory changed'; end if;
 insert into public.prepared_analysis_inputs(user_id,plan) values(p_user,p_plan) returning id into prepared;
 return prepared;
end $$;
create function public.commit_analysis_inputs(p_user uuid,p_prepared uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.prepared_analysis_inputs; rev integer; receipt jsonb; event_id uuid;
begin
 insert into public.analysis_inputs(user_id) values(p_user) on conflict do nothing;
 select revision into rev from public.analysis_inputs where user_id=p_user for update;
 select * into job from public.prepared_analysis_inputs where id=p_prepared and user_id=p_user for update;
 if not found then raise exception 'Review unavailable'; end if;
 if job.result is not null then return job.result; end if;
 if job.plan->>'baseRevision' is distinct from rev::text then raise exception 'Review is stale'; end if;
 if job.created_at<now()-interval '24 hours' then raise exception 'Review expired'; end if;
 perform 1 from public.accounts where user_id=p_user order by id for share;
 if job.plan->'accounts' is distinct from public.analysis_input_accounts(p_user) then raise exception 'Account inventory changed'; end if;
 insert into public.analysis_input_events(user_id,revision,kind,reason,input,accounts,provenance) values(p_user,rev+1,job.plan->>'kind',job.plan->>'reason',job.plan->'after',job.plan->'accounts',job.plan->'provenance') returning id into event_id;
 update public.analysis_inputs set revision=rev+1,input=job.plan->'after' where user_id=p_user;
 receipt=jsonb_build_object('revision',rev+1,'eventId',event_id);
 update public.prepared_analysis_inputs set result=receipt,plan=jsonb_build_object('completed',true) where id=job.id;
 return receipt;
end $$;
revoke all on function public.analysis_input_accounts(uuid),public.read_analysis_inputs(uuid),public.prepare_analysis_inputs(uuid,jsonb),public.commit_analysis_inputs(uuid,uuid) from public,anon,authenticated;
grant execute on function public.analysis_input_accounts(uuid),public.read_analysis_inputs(uuid),public.prepare_analysis_inputs(uuid,jsonb),public.commit_analysis_inputs(uuid,uuid) to service_role;
commit;

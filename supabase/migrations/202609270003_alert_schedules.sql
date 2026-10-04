create table public.alert_schedules (
 user_id uuid primary key references auth.users(id), enabled boolean not null default false,
 revision integer not null default 1, next_run timestamptz not null default now(),
 lease_id uuid, lease_until timestamptz, last_attempt timestamptz, last_success timestamptz,
 failures integer not null default 0, last_error text
);
alter table public.alert_schedules enable row level security;
revoke all on public.alert_schedules from anon,authenticated,service_role;
grant select on public.alert_schedules to authenticated,service_role;
create policy alert_schedule_owner on public.alert_schedules for select to authenticated using(user_id=auth.uid());
create function public.save_alert_schedule(p_user uuid,p_revision integer,p_enabled boolean) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare r integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,71));
 select revision into r from alert_schedules where user_id=p_user for update;
 if coalesce(r,0)<>p_revision then raise exception 'Schedule changed. Reload first.';end if;
 insert into alert_schedules(user_id,enabled,revision) values(p_user,p_enabled,p_revision+1)
 on conflict(user_id) do update set enabled=p_enabled,revision=p_revision+1,next_run=now(),lease_id=null,lease_until=null;
 return p_revision+1;
end $$;
create function public.claim_alert_schedule() returns setof public.alert_schedules language plpgsql security definer set search_path=public,pg_temp as $$
begin
 return query with due as (
 select user_id from alert_schedules where enabled and next_run<=now() and (lease_until is null or lease_until<=now()) order by next_run for update skip locked limit 1
 ) update alert_schedules s set lease_id=gen_random_uuid(),lease_until=now()+interval '10 minutes',last_attempt=now()
 from due where s.user_id=due.user_id returning s.*;
end $$;
create function public.finish_alert_schedule(p_user uuid,p_lease uuid,p_success boolean) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update alert_schedules set lease_id=null,lease_until=null,
 last_success=case when p_success then now() else last_success end,
 failures=case when p_success then 0 else least(failures+1,10) end,
 last_error=case when p_success then null else 'Automatic check failed. Previous alerts were retained; retry is scheduled.' end,
 next_run=now()+case when p_success then interval '1 day' else interval '5 minutes'*power(2,least(failures,6)) end
 where user_id=p_user and lease_id=p_lease;
 return found;
end $$;
revoke all on function public.save_alert_schedule(uuid,integer,boolean),public.claim_alert_schedule(),public.finish_alert_schedule(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.save_alert_schedule(uuid,integer,boolean),public.claim_alert_schedule(),public.finish_alert_schedule(uuid,uuid,boolean) to service_role;

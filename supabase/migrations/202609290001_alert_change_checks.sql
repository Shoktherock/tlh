create table public.alert_worker_health(id boolean primary key default true check(id),last_seen timestamptz not null);
alter table public.alert_worker_health enable row level security;
revoke all on public.alert_worker_health from public,anon,authenticated,service_role;
grant select on public.alert_worker_health to service_role;
create function public.alert_worker_heartbeat() returns void language sql security definer set search_path=public,pg_temp as $$
 insert into alert_worker_health(id,last_seen) values(true,now()) on conflict(id) do update set last_seen=now();
$$;
revoke all on function public.alert_worker_heartbeat() from public,anon,authenticated;
grant execute on function public.alert_worker_heartbeat() to service_role;
alter table public.alert_schedules add column change_generation bigint not null default 0, add column claimed_generation bigint;
create or replace function public.claim_alert_schedule() returns setof public.alert_schedules language plpgsql security definer set search_path=public,pg_temp as $$
begin
 return query with due as (
 select user_id from alert_schedules where enabled and next_run<=now() and (lease_until is null or lease_until<=now()) order by next_run for update skip locked limit 1
 ) update alert_schedules s set lease_id=gen_random_uuid(),lease_until=now()+interval '10 minutes',last_attempt=now(),claimed_generation=change_generation
 from due where s.user_id=due.user_id returning s.*;
end $$;
create or replace function public.finish_alert_schedule(p_user uuid,p_lease uuid,p_success boolean) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update alert_schedules set lease_id=null,lease_until=null,
 last_success=case when p_success then now() else last_success end,
 failures=case when p_success then 0 else least(failures+1,10) end,
 last_error=case when p_success then null else 'Automatic check failed. Previous alerts were retained; retry is scheduled.' end,
 next_run=case when p_success and change_generation<>claimed_generation then now() else now()+case when p_success then interval '1 day' else interval '5 minutes'*power(2,least(failures,6)) end end
 where user_id=p_user and lease_id=p_lease;
 return found;
end $$;
create function public.queue_alert_evidence_change() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update alert_schedules set next_run=case when failures>0 then next_run else least(next_run,now()) end,change_generation=change_generation+1
 where enabled and user_id=new.user_id;
 return new;
end $$;
create function public.queue_alert_price_change() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update alert_schedules set next_run=case when failures>0 then next_run else least(next_run,now()) end,change_generation=change_generation+1 where enabled;
 return new;
end $$;
revoke all on function public.queue_alert_evidence_change(),public.queue_alert_price_change() from public,anon,authenticated;
create trigger alert_holdings_change after update of revision on public.import_revisions for each row when(old.revision is distinct from new.revision) execute function public.queue_alert_evidence_change();
create trigger alert_activity_change after update of revision on public.activity_state for each row when(old.revision is distinct from new.revision) execute function public.queue_alert_evidence_change();
create trigger alert_review_change after insert on public.sale_reviews for each row execute function public.queue_alert_evidence_change();
create trigger alert_preference_change after insert or update on public.alert_preferences for each row execute function public.queue_alert_evidence_change();
create trigger alert_price_change after insert or update on public.massive_daily_cache for each row execute function public.queue_alert_price_change();

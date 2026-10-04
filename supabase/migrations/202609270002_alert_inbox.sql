create table public.alert_preferences(user_id uuid primary key references auth.users(id),revision integer not null default 1,preferences jsonb not null);
create table public.alert_inbox(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),alert_key text not null,
 category text not null check(category in ('opportunity','data','tracking')),fingerprint text not null,payload jsonb not null,
 version integer not null default 1,active boolean not null default true,acknowledged boolean not null default false,
 snoozed_until timestamptz,first_seen timestamptz not null default now(),last_seen timestamptz not null default now(),
 unique(user_id,alert_key)
);
create table public.alert_scans(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),at timestamptz not null default now(),conditions integer not null,evaluated jsonb not null,holdings_revision integer not null,activity_revision integer not null);
create table public.alert_actions(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),alert_id uuid not null references public.alert_inbox(id),version integer not null,choice text not null,at timestamptz not null default now());
alter table public.alert_preferences enable row level security;
alter table public.alert_inbox enable row level security;
alter table public.alert_scans enable row level security;
alter table public.alert_actions enable row level security;
revoke all on public.alert_preferences,public.alert_inbox,public.alert_scans,public.alert_actions from anon,authenticated,service_role;
grant select on public.alert_preferences,public.alert_inbox,public.alert_scans,public.alert_actions to authenticated,service_role;
create policy alert_preference_owner on public.alert_preferences for select to authenticated using(user_id=auth.uid());
create policy alert_owner on public.alert_inbox for select to authenticated using(user_id=auth.uid());
create policy alert_scan_owner on public.alert_scans for select to authenticated using(user_id=auth.uid());
create policy alert_action_owner on public.alert_actions for select to authenticated using(user_id=auth.uid());
create function public.save_alert_preferences(p_user uuid,p_revision integer,p_preferences jsonb) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare r integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,71));
 select revision into r from alert_preferences where user_id=p_user;
 if coalesce(r,0)<>p_revision then raise exception 'Alert preferences changed. Reload first.';end if;
 insert into alert_preferences(user_id,revision,preferences) values(p_user,p_revision+1,p_preferences) on conflict(user_id) do update set revision=excluded.revision,preferences=excluded.preferences;
 return p_revision+1;
end $$;
create function public.commit_alert_scan(p_user uuid,p_preferences_revision integer,p_holdings integer,p_activity integer,p_alerts jsonb,p_evaluated jsonb) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r integer;a jsonb;existing alert_inbox;changed boolean;scan_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,71));
 select revision into r from alert_preferences where user_id=p_user;
 if coalesce(r,0)<>p_preferences_revision then raise exception 'Alert preferences changed. Check again.';end if;
 insert into import_revisions(user_id) values(p_user) on conflict do nothing;
 select revision into r from import_revisions where user_id=p_user for update;
 if r<>p_holdings then raise exception 'Holdings changed. Check again.';end if;
 insert into activity_state(user_id) values(p_user) on conflict do nothing;
 select revision into r from activity_state where user_id=p_user for update;
 if r<>p_activity then raise exception 'Activity changed. Check again.';end if;
 if jsonb_array_length(p_alerts)>2000 then raise exception 'Alert limit exceeded';end if;
 for a in select * from jsonb_array_elements(p_alerts) loop
  select * into existing from alert_inbox where user_id=p_user and alert_key=a->>'key' for update;
  if not found then
   insert into alert_inbox(user_id,alert_key,category,fingerprint,payload) values(p_user,a->>'key',a->>'category',a->>'fingerprint',a);
  else
   changed:=not existing.active or existing.fingerprint<>a->>'fingerprint';
   update alert_inbox set payload=a,fingerprint=a->>'fingerprint',active=true,last_seen=now(),version=version+case when changed then 1 else 0 end,acknowledged=case when changed then false else acknowledged end,snoozed_until=case when changed then null else snoozed_until end where id=existing.id;
  end if;
 end loop;
 update alert_inbox set active=false where user_id=p_user and active and coalesce((p_evaluated->>category)::boolean,false) and not exists(select 1 from jsonb_array_elements(p_alerts) as candidate(value) where candidate.value->>'key'=alert_key);
 if (select count(*) from alert_inbox where user_id=p_user)>2000 then raise exception 'Alert inbox limit exceeded; scan was not saved.';end if;
 insert into alert_scans(user_id,conditions,evaluated,holdings_revision,activity_revision) values(p_user,jsonb_array_length(p_alerts),p_evaluated,p_holdings,p_activity) returning id into scan_id;
 return scan_id;
end $$;
create function public.act_on_alert(p_user uuid,p_id uuid,p_version integer,p_choice text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a alert_inbox;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,71));
 select * into a from alert_inbox where id=p_id and user_id=p_user for update;
 if not found or not a.active or a.version<>p_version then raise exception 'Alert changed or unavailable. Reload first.';end if;
 if p_choice not in ('acknowledge','snooze','reopen') then raise exception 'Unknown alert action';end if;
 update alert_inbox set acknowledged=p_choice='acknowledge',snoozed_until=case when p_choice='snooze' then now()+interval '1 day' else null end where id=p_id;
 insert into alert_actions(user_id,alert_id,version,choice) values(p_user,p_id,p_version,p_choice);
 return true;
end $$;
revoke all on function public.save_alert_preferences(uuid,integer,jsonb),public.commit_alert_scan(uuid,integer,integer,integer,jsonb,jsonb),public.act_on_alert(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.save_alert_preferences(uuid,integer,jsonb),public.commit_alert_scan(uuid,integer,integer,integer,jsonb,jsonb),public.act_on_alert(uuid,uuid,integer,text) to service_role;

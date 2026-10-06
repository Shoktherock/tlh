begin;
create table public.data_deletions(user_id uuid primary key references auth.users(id) on delete cascade, token uuid not null default gen_random_uuid(),status text not null check(status in ('preview','deleting','complete')),summary jsonb not null,fingerprint text not null,paths jsonb not null default '[]',created_at timestamptz not null default now(),completed_at timestamptz);
alter table public.data_deletions enable row level security;
revoke all on public.data_deletions from public,anon,authenticated;
grant select on public.data_deletions to service_role;
create function public.financial_tables() returns text[] language sql immutable set search_path='' as $$ select array['alert_actions','alert_inbox','alert_scans','alert_preferences','alert_schedules','iwv_refresh_status','replacement_strategies','replacement_strategy_events','planning_restores','trade_drafts','sale_reviews','replacement_universes','realized_restore_receipts','realized_reports','prepared_analysis_inputs','analysis_input_events','analysis_inputs','prepared_activity','activity_audit','activity_state','prepared_corrections','correction_events','prepared_restores','restore_receipts','prepared_imports','current_holdings','account_cash','import_batches','quote_mappings','import_sources','import_revisions','accounts','portfolios']; $$;
revoke all on function public.financial_tables() from public,anon,authenticated;
create function public.financial_inventory(p_user uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare t text;n bigint;h text;summary jsonb:='{}';fingerprint text:='';
begin
 foreach t in array financial_tables() loop
 execute format('select count(*),md5(coalesce(string_agg(h, %L order by h), %L)) from (select md5(to_jsonb(r)::text) h from public.%I r where user_id=$1) records','','',t) into n,h using p_user;
 summary:=summary||jsonb_build_object(t,n);fingerprint:=fingerprint||t||h;
 end loop;
 return jsonb_build_object('summary',summary,'fingerprint',md5(fingerprint));
end $$;
revoke all on function public.financial_inventory(uuid) from public,anon,authenticated;
create function public.guard_financial_write() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=case when TG_OP='DELETE' then old.user_id else new.user_id end;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,1710));
 if current_setting('tlh.purge_user',true) is distinct from u::text and exists(select 1 from data_deletions where user_id=u and status in ('deleting','complete')) then raise exception 'Financial data deletion is in progress or complete. Open Data privacy to continue.';end if;
 if TG_OP='DELETE' then return old;else return new;end if;
end $$;
revoke all on function public.guard_financial_write() from public,anon,authenticated;
do $$declare t text;begin foreach t in array public.financial_tables() loop execute format('create trigger financial_write_guard before insert or update or delete on public.%I for each row execute function public.guard_financial_write()',t);end loop;end $$;
create function public.prepare_data_deletion(p_user uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare inventory jsonb;job data_deletions;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1710));
 select * into job from data_deletions where user_id=p_user;
 if job.status in ('deleting','complete') then return to_jsonb(job)-'paths'-'fingerprint';end if;
 inventory:=financial_inventory(p_user);
 insert into data_deletions(user_id,status,summary,fingerprint) values(p_user,'preview',inventory->'summary',inventory->>'fingerprint') on conflict(user_id) do update set token=gen_random_uuid(),status='preview',summary=excluded.summary,fingerprint=excluded.fingerprint,created_at=now() returning * into job;
 return to_jsonb(job)-'paths'-'fingerprint';
end $$;
create function public.begin_data_deletion(p_user uuid,p_token uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare job data_deletions;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1710));
 select * into job from data_deletions where user_id=p_user and token=p_token for update;
 if not found then raise exception 'Deletion preview unavailable. Preview again.';end if;
 if job.status<>'preview' then return to_jsonb(job);end if;
 if job.created_at<now()-interval '15 minutes' or job.fingerprint<>(financial_inventory(p_user)->>'fingerprint') then raise exception 'Data changed or preview expired. Preview deletion again.';end if;
 update alert_schedules set enabled=false where user_id=p_user;
 update data_deletions set status='deleting',paths=coalesce((select jsonb_agg(path) from import_sources where user_id=p_user),'[]') where user_id=p_user returning * into job;
 return to_jsonb(job);
end $$;
create function public.finish_data_deletion(p_user uuid,p_token uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare job data_deletions;t text;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1710));
 select * into job from data_deletions where user_id=p_user and token=p_token for update;
 if not found or job.status='preview' then raise exception 'Deletion has not started.';end if;
 if job.status='complete' then return jsonb_build_object('status','complete');end if;
 if exists(select 1 from storage.objects where bucket_id='import-sources' and name in(select jsonb_array_elements_text(job.paths))) then raise exception 'Original files remain. Retry deletion.';end if;
 perform set_config('tlh.purge_user',p_user::text,true);
 foreach t in array financial_tables() loop execute format('delete from public.%I where user_id=$1',t) using p_user;end loop;
 update data_deletions set status='complete',paths='[]',summary='{}',fingerprint='',completed_at=clock_timestamp() where user_id=p_user;
 return jsonb_build_object('status','complete');
end $$;
create function public.reopen_financial_workspace(p_user uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,1710));
 if exists(select 1 from data_deletions where user_id=p_user and status='deleting') then raise exception 'Finish deletion before starting again.';end if;
 delete from data_deletions where user_id=p_user and status='complete';
end $$;
revoke all on function public.prepare_data_deletion(uuid),public.begin_data_deletion(uuid,uuid),public.finish_data_deletion(uuid,uuid),public.reopen_financial_workspace(uuid) from public,anon,authenticated;
grant execute on function public.prepare_data_deletion(uuid),public.begin_data_deletion(uuid,uuid),public.finish_data_deletion(uuid,uuid),public.reopen_financial_workspace(uuid) to service_role;
-- Upload authorization and deletion synchronize through the same per-user lock.
create function public.guard_private_upload() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid;
begin
 if new.bucket_id<>'import-sources' then return new;end if;
 select user_id into u from import_sources where path=new.name;
 if u is null then raise exception 'Upload reservation unavailable.';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,1710));
 if exists(select 1 from data_deletions where user_id=u and status in ('deleting','complete')) then raise exception 'Uploads disabled during deletion.';end if;
 return new;
end $$;
revoke all on function public.guard_private_upload() from public,anon,authenticated;
create trigger financial_upload_guard before insert or update on storage.objects for each row execute function public.guard_private_upload();
commit;

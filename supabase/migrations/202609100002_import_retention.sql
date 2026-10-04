begin;
create or replace function public.read_import_state(p_user uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',1,'revision',coalesce((select revision from public.import_revisions where user_id=p_user),0),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,'type',a.account_type,'broker',a.broker,'portfolioId',a.portfolio_id,'portfolioName',p.name) order by a.created_at,a.id) from public.accounts a join public.portfolios p on p.id=a.portfolio_id where a.user_id=p_user),'[]'::jsonb),
 'holdings',coalesce((select jsonb_object_agg(account_id,holdings) from (select account_id,jsonb_object_agg(symbol,holding) holdings from public.current_holdings where user_id=p_user group by account_id) h),'{}'::jsonb),
 'cash',coalesce((select jsonb_object_agg(account_id,observation) from public.account_cash where user_id=p_user),'{}'::jsonb),
 'imports',coalesce((select jsonb_agg(record order by accepted_at,id) from public.import_batches where user_id=p_user),'[]'::jsonb));
$$;
create or replace function public.commit_import(p_user uuid,p_prepared uuid,p_revision integer,p_record jsonb,p_holdings jsonb,p_cash jsonb,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.prepared_imports; current_revision integer; item record; kind text;
begin
 insert into public.import_revisions(user_id) values(p_user) on conflict do nothing;
 select revision into current_revision from public.import_revisions where user_id=p_user for update;
 select * into job from public.prepared_imports where id=p_prepared and user_id=p_user for update;
 if not found then raise exception 'Preview unavailable'; end if;
 if job.result is not null then return job.result; end if;
 if current_revision<>p_revision or (job.plan->>'baseRevision')::integer<>p_revision then raise exception 'This preview is stale. Refresh it before accepting.'; end if;
 if job.created_at<now()-interval '24 hours' then raise exception 'Preview expired. Build it again.'; end if;
 select account_type into kind from public.accounts where id=job.account_id and user_id=p_user for share;
 if kind is null or kind<>job.plan->'options'->>'accountType' then raise exception 'Account classification changed. Refresh the preview.'; end if;
 perform 1 from public.import_sources where id=any(job.source_ids) order by id for update;
 if exists(select 1 from public.import_sources where id=any(job.source_ids) and (user_id<>p_user or status<>'prepared')) then raise exception 'Uploads were discarded. Build a new preview.'; end if;
 if p_record is not null then
   if (p_record->>'accountId')::uuid<>job.account_id then raise exception 'Invalid target account'; end if;
   insert into public.import_batches(id,user_id,account_id,record) values((p_record->>'id')::uuid,p_user,job.account_id,p_record);
   for item in select * from jsonb_each(p_holdings) loop
     insert into public.current_holdings(user_id,account_id,symbol,holding) values(p_user,job.account_id,item.key,item.value)
       on conflict(account_id,symbol) do update set holding=excluded.holding;
   end loop;
   if p_cash is not null then
     insert into public.account_cash(user_id,account_id,observation) values(p_user,job.account_id,p_cash)
       on conflict(account_id) do update set observation=excluded.observation;
   end if;
   update public.import_revisions set revision=revision+1 where user_id=p_user;
   update public.import_sources set status='accepted' where id=any(job.source_ids);
 else
   -- A duplicate has no new audit record; release its redundant upload for cleanup.
   update public.import_sources set status='staged' where id=any(job.source_ids);
 end if;
 update public.prepared_imports set result=p_result, plan=jsonb_build_object('completed',true) where id=p_prepared;
 return p_result;
end;$$;
create or replace function public.discard_import_sources(p_user uuid) returns setof public.import_sources language plpgsql security definer set search_path='' as $$
declare discarded_ids uuid[];
begin
  with changed as (update public.import_sources set status='deleting' where user_id=p_user and status in ('staged','prepared','deleting') returning id)
    select array_agg(id) into discarded_ids from changed;
  update public.prepared_imports set plan=jsonb_build_object('discarded',true) where user_id=p_user and discarded_ids && prepared_imports.source_ids;
  return query select * from public.import_sources where id=any(discarded_ids) and user_id=p_user;
end;$$;
commit;

begin;
create table public.prepared_restores(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 source_id uuid not null references public.import_sources(id), fingerprint text not null,
 plan jsonb not null, result jsonb, created_at timestamptz not null default now()
);
create table public.restore_receipts(
 user_id uuid not null references auth.users(id), fingerprint text not null,
 result jsonb not null, primary key(user_id,fingerprint)
);
alter table public.prepared_restores enable row level security;
alter table public.restore_receipts enable row level security;
revoke all on public.prepared_restores,public.restore_receipts from public,anon,authenticated;
grant all on public.prepared_restores,public.restore_receipts to service_role;

create function public.prepare_restore(p_user uuid,p_source uuid,p_plan jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare prepared uuid;
begin
 perform 1 from public.import_sources where id=p_source and user_id=p_user and status='staged' for update;
 if not found then raise exception 'Backup upload unavailable'; end if;
 insert into public.prepared_restores(user_id,source_id,fingerprint,plan) values(p_user,p_source,p_plan->>'fingerprint',p_plan) returning id into prepared;
 update public.import_sources set status='prepared' where id=p_source;
 return prepared;
end;$$;

create function public.commit_restore(p_user uuid,p_prepared uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.prepared_restores; rev integer; target jsonb; batch jsonb; item record; account_item record; receipt jsonb; kind text;
begin
 insert into public.import_revisions(user_id) values(p_user) on conflict do nothing;
 select revision into rev from public.import_revisions where user_id=p_user for update;
 select * into job from public.prepared_restores where id=p_prepared and user_id=p_user for update;
 if not found then raise exception 'Restore preview unavailable'; end if;
 if job.result is not null then return job.result; end if;
 select result into receipt from public.restore_receipts where user_id=p_user and fingerprint=job.fingerprint;
 if found then return receipt || jsonb_build_object('duplicate',true); end if;
 if (job.plan->>'baseRevision')::integer is distinct from rev then raise exception 'This restore preview is stale. Build it again.'; end if;
 if job.created_at<now()-interval '24 hours' then raise exception 'Restore preview expired'; end if;
 for target in select value from jsonb_array_elements(job.plan->'targets') order by value->>'id' loop
   select account_type into kind from public.accounts where id=(target->>'id')::uuid and user_id=p_user for update;
   if kind is null or kind<>target->>'type' then raise exception 'Account classification changed'; end if;
   if exists(select 1 from public.current_holdings where account_id=(target->>'id')::uuid)
     or exists(select 1 from public.account_cash where account_id=(target->>'id')::uuid)
     or exists(select 1 from public.import_batches where account_id=(target->>'id')::uuid) then raise exception 'Destination must be empty'; end if;
 end loop;
 perform 1 from public.import_sources where id=job.source_id and user_id=p_user and status='prepared' for update;
 if not found then raise exception 'Backup upload was discarded'; end if;
 for batch in select value from jsonb_array_elements(job.plan->'imports') loop
   insert into public.import_batches(id,user_id,account_id,record) values((batch->>'id')::uuid,p_user,(batch->>'accountId')::uuid,batch);
 end loop;
 for account_item in select * from jsonb_each(job.plan->'holdings') loop
   for item in select * from jsonb_each(account_item.value) loop
     insert into public.current_holdings(user_id,account_id,symbol,holding) values(p_user,account_item.key::uuid,item.key,item.value);
   end loop;
 end loop;
 for item in select * from jsonb_each(job.plan->'cash') loop
   insert into public.account_cash(user_id,account_id,observation) values(p_user,item.key::uuid,item.value);
 end loop;
 update public.import_sources set status='accepted' where id=job.source_id;
 update public.import_revisions set revision=rev+jsonb_array_length(job.plan->'imports') where user_id=p_user;
 receipt=jsonb_build_object('duplicate',false,'restoredImports',jsonb_array_length(job.plan->'imports'));
 insert into public.restore_receipts(user_id,fingerprint,result) values(p_user,job.fingerprint,receipt);
 update public.prepared_restores set result=receipt,plan=jsonb_build_object('completed',true) where id=job.id;
 return receipt;
end;$$;

create or replace function public.discard_import_sources(p_user uuid) returns setof public.import_sources language plpgsql security definer set search_path='' as $$
declare discarded_ids uuid[];
begin
 with changed as (update public.import_sources set status='deleting' where user_id=p_user and status in ('staged','prepared','deleting') returning id)
   select array_agg(id) into discarded_ids from changed;
 update public.prepared_imports set plan=jsonb_build_object('discarded',true) where user_id=p_user and discarded_ids && prepared_imports.source_ids and result is null;
 update public.prepared_restores set plan=jsonb_build_object('discarded',true) where user_id=p_user and source_id=any(discarded_ids) and result is null;
 return query select * from public.import_sources where id=any(discarded_ids) and user_id=p_user;
end;$$;
revoke all on function public.prepare_restore(uuid,uuid,jsonb),public.commit_restore(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_restore(uuid,uuid,jsonb),public.commit_restore(uuid,uuid) to service_role;
commit;

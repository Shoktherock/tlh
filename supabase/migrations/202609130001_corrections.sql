begin;
create table public.correction_events(
 id uuid primary key, user_id uuid not null references auth.users(id), account_id uuid not null,
 symbol text not null, record jsonb not null,
 foreign key(account_id,user_id) references public.accounts(id,user_id)
);
create table public.prepared_corrections(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 account_id uuid not null, plan jsonb not null, result jsonb, created_at timestamptz not null default now(),
 foreign key(account_id,user_id) references public.accounts(id,user_id)
);
alter table public.correction_events enable row level security;
alter table public.prepared_corrections enable row level security;
create policy own_corrections on public.correction_events for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.correction_events,public.prepared_corrections from public,anon,authenticated;
grant select on public.correction_events to authenticated;
grant all on public.correction_events,public.prepared_corrections to service_role;
create or replace function public.read_import_state(p_user uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',1,'revision',coalesce((select revision from public.import_revisions where user_id=p_user),0),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,'type',a.account_type,'broker',a.broker,'portfolioId',a.portfolio_id,'portfolioName',p.name) order by a.created_at,a.id) from public.accounts a join public.portfolios p on p.id=a.portfolio_id where a.user_id=p_user),'[]'::jsonb),
 'holdings',coalesce((select jsonb_object_agg(account_id,holdings) from (select account_id,jsonb_object_agg(symbol,holding) holdings from public.current_holdings where user_id=p_user group by account_id) h),'{}'::jsonb),
 'cash',coalesce((select jsonb_object_agg(account_id,observation) from public.account_cash where user_id=p_user),'{}'::jsonb),
 'corrections',coalesce((select jsonb_agg(record order by (record->>'baseRevision')::integer) from public.correction_events where user_id=p_user),'[]'::jsonb),
 'imports',coalesce((select jsonb_agg(record order by accepted_at,id) from public.import_batches where user_id=p_user),'[]'::jsonb));
$$;

create function public.prepare_correction(p_user uuid,p_plan jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare prepared uuid;
begin
 if not exists(select 1 from public.accounts where id=(p_plan->'record'->>'accountId')::uuid and user_id=p_user)
   or p_plan->'record'->>'actor' is distinct from p_user::text then raise exception 'Invalid correction owner'; end if;
 insert into public.prepared_corrections(user_id,account_id,plan) values(p_user,(p_plan->'record'->>'accountId')::uuid,p_plan) returning id into prepared;
 return prepared;
end;$$;
create function public.commit_correction(p_user uuid,p_prepared uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.prepared_corrections; rev integer; kind text; audit jsonb; receipt jsonb;
begin
 insert into public.import_revisions(user_id) values(p_user) on conflict do nothing;
 select revision into rev from public.import_revisions where user_id=p_user for update;
 select * into job from public.prepared_corrections where id=p_prepared and user_id=p_user for update;
 if not found then raise exception 'Correction preview unavailable'; end if;
 if job.result is not null then return job.result; end if;
 if (job.plan->>'baseRevision')::integer is distinct from rev then raise exception 'Correction preview is stale'; end if;
 if job.created_at<now()-interval '24 hours' then raise exception 'Correction preview expired'; end if;
 select account_type into kind from public.accounts where id=job.account_id and user_id=p_user for share;
 if kind is null or kind<>job.plan->>'accountType' then raise exception 'Account classification changed'; end if;
 if not exists(select 1 from public.current_holdings where account_id=job.account_id and user_id=p_user and symbol=job.plan->'record'->>'symbol') then raise exception 'Holding unavailable'; end if;
 audit=job.plan->'record'||jsonb_build_object('at',clock_timestamp());
 insert into public.correction_events(id,user_id,account_id,symbol,record) values((audit->>'id')::uuid,p_user,job.account_id,audit->>'symbol',audit);
 update public.import_revisions set revision=rev+1 where user_id=p_user;
 receipt=jsonb_build_object('correctionId',audit->>'id');
 update public.prepared_corrections set result=receipt,plan=jsonb_build_object('completed',true) where id=job.id;
 return receipt;
end;$$;
create or replace function public.commit_restore(p_user uuid,p_prepared uuid) returns jsonb language plpgsql security definer set search_path='' as $$
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
 for batch in select value from jsonb_array_elements(coalesce(job.plan->'corrections','[]'::jsonb)) loop
   insert into public.correction_events(id,user_id,account_id,symbol,record) values((batch->>'id')::uuid,p_user,(batch->>'accountId')::uuid,batch->>'symbol',batch);
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
 update public.import_revisions set revision=rev+jsonb_array_length(job.plan->'imports')+jsonb_array_length(coalesce(job.plan->'corrections','[]'::jsonb)) where user_id=p_user;
 receipt=jsonb_build_object('duplicate',false,'restoredImports',jsonb_array_length(job.plan->'imports'),'restoredCorrections',jsonb_array_length(coalesce(job.plan->'corrections','[]'::jsonb)));
 insert into public.restore_receipts(user_id,fingerprint,result) values(p_user,job.fingerprint,receipt);
 update public.prepared_restores set result=receipt,plan=jsonb_build_object('completed',true) where id=job.id;
 return receipt;
end;$$;


revoke all on function public.prepare_correction(uuid,jsonb),public.commit_correction(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_correction(uuid,jsonb),public.commit_correction(uuid,uuid) to service_role;
commit;

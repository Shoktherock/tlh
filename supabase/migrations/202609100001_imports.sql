begin;
alter table public.accounts add constraint accounts_id_owner unique(id,user_id);
create table public.import_revisions(user_id uuid primary key references auth.users(id), revision integer not null default 0 check(revision>=0));
create table public.import_sources(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 path text not null unique, name text not null check(char_length(name) between 1 and 240),
 hash text not null check(hash ~ '^[a-f0-9]{64}$'), bytes integer not null check(bytes between 1 and 26214400),
 status text not null default 'staged' check(status in ('staged','prepared','accepted','deleting')),
 created_at timestamptz not null default now()
);
create index import_sources_owner on public.import_sources(user_id);
create table public.prepared_imports(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 account_id uuid not null, plan jsonb not null, source_ids uuid[] not null,
 created_at timestamptz not null default now(), result jsonb,
 foreign key(account_id,user_id) references public.accounts(id,user_id)
);
create table public.import_batches(
 id uuid primary key, user_id uuid not null references auth.users(id), account_id uuid not null,
 record jsonb not null, accepted_at timestamptz not null default now(),
 foreign key(account_id,user_id) references public.accounts(id,user_id)
);
create index import_batches_owner on public.import_batches(user_id,accepted_at);
create table public.current_holdings(
 user_id uuid not null, account_id uuid not null, symbol text not null, holding jsonb not null,
 primary key(account_id,symbol), foreign key(account_id,user_id) references public.accounts(id,user_id)
);
create index current_holdings_owner on public.current_holdings(user_id);
create table public.account_cash(
 user_id uuid not null, account_id uuid primary key, observation jsonb not null,
 foreign key(account_id,user_id) references public.accounts(id,user_id)
);
alter table public.import_revisions enable row level security;
alter table public.import_sources enable row level security;
alter table public.prepared_imports enable row level security;
alter table public.import_batches enable row level security;
alter table public.current_holdings enable row level security;
alter table public.account_cash enable row level security;
revoke all on public.import_revisions,public.import_sources,public.prepared_imports,public.import_batches,public.current_holdings,public.account_cash from public,anon,authenticated;
grant all on public.import_revisions,public.import_sources,public.prepared_imports,public.import_batches,public.current_holdings,public.account_cash to service_role;
grant select on public.import_sources,public.import_batches,public.current_holdings,public.account_cash to authenticated;
create policy sources_read on public.import_sources for select to authenticated using(user_id=(select auth.uid()) and status<>'deleting');
create policy batches_read on public.import_batches for select to authenticated using(user_id=(select auth.uid()));
create policy holdings_read on public.current_holdings for select to authenticated using(user_id=(select auth.uid()));
create policy cash_read on public.account_cash for select to authenticated using(user_id=(select auth.uid()));
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('import-sources','import-sources',false,26214400,array['application/octet-stream']);
create policy import_source_upload on storage.objects for insert to authenticated with check(
 bucket_id='import-sources' and exists(select 1 from public.import_sources s where s.path=storage.objects.name and s.user_id=(select auth.uid()) and s.status='staged')
);
create policy import_source_read on storage.objects for select to authenticated using(
 bucket_id='import-sources' and exists(select 1 from public.import_sources s where s.path=storage.objects.name and s.user_id=(select auth.uid()) and s.status<>'deleting')
);
-- No client UPDATE or DELETE policy: accepted evidence cannot be overwritten.

create function public.read_import_state(p_user uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',1,'revision',coalesce((select revision from public.import_revisions where user_id=p_user),0),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,'type',a.account_type,'broker',a.broker,'portfolioId',a.portfolio_id) order by a.created_at,a.id) from public.accounts a where a.user_id=p_user),'[]'::jsonb),
 'holdings',coalesce((select jsonb_object_agg(account_id,holdings) from (select account_id,jsonb_object_agg(symbol,holding) holdings from public.current_holdings where user_id=p_user group by account_id) h),'{}'::jsonb),
 'cash',coalesce((select jsonb_object_agg(account_id,observation) from public.account_cash where user_id=p_user),'{}'::jsonb),
 'imports',coalesce((select jsonb_agg(record order by accepted_at,id) from public.import_batches where user_id=p_user),'[]'::jsonb));
$$;
create function public.prepare_import(p_user uuid,p_plan jsonb,p_sources uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare prepared uuid; source_count integer;
begin
 perform 1 from public.accounts where id=(p_plan->'options'->>'accountId')::uuid and user_id=p_user;
 if not found then raise exception 'Target account unavailable'; end if;
 perform 1 from public.import_sources where id=any(p_sources) order by id for update;
 select count(*) into source_count from public.import_sources where id=any(p_sources) and user_id=p_user and status='staged';
 if source_count<>cardinality(p_sources) or source_count=0 then raise exception 'Upload is no longer available'; end if;
 insert into public.prepared_imports(user_id,account_id,plan,source_ids) values(p_user,(p_plan->'options'->>'accountId')::uuid,p_plan,p_sources) returning id into prepared;
 update public.import_sources set status='prepared' where id=any(p_sources);
 return prepared;
end;$$;
create function public.commit_import(p_user uuid,p_prepared uuid,p_revision integer,p_record jsonb,p_holdings jsonb,p_cash jsonb,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 update public.prepared_imports set result=p_result where id=p_prepared;
 return p_result;
end;$$;
create function public.discard_import_sources(p_user uuid) returns setof public.import_sources language sql security definer set search_path='' as $$
 update public.import_sources set status='deleting' where user_id=p_user and status in ('staged','prepared','deleting') returning *;
$$;
revoke all on function public.read_import_state(uuid),public.prepare_import(uuid,jsonb,uuid[]),public.commit_import(uuid,uuid,integer,jsonb,jsonb,jsonb,jsonb),public.discard_import_sources(uuid) from public,anon,authenticated;
grant execute on function public.read_import_state(uuid),public.prepare_import(uuid,jsonb,uuid[]),public.commit_import(uuid,uuid,integer,jsonb,jsonb,jsonb,jsonb),public.discard_import_sources(uuid) to service_role;
commit;

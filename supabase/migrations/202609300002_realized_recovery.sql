alter table public.realized_reports add column provenance jsonb;
create table public.realized_restore_receipts(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),restore_key text not null,restored_at timestamptz not null default now(),report_ids uuid[] not null,unique(user_id,restore_key));
alter table public.realized_restore_receipts enable row level security;
revoke all on public.realized_restore_receipts from anon,authenticated,service_role;
grant select on public.realized_restore_receipts to authenticated,service_role;
create policy realized_restore_owner on public.realized_restore_receipts for select to authenticated using(user_id=auth.uid());
create function public.restore_realized_history(p_user uuid,p_key text,p_records jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare receipt uuid; r jsonb; new_id uuid; ids uuid[]='{}';
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,81));
 select id into receipt from realized_restore_receipts where user_id=p_user and restore_key=p_key;
 if found then return jsonb_build_object('id',receipt,'duplicate',true);end if;
 if jsonb_array_length(p_records)<1 or (select count(*) from realized_reports where user_id=p_user)+jsonb_array_length(p_records)>100 then raise exception 'Report history limit exceeded';end if;
 for r in select * from jsonb_array_elements(p_records) loop
  if not exists(select 1 from accounts where id=(r->>'account_id')::uuid and user_id=p_user and account_type='taxable') then raise exception 'Choose owned taxable accounts';end if;
  if exists(select 1 from realized_reports where user_id=p_user and account_id=(r->>'account_id')::uuid) then raise exception 'Destination history changed. Restore into empty accounts.';end if;
 end loop;
 for r in select * from jsonb_array_elements(p_records) loop
  insert into realized_reports(user_id,account_id,name,source_text,source_hash,fingerprint,document,active,accepted_at,retired_at,retirement_reason,provenance)
  values(p_user,(r->>'account_id')::uuid,r->>'name',r->>'source_text',r->>'source_hash',r->>'fingerprint',r->'document',(r->>'active')::boolean,(r->>'accepted_at')::timestamptz,(r->>'retired_at')::timestamptz,r->>'retirement_reason',(r->'provenance')||jsonb_build_object('restoredAt',now())) returning id into new_id;
  ids=array_append(ids,new_id);
 end loop;
 insert into realized_restore_receipts(user_id,restore_key,report_ids) values(p_user,p_key,ids) returning id into receipt;
 return jsonb_build_object('id',receipt,'duplicate',false);
end $$;
revoke all on function public.restore_realized_history(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.restore_realized_history(uuid,text,jsonb) to service_role;

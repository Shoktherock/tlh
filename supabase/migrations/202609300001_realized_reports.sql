create table public.realized_reports(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),account_id uuid not null references public.accounts(id),
 name text not null,source_text text not null,source_hash text not null,fingerprint text not null,document jsonb not null,
 active boolean not null default true,accepted_at timestamptz not null default now(),retired_at timestamptz,retirement_reason text,
 unique(user_id,account_id,fingerprint)
);
alter table public.realized_reports enable row level security;
revoke all on public.realized_reports from anon,authenticated,service_role;
grant select on public.realized_reports to authenticated,service_role;
create policy realized_owner on public.realized_reports for select to authenticated using(user_id=auth.uid());
create function public.commit_realized(p_user uuid,p_account uuid,p_expected text[],p_name text,p_source text,p_hash text,p_fingerprint text,p_document jsonb,p_replace uuid[]) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare existing uuid;actual text[];overlap_ids uuid[];
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,81));
 if not exists(select 1 from accounts where id=p_account and user_id=p_user and account_type='taxable') then raise exception 'Choose an owned taxable account';end if;
 select array_agg(id::text order by id::text) into actual from realized_reports where user_id=p_user and account_id=p_account and active;
 if coalesce(actual,'{}')<>p_expected then raise exception 'Reports changed. Preview again.';end if;
 select id into existing from realized_reports where user_id=p_user and account_id=p_account and fingerprint=p_fingerprint;
 if found then
  if exists(select 1 from realized_reports where id=existing and active) then return existing;end if;
  raise exception 'This report was retired. Use a new corrected broker export.';
 end if;
 select array_agg(id order by id) into overlap_ids from realized_reports where user_id=p_user and account_id=p_account and active and document->>'start'<=p_document->>'end' and document->>'end'>=p_document->>'start';
 if coalesce(overlap_ids,'{}')<>p_replace then raise exception 'Overlap changed. Preview again.';end if;
 if exists(select 1 from realized_reports where id=any(p_replace) and (document->>'start'<p_document->>'start' or document->>'end'>p_document->>'end')) then raise exception 'New report must cover the full range of replaced reports';end if;
 if (select count(*) from realized_reports where user_id=p_user)>=100 then raise exception 'Report history limit reached';end if;
 update realized_reports set active=false,retired_at=now(),retirement_reason='Replaced by reviewed complete range' where id=any(p_replace);
 insert into realized_reports(user_id,account_id,name,source_text,source_hash,fingerprint,document) values(p_user,p_account,p_name,p_source,p_hash,p_fingerprint,p_document) returning id into existing;
 return existing;
end $$;
create function public.withdraw_realized(p_user uuid,p_id uuid,p_reason text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,81));
 if length(trim(p_reason))<3 or length(p_reason)>1000 then raise exception 'Provide a withdrawal reason';end if;
 update realized_reports set active=false,retired_at=now(),retirement_reason=p_reason where user_id=p_user and id=p_id and active;return found;
end $$;
revoke all on function public.commit_realized(uuid,uuid,text[],text,text,text,text,jsonb,uuid[]),public.withdraw_realized(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.commit_realized(uuid,uuid,text[],text,text,text,text,jsonb,uuid[]),public.withdraw_realized(uuid,uuid,text) to service_role;

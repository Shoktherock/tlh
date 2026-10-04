-- Market observations are separate from immutable brokerage evidence.
create table public.price_cache (
  key text primary key,
  provider text not null check (provider='twelve-data'),
  provider_symbol text not null check (provider_symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,24}$'),
  mic text not null check (mic in ('XNAS','XNYS','ARCX','BATS','XASE')),
  currency text not null check (currency='USD'),
  price text not null check (length(price)<=40 and price ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
  observed_at timestamptz not null,
  fetched_at timestamptz not null,
  check (key='twelve-data:'||provider_symbol||':'||mic||':USD'),
  check (observed_at<=fetched_at)
);
alter table public.price_cache enable row level security;
revoke all on public.price_cache from anon,authenticated;
grant select on public.price_cache to authenticated;
grant all on public.price_cache to service_role;
create policy price_cache_read on public.price_cache for select to authenticated using (auth.uid() is not null);

create table public.quote_mappings (
  user_id uuid not null references auth.users(id),
  account_id uuid not null,
  symbol text not null,
  provider_symbol text not null check (provider_symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,24}$'),
  mic text not null check (mic in ('XNAS','XNYS','ARCX','BATS','XASE')),
  identity text not null,
  primary key (account_id,symbol),
  foreign key (account_id,user_id) references public.accounts(id,user_id)
);
alter table public.quote_mappings enable row level security;
revoke all on public.quote_mappings from anon,authenticated;
grant select on public.quote_mappings to authenticated;
grant all on public.quote_mappings to service_role;
create policy quote_mapping_owner on public.quote_mappings for select to authenticated using (user_id=auth.uid());

-- A provider-wide budget survives worker restarts and serializes concurrent callers.
-- Conservative Basic limits also protect a larger plan until deliberately changed.
create table public.quote_budget (
  id boolean primary key default true check(id),
  minute_start timestamptz not null default now(), minute_count int not null default 0,
  day_start date not null default (now() at time zone 'UTC')::date, day_count int not null default 0
);
insert into public.quote_budget(id) values(true);
create table public.quote_leases (key text primary key, until_at timestamptz not null);
alter table public.quote_budget enable row level security;
alter table public.quote_leases enable row level security;
revoke all on public.quote_budget,public.quote_leases from anon,authenticated;
grant all on public.quote_budget,public.quote_leases to service_role;

create function public.claim_quote_request(p_key text) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.quote_budget; t timestamptz:=clock_timestamp();
begin
  if p_key !~ '^twelve-data:[A-Z0-9][A-Z0-9.-]{0,24}:(XNAS|XNYS|ARCX|BATS|XASE):USD$' then raise exception 'Invalid quote key'; end if;
  select * into b from public.quote_budget where id=true for update;
  delete from public.quote_leases where until_at<=t;
  if exists(select 1 from public.quote_leases where key=p_key) then return 'busy'; end if;
  if t>=b.minute_start+interval '1 minute' then b.minute_start:=t; b.minute_count:=0; end if;
  if (t at time zone 'UTC')::date>b.day_start then b.day_start:=(t at time zone 'UTC')::date; b.day_count:=0; end if;
  if b.minute_count>=8 or b.day_count>=800 then return 'rate_limit'; end if;
  update public.quote_budget set minute_start=b.minute_start,minute_count=b.minute_count+1,day_start=b.day_start,day_count=b.day_count+1 where id=true;
  insert into public.quote_leases values(p_key,t+interval '30 seconds');
  return 'ok';
end $$;
revoke all on function public.claim_quote_request(text) from public,anon,authenticated;
grant execute on function public.claim_quote_request(text) to service_role;

-- An older in-flight response cannot replace a newer market observation.
create function public.save_quote(p_quote jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.price_cache select (jsonb_populate_record(null::public.price_cache,p_quote)).*
  on conflict(key) do update set price=excluded.price,observed_at=excluded.observed_at,fetched_at=excluded.fetched_at
  where excluded.fetched_at>=price_cache.fetched_at and excluded.observed_at>=price_cache.observed_at;
  return (select to_jsonb(q) from public.price_cache q where key=p_quote->>'key');
end
$$;
revoke all on function public.save_quote(jsonb) from public,anon,authenticated;
grant execute on function public.save_quote(jsonb) to service_role;

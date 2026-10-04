-- Whole-market daily observations contain no account or user identifiers.
create table public.massive_daily_cache (
  price_date date primary key,
  fetched_at timestamptz not null,
  prices jsonb not null check(jsonb_typeof(prices)='object')
);
create table public.massive_budget (
  id boolean primary key default true check(id),
  minute_start timestamptz not null default now(),
  minute_count integer not null default 0,
  lease_until timestamptz not null default '-infinity'
);
insert into public.massive_budget(id) values(true);
alter table public.massive_daily_cache enable row level security;
alter table public.massive_budget enable row level security;
revoke all on public.massive_daily_cache,public.massive_budget from anon,authenticated;
grant all on public.massive_daily_cache,public.massive_budget to service_role;
create function public.claim_massive_request() returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.massive_budget; t timestamptz:=clock_timestamp();
begin
  select * into b from public.massive_budget where id=true for update;
  if b.lease_until>t then return 'busy'; end if;
  if t>=b.minute_start+interval '1 minute' then b.minute_start:=t;b.minute_count:=0;end if;
  if b.minute_count>=5 then return 'rate_limit';end if;
  update public.massive_budget set minute_start=b.minute_start,minute_count=b.minute_count+1,lease_until=t+interval '60 seconds' where id=true;
  return 'ok';
end $$;
revoke all on function public.claim_massive_request() from public,anon,authenticated;
grant execute on function public.claim_massive_request() to service_role;

-- Public market evidence only, written through authenticated service endpoints.
create table public.replacement_metric_cache (
 symbol text not null, as_of date not null, kind text not null check(kind in ('profile','history')),
 payload jsonb not null, fetched_at timestamptz not null default now(),
 primary key(symbol,as_of,kind)
);
alter table public.replacement_metric_cache enable row level security;
revoke all on public.replacement_metric_cache from anon,authenticated;
grant select,insert,update on public.replacement_metric_cache to service_role;

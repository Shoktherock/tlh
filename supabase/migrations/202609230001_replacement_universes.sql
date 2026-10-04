create table public.replacement_universes (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 hash text not null check(hash ~ '^[0-9a-f]{64}$'), name text not null, benchmark text not null,
 provenance text not null check(provenance in ('official','curated','fund-proxy','synthetic')),
 as_of date not null, valid_through date not null check(valid_through>=as_of), member_count int not null check(member_count between 1 and 5000),
 source_name text not null, source_text text not null check(octet_length(source_text)<=2097152),
 document jsonb not null, accepted_at timestamptz not null default now(),
 unique(user_id,hash), unique(id,user_id)
);
create table public.replacement_strategies (
 portfolio_id uuid primary key, user_id uuid not null, universe_id uuid not null,
 revision bigint not null default 1, exclusions jsonb not null default '[]', updated_at timestamptz not null default now(),
 foreign key(portfolio_id,user_id) references public.portfolios(id,user_id),
 foreign key(universe_id,user_id) references public.replacement_universes(id,user_id)
);
create table public.replacement_strategy_events (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, portfolio_id uuid not null,
 revision bigint not null, universe_id uuid not null, exclusions jsonb not null, at timestamptz not null default now(),
 unique(portfolio_id,revision), foreign key(portfolio_id,user_id) references public.portfolios(id,user_id)
);
alter table public.replacement_universes enable row level security;
alter table public.replacement_strategies enable row level security;
alter table public.replacement_strategy_events enable row level security;
revoke all on public.replacement_universes,public.replacement_strategies,public.replacement_strategy_events from anon,authenticated;
grant select on public.replacement_universes,public.replacement_strategies,public.replacement_strategy_events to authenticated;
grant select,insert on public.replacement_universes,public.replacement_strategy_events to service_role;
grant select,insert,update on public.replacement_strategies to service_role;
create policy universe_owner on public.replacement_universes for select to authenticated using(user_id=auth.uid());
create policy strategy_owner on public.replacement_strategies for select to authenticated using(user_id=auth.uid());
create policy strategy_event_owner on public.replacement_strategy_events for select to authenticated using(user_id=auth.uid());
create function public.save_replacement_strategy(p_user uuid,p_portfolio uuid,p_universe uuid,p_revision bigint,p_exclusions jsonb)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint; next_revision bigint;
begin
  perform 1 from public.portfolios where id=p_portfolio and user_id=p_user for update;
  if not found then raise exception 'Portfolio unavailable';end if;
  perform 1 from public.replacement_universes where id=p_universe and user_id=p_user;
  if not found then raise exception 'Universe unavailable';end if;
  select revision into current_revision from public.replacement_strategies where portfolio_id=p_portfolio;
  if coalesce(current_revision,0)<>p_revision then raise exception 'Stale strategy';end if;
  if jsonb_typeof(p_exclusions)<>'array' or jsonb_array_length(p_exclusions)>5000 then raise exception 'Invalid exclusions';end if;
  next_revision:=p_revision+1;
  insert into public.replacement_strategies(portfolio_id,user_id,universe_id,revision,exclusions)
  values(p_portfolio,p_user,p_universe,next_revision,p_exclusions)
  on conflict(portfolio_id) do update set universe_id=excluded.universe_id,revision=excluded.revision,exclusions=excluded.exclusions,updated_at=now();
  insert into public.replacement_strategy_events(user_id,portfolio_id,revision,universe_id,exclusions) values(p_user,p_portfolio,next_revision,p_universe,p_exclusions);
  return next_revision;
end $$;
revoke all on function public.save_replacement_strategy(uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.save_replacement_strategy(uuid,uuid,uuid,bigint,jsonb) to service_role;

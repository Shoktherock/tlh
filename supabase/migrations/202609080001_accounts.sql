-- Phase 4B.1: ownership only. No brokerage evidence is uploaded by this migration.
begin;
create table public.portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (id, user_id), unique (user_id, name)
);
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  user_id uuid not null references auth.users(id),
  label text not null check (label = btrim(label) and char_length(label) between 1 and 100),
  broker text not null check (broker = btrim(broker) and char_length(broker) between 1 and 80),
  masked_identifier text check (masked_identifier ~ '^[0-9]{4}$'),
  account_type text not null default 'unknown' check (account_type in ('taxable','traditional_ira','roth_ira','other','unknown')),
  created_at timestamptz not null default now(),
  foreign key (portfolio_id, user_id) references public.portfolios(id, user_id),
  unique (portfolio_id, label)
);
create index accounts_owner_idx on public.accounts(user_id);
alter table public.portfolios enable row level security;
alter table public.accounts enable row level security;
revoke all on public.portfolios, public.accounts from public, anon, authenticated;
grant select on public.portfolios, public.accounts to authenticated;
grant insert (user_id, name) on public.portfolios to authenticated;
grant update (name) on public.portfolios to authenticated;
grant insert (portfolio_id, user_id, label, broker, masked_identifier, account_type) on public.accounts to authenticated;
grant update (label, broker, masked_identifier, account_type) on public.accounts to authenticated;
create policy portfolios_read on public.portfolios for select to authenticated using (user_id = (select auth.uid()));
create policy portfolios_create on public.portfolios for insert to authenticated with check (user_id = (select auth.uid()));
create policy portfolios_edit on public.portfolios for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy accounts_read on public.accounts for select to authenticated using (user_id = (select auth.uid()));
create policy accounts_create on public.accounts for insert to authenticated with check (user_id = (select auth.uid()));
create policy accounts_edit on public.accounts for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
commit;

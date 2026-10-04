create table public.trade_drafts (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),
 evidence_hash text not null check(evidence_hash ~ '^[0-9a-f]{64}$'),
 evidence jsonb not null check(jsonb_typeof(evidence)='object'),
 saved_at timestamptz not null default now(),unique(user_id,evidence_hash)
);
alter table public.trade_drafts enable row level security;
revoke all on public.trade_drafts from anon,authenticated;
grant select on public.trade_drafts to authenticated;
revoke all on public.trade_drafts from service_role;
grant select,insert on public.trade_drafts to service_role;
create policy draft_owner on public.trade_drafts for select to authenticated using(user_id=auth.uid());

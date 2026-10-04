create table public.iwv_refresh_status (
 portfolio_id uuid primary key, user_id uuid not null, checked_at timestamptz not null,
 next_check_at timestamptz not null, status text not null, message text not null, snapshot_date date,
 foreign key(portfolio_id,user_id) references public.portfolios(id,user_id)
);
alter table public.iwv_refresh_status enable row level security;
revoke all on public.iwv_refresh_status from anon,authenticated;
grant select on public.iwv_refresh_status to authenticated;
grant select,insert,update on public.iwv_refresh_status to service_role;
create policy iwv_status_owner on public.iwv_refresh_status for select to authenticated using(user_id=auth.uid());

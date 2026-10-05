begin;
create table public.api_request_usage (
 user_id uuid primary key references auth.users(id) on delete cascade,
 minute_start timestamptz not null, minute_count integer not null,
 hour_start timestamptz not null, hour_count integer not null
);
alter table public.api_request_usage enable row level security;
revoke all on public.api_request_usage from public, anon, authenticated;
create function public.consume_api_quota(p_user uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare t timestamptz:=clock_timestamp(); m timestamptz:=date_trunc('minute',t); h timestamptz:=date_trunc('hour',t); used api_request_usage;
begin
 insert into api_request_usage values(p_user,m,0,h,0) on conflict do nothing;
 select * into used from api_request_usage where user_id=p_user for update;
 if used.minute_start<>m then used.minute_start:=m;used.minute_count:=0;end if;
 if used.hour_start<>h then used.hour_start:=h;used.hour_count:=0;end if;
 if used.minute_count>=120 or used.hour_count>=2000 then return false;end if;
 update api_request_usage set minute_start=m,minute_count=used.minute_count+1,hour_start=h,hour_count=used.hour_count+1 where user_id=p_user;
 return true;
end $$;
revoke all on function public.consume_api_quota(uuid) from public,anon,authenticated;
grant execute on function public.consume_api_quota(uuid) to service_role;
-- Charge each reserved object at the bucket's maximum size, including tiny metadata claims.
-- At most 40 objects (1 GiB) per UTC day, and 200 retained objects (5 GiB) per user.
create table public.upload_daily_usage(user_id uuid primary key references auth.users(id) on delete cascade, day date not null, count integer not null);
alter table public.upload_daily_usage enable row level security;
revoke all on public.upload_daily_usage from public,anon,authenticated;
create function public.limit_import_reservations() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare total bigint; recent bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,1705));
 select count(*) into total from import_sources where user_id=new.user_id;
 insert into upload_daily_usage values(new.user_id,(clock_timestamp() at time zone 'UTC')::date,0) on conflict do nothing;
 update upload_daily_usage set day=(clock_timestamp() at time zone 'UTC')::date,count=0 where user_id=new.user_id and day<>(clock_timestamp() at time zone 'UTC')::date;
 select count into recent from upload_daily_usage where user_id=new.user_id for update;
 if total>=200 then raise exception 'Stored upload limit reached. Remove unused staged uploads or contact support.';end if;
 if recent>=40 then raise exception 'Daily upload limit reached. Retry tomorrow.';end if;
 update upload_daily_usage set count=count+1 where user_id=new.user_id;
 return new;
end $$;
revoke all on function public.limit_import_reservations() from public,anon,authenticated;
create trigger import_reservation_quota before insert on public.import_sources for each row execute function public.limit_import_reservations();
commit;

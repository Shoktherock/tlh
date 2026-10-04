-- Twelve Data identifies MSFT with the NASDAQ Global Select segment MIC XNGS.
-- Preserve existing mappings and exact exchange matching; do not remap holdings.
alter table public.price_cache drop constraint price_cache_mic_check;
alter table public.price_cache add constraint price_cache_mic_check check (mic in ('XNAS','XNGS','XNYS','ARCX','BATS','XASE'));
alter table public.quote_mappings drop constraint quote_mappings_mic_check;
alter table public.quote_mappings add constraint quote_mappings_mic_check check (mic in ('XNAS','XNGS','XNYS','ARCX','BATS','XASE'));
create or replace function public.claim_quote_request(p_key text) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.quote_budget; t timestamptz:=clock_timestamp();
begin
  if p_key !~ '^twelve-data:[A-Z0-9][A-Z0-9.-]{0,24}:(XNAS|XNGS|XNYS|ARCX|BATS|XASE):USD$' then raise exception 'Invalid quote key'; end if;
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

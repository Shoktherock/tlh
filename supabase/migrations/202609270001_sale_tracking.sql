create table public.sale_reviews(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 sale_id uuid not null,evidence_hash text not null check(evidence_hash ~ '^[a-f0-9]{64}$'), evidence jsonb not null,
 disposition text not null check(disposition in ('reviewed','closed')),note text not null check(length(note) between 3 and 1000),
 created_at timestamptz not null default now(),restored_from jsonb,note_hash text generated always as (md5(note)) stored,
 unique(user_id,sale_id,evidence_hash,disposition,note_hash)
);
alter table public.sale_reviews enable row level security;
revoke all on public.sale_reviews from anon,authenticated,service_role;
grant select on public.sale_reviews to authenticated,service_role;
create policy sale_review_owner on public.sale_reviews for select to authenticated using(user_id=auth.uid());
create function public.record_sale_review(p_user uuid,p_sale uuid,p_hash text,p_evidence jsonb,p_disposition text,p_note text,p_activity integer,p_holdings integer)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare ar integer;hr integer;rid uuid;
begin
 insert into import_revisions(user_id) values(p_user) on conflict do nothing;
 select revision into hr from import_revisions where user_id=p_user for update;
 select revision into ar from activity_state where user_id=p_user for update;
 if ar is distinct from p_activity or hr is distinct from p_holdings then raise exception 'Evidence changed. Refresh tracking.';end if;
 if (select count(*) from sale_reviews where user_id=p_user)>=1000 then raise exception 'Tracking review limit reached';end if;
 insert into sale_reviews(user_id,sale_id,evidence_hash,evidence,disposition,note) values(p_user,p_sale,p_hash,p_evidence,p_disposition,p_note)
 on conflict(user_id,sale_id,evidence_hash,disposition,note_hash) do nothing returning id into rid;
 if rid is null then select id into rid from sale_reviews where user_id=p_user and sale_id=p_sale and evidence_hash=p_hash and disposition=p_disposition and note=p_note;end if;
 return rid;
end $$;
revoke all on function public.record_sale_review(uuid,uuid,text,jsonb,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.record_sale_review(uuid,uuid,text,jsonb,text,text,integer,integer) to service_role;
alter function public.export_planning(uuid) rename to export_planning_without_sales;
create function public.export_planning(p_user uuid) returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select export_planning_without_sales(p_user)||jsonb_build_object('saleReviews',coalesce((select jsonb_agg(to_jsonb(r)-'user_id' order by r.id) from sale_reviews r where user_id=p_user),'[]'));
$$;
revoke all on function public.export_planning(uuid) from public,anon,authenticated;
grant execute on function public.export_planning(uuid) to service_role;

create or replace function public.restore_planning(p_user uuid,p_checksum text,p_data jsonb,p_mapping jsonb,p_expected jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare entry jsonb; destination uuid; uid uuid; universe_map jsonb:='{}'; current_row replacement_strategies; rid uuid; expected jsonb; a jsonb;
begin
 -- Serialize with normal strategy edits; all records below commit or roll back together.
 perform 1 from portfolios where user_id=p_user order by id for update;
 select id into rid from planning_restores where user_id=p_user and checksum=p_checksum and mapping=p_mapping;
 if found then return jsonb_build_object('id',rid,'duplicate',true);end if;
 for entry in select * from jsonb_array_elements(p_data->'portfolios') loop
  destination:=(p_mapping->'portfolios'->>(entry->>'id'))::uuid;
  if not exists(select 1 from portfolios where id=destination and user_id=p_user) then raise exception 'Destination portfolio unavailable';end if;
 end loop;
 for entry in select * from jsonb_array_elements(p_data->'accounts') loop
  destination:=(p_mapping->'accounts'->>(entry->>'id'))::uuid;
  perform 1 from accounts where id=destination and user_id=p_user and portfolio_id=(p_mapping->'portfolios'->>(entry->>'portfolio_id'))::uuid and account_type=entry->>'account_type' for update;
  if not found then raise exception 'Destination account changed';end if;
 end loop;
 for entry in select * from jsonb_array_elements(p_data->'universes') loop
  insert into replacement_universes(user_id,hash,name,benchmark,provenance,as_of,valid_through,member_count,source_name,source_text,document)
  values(p_user,entry->>'hash',entry->>'name',entry->>'benchmark',entry->>'provenance',(entry->>'as_of')::date,(entry->>'valid_through')::date,(entry->>'member_count')::int,entry->>'source_name',entry->>'source_text',entry->'document') on conflict(user_id,hash) do nothing;
  select id into uid from replacement_universes where user_id=p_user and hash=entry->>'hash';
  universe_map:=universe_map||jsonb_build_object(entry->>'id',uid);
 end loop;
 for entry in select * from jsonb_array_elements(p_data->'strategies') loop
  destination:=(p_mapping->'portfolios'->>(entry->>'portfolio_id'))::uuid;
  select * into current_row from replacement_strategies where portfolio_id=destination and user_id=p_user;
  select x into expected from jsonb_array_elements(p_expected) x where x->>'portfolio_id'=destination::text;
  if coalesce(current_row.revision,0)<>coalesce((expected->>'revision')::bigint,0) then raise exception 'Stale destination strategy';end if;
  uid:=(universe_map->>(entry->>'universe_id'))::uuid;
  if current_row.portfolio_id is not null then
   if current_row.universe_id<>uid or current_row.exclusions<>entry->'exclusions' then raise exception 'Destination strategy conflict';end if;
  else perform save_replacement_strategy(p_user,destination,uid,0,entry->'exclusions');end if;
 end loop;
 for entry in select * from jsonb_array_elements(p_data->'drafts') loop
  destination:=(p_mapping->'accounts'->>(entry->>'account_id'))::uuid;
  if exists(select 1 from trade_drafts d where d.user_id=p_user and d.evidence_hash=entry->>'evidence_hash' and (d.evidence<>entry->'evidence' or coalesce(d.restored_from->>'accountId',d.evidence->'comparison'->>'accountId')<>destination::text)) then raise exception 'Draft destination conflict';end if;
  insert into trade_drafts(user_id,evidence_hash,evidence,saved_at,restored_from)
  values(p_user,entry->>'evidence_hash',entry->'evidence',(entry->>'saved_at')::timestamptz,jsonb_build_object('checksum',p_checksum,'draftId',entry->>'id','accountId',destination,'portfolioId',p_mapping->'portfolios'->>(entry->>'portfolio_id'),'restoredAt',now(),'requiresReview',true))
  on conflict(user_id,evidence_hash) do nothing;
 end loop;
 for entry in select * from jsonb_array_elements(coalesce(p_data->'saleReviews','[]')) loop
  insert into sale_reviews(user_id,sale_id,evidence_hash,evidence,disposition,note,created_at,restored_from)
  values(p_user,(entry->>'sale_id')::uuid,entry->>'evidence_hash',entry->'evidence',entry->>'disposition',entry->>'note',(entry->>'created_at')::timestamptz,jsonb_build_object('checksum',p_checksum,'requiresReview',true,'mapping',p_mapping))
  on conflict(user_id,sale_id,evidence_hash,disposition,note_hash) do nothing;
 end loop;
 insert into planning_restores(user_id,checksum,mapping,source_audit) values(p_user,p_checksum,p_mapping,jsonb_build_object('strategyEvents',p_data->'events','priorRestores',p_data->'restores','exportedAt',p_data->'exportedAt')) returning id into rid;
 return jsonb_build_object('id',rid,'duplicate',false);
end $$;

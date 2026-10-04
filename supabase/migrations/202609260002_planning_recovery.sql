alter table public.trade_drafts add column restored_from jsonb;
create table public.planning_restores (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),
 checksum text not null, mapping jsonb not null, source_audit jsonb not null,
 restored_at timestamptz not null default now(), mapping_hash text generated always as (md5(mapping::text)) stored, unique(user_id,checksum,mapping_hash)
);
alter table public.planning_restores enable row level security;
revoke all on public.planning_restores from anon,authenticated,service_role;
grant select on public.planning_restores to authenticated,service_role;
create policy planning_restore_owner on public.planning_restores for select to authenticated using(user_id=auth.uid());
create function public.export_planning(p_user uuid) returns jsonb language sql security definer set search_path=public,pg_temp as $$
select jsonb_build_object(
 'exportedAt',now(),
 'portfolios',coalesce((select jsonb_agg(to_jsonb(p)-'user_id' order by p.id) from portfolios p where user_id=p_user),'[]'),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,'portfolio_id',a.portfolio_id,'account_type',a.account_type) order by a.id) from accounts a where user_id=p_user),'[]'),
 'universes',coalesce((select jsonb_agg(to_jsonb(u)-'user_id' order by u.id) from replacement_universes u where user_id=p_user),'[]'),
 'strategies',coalesce((select jsonb_agg(to_jsonb(s)-'user_id' order by s.portfolio_id) from replacement_strategies s where user_id=p_user),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(e)-'user_id' order by e.portfolio_id,e.revision) from replacement_strategy_events e where user_id=p_user),'[]'),
 'drafts',coalesce((select jsonb_agg((to_jsonb(d)-'user_id')||jsonb_build_object('account_id',coalesce(d.restored_from->>'accountId',d.evidence->'comparison'->>'accountId'),'portfolio_id',coalesce(d.restored_from->>'portfolioId',d.evidence->'comparison'->>'portfolioId')) order by d.id) from trade_drafts d where user_id=p_user),'[]'),
 'restores',coalesce((select jsonb_agg(to_jsonb(r)-'user_id' order by r.id) from planning_restores r where user_id=p_user),'[]')
);
$$;
create function public.restore_planning(p_user uuid,p_checksum text,p_data jsonb,p_mapping jsonb,p_expected jsonb)
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
 insert into planning_restores(user_id,checksum,mapping,source_audit) values(p_user,p_checksum,p_mapping,jsonb_build_object('strategyEvents',p_data->'events','priorRestores',p_data->'restores','exportedAt',p_data->'exportedAt')) returning id into rid;
 return jsonb_build_object('id',rid,'duplicate',false);
end $$;
revoke all on function public.export_planning(uuid),public.restore_planning(uuid,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.export_planning(uuid),public.restore_planning(uuid,text,jsonb,jsonb,jsonb) to service_role;

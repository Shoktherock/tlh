import {ReviewError} from '../src/review-error.mjs';
import {realizedService} from './realized-service.mjs';
import {transactionReconciliation} from '../src/analysis/transaction-reconciliation.mjs';
import {alertService} from './alert-service.mjs';
import {trackingService} from './tracking-service.mjs';
import {planningRecovery} from './planning-recovery.mjs';
import {validateUniverse,compareReplacements} from '../src/analysis/replacements.mjs';
import {hashText} from '../src/activity/engine.mjs';
import {validDate} from '../src/analysis/inputs.mjs';
import {scoreReplacements} from '../src/analysis/replacement-scoring.mjs';
import {correctionView} from '../src/import/corrections.mjs';
import {fetchReplacementMetric} from './replacement-market.mjs';
import {subtract} from '../src/valuation/engine.mjs';
import {reconciliationIssues} from '../src/import/reconciliation.mjs';
import {draftLots} from '../src/analysis/draft-lots.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const check=(v,m)=>{if(!v)throw new ReviewError(m);};
const value=async p=>{const r=await p;if(r.error)throw new ReviewError(/stale/i.test(r.error.message)?'Strategy changed. Reload and review again.':'Replacement evidence could not be read or saved. Reload and retry.');return r.data;};
export async function replacementService(db,user,body,options={}){
  check(uuid(user),'Sign in to continue.');
  if(['planning-export','planning-preview','planning-restore'].includes(body?.action))return planningRecovery(db,user,body);
  if(['tracking-read','tracking-detail','tracking-review'].includes(body?.action))return trackingService(db,user,body);
  if(body?.action?.startsWith('realized-'))return realizedService(db,user,body);
  if(['alerts-schedule','alerts-read','alerts-scan','alerts-action','alerts-preferences'].includes(body?.action))return alertService(db,user,body);
  if(body?.action==='benchmark-status')return {statuses:await value(db.from('iwv_refresh_status').select('*').eq('user_id',user))};
  const summary='id,hash,name,benchmark,provenance,as_of,valid_through,member_count,accepted_at';
  if(body?.action==='drafts')return {drafts:await value(db.from('trade_drafts').select('*').eq('user_id',user).order('saved_at',{ascending:false}).limit(100))};
  if(body?.action==='lot-options'){
    check(uuid(body.accountId)&&validDate(body.date),'Choose an account and date.');
    const state=await value(db.rpc('read_import_state',{p_user:user}));
    check(state.accounts.some(a=>a.id===body.accountId&&a.type==='taxable'),'Choose an owned taxable account.');
    const holding=correctionView(state).holdings[body.accountId]?.[body.symbol];
    check(holding?.active,'Holding is no longer active.');
    const daily=await value(db.from('massive_daily_cache').select('*').lte('price_date',body.date).order('price_date',{ascending:false}).limit(1).maybeSingle());
    check(daily?.prices?.[body.symbol]?.price&&Date.parse(body.date)-Date.parse(daily.price_date)<=7*86400000,'Refresh daily prices before selecting lots.');
    return {holding,holdingsRevision:state.revision,price:daily.prices[body.symbol].price,priceDate:daily.price_date};
  }
  if(['preview-draft','save-draft'].includes(body?.action)){
    const c=body.comparison??{},request={action:'compare',portfolioId:c.portfolioId,accountId:c.accountId,symbol:c.symbol,date:c.date,mode:c.mode,amount:c.amount,poolLimit:c.poolLimit};
    check(request.mode==='stock'||request.mode==='index','Choose a comparison strategy.');
    const report=await replacementService(db,user,request,options),chosen=report.rows.find(r=>r.symbol===body.replacement);
    check(chosen?.rankable&&!chosen.excluded.length,'Choose a fully evidenced, eligible replacement.');
    const state=await value(db.rpc('read_import_state',{p_user:user}));check(state.revision===report.holdingsRevision&&state.revision===body.holdingsRevision,'Holdings changed. Close this review and select current lots again.');
    const activity=await value(db.rpc('read_activity',{p_user:user}));
    check(activity.revision===report.activityRevision,'Activity changed. Compare again.');
    check(!transactionReconciliation(state,activity.state).some(r=>r.accountId===request.accountId&&r.symbol===request.symbol),'Holdings need reconciliation after imported sales. Update positions and lots first.');
    const holding=correctionView(state).holdings[request.accountId]?.[request.symbol];
    const daily=await value(db.from('massive_daily_cache').select('*').eq('price_date',report.metricsAsOf).single());
    check(!reconciliationIssues(state).some(i=>i.accountId===request.accountId&&i.symbol===request.symbol&&['Totals','Source conflicts'].includes(i.category)),'Reconcile conflicting holding evidence first.');
    check((holding?.position?.currency??holding?.confirmedCurrency)==='USD','Drafts require USD holdings.');
    check(body.lots?.every(s=>{const l=holding.lotScope?.lots?.[s.index];return l&&(l.currency??holding.confirmedCurrency)==='USD'&&(!l.acquisition_date||l.acquisition_date<=request.date);}),'Review lot currency and acquisition dates.');
    const selected=draftLots(holding,body.lots,daily.prices[request.symbol]?.price);
    check(subtract(selected.amount,String(request.amount))==='0','Selected lots or prices changed. Compare again using the current lot value.');
    const evidence={version:1,kind:'unexecuted-draft',comparison:request,selected,price:{value:daily.prices[request.symbol].price,date:daily.price_date,fetchedAt:daily.fetched_at},holdingSnapshot:holding,account:state.accounts.find(a=>a.id===request.accountId),replacement:chosen,universe:report.universe,universeId:report.universeId,universeHash:report.universeHash,holdingsRevision:report.holdingsRevision,strategyRevision:report.strategyRevision,activityRevision:report.activityRevision,scoring:report.scoring,warnings:report.warnings,sourceEvidence:report.sourceEvidence,coverage:report.coverage};
    const hash=await hashText(JSON.stringify(evidence));
    if(body.action==='preview-draft')return {preview:{hash,evidence}};
    check(body.reviewed===true&&body.hash===hash,'Evidence changed or review is missing. Preview and confirm again.');
    const inserted=await db.from('trade_drafts').insert({user_id:user,evidence_hash:hash,evidence}).select('id,saved_at').single();
    if(inserted.error?.code==='23505')return {draft:await value(db.from('trade_drafts').select('id,saved_at').eq('user_id',user).eq('evidence_hash',hash).single()),duplicate:true};
    return {draft:await value(Promise.resolve(inserted))};
  }
  if(body?.action==='read'){
    const [portfolios,universes,strategies]=await Promise.all([value(db.from('portfolios').select('id,name').eq('user_id',user).order('name')),value(db.from('replacement_universes').select(summary).eq('user_id',user).order('accepted_at',{ascending:false}).limit(100)),value(db.from('replacement_strategies').select('*').eq('user_id',user))]);
    return {portfolios,universes,strategies};
  }
  if(['preview','accept'].includes(body?.action)){
    check(typeof body.text==='string'&&new TextEncoder().encode(body.text).length<=2097152,'Choose a universe JSON file up to 2 MB.');
    check(typeof body.name==='string'&&body.name.length>0&&body.name.length<=240,'Provide a file name.');
    let raw;try{raw=JSON.parse(body.text);}catch{throw new ReviewError('Universe file is not valid JSON.');}
    if(raw.originalCsv)check(typeof raw.originalCsv.text==='string'&&await hashText(raw.originalCsv.text)===raw.originalCsv.hash,'Embedded source CSV checksum does not match.');
    const document=validateUniverse(raw),hash=await hashText(body.text);
    if(body.action==='preview')return {preview:{hash,document}};
    check(body.reviewed===true&&body.hash===hash,'Preview and review this exact source before accepting.');
    const existing=await value(db.from('replacement_universes').select(summary).eq('user_id',user).eq('hash',hash).maybeSingle());if(existing)return {universe:existing,duplicate:true};
    const row={user_id:user,hash,name:document.name,benchmark:document.benchmark,provenance:document.provenance,as_of:document.asOf,valid_through:document.validThrough,member_count:document.members.length,source_name:body.name,source_text:body.text,document};
    const inserted=await db.from('replacement_universes').insert(row).select(summary).single();
    if(inserted.error?.code==='23505')return {universe:await value(db.from('replacement_universes').select(summary).eq('user_id',user).eq('hash',hash).single()),duplicate:true};
    return {universe:await value(Promise.resolve(inserted)),duplicate:false};
  }
  check(uuid(body?.portfolioId),'Choose a portfolio.');
  const portfolio=await value(db.from('portfolios').select('id').eq('id',body.portfolioId).eq('user_id',user).maybeSingle());check(portfolio,'Choose an owned portfolio.');
  if(body.action==='select'){
    check(uuid(body.universeId)&&Number.isSafeInteger(body.baseRevision)&&body.baseRevision>=0&&body.reviewed===true,'Review the strategy and its current revision.');
    check(Array.isArray(body.exclusions)&&body.exclusions.length<=5000&&body.exclusions.every(s=>typeof s==='string'&&/^[A-Z0-9][A-Z0-9./-]{0,24}$/.test(s)),'Invalid excluded symbols.');
    const revision=await value(db.rpc('save_replacement_strategy',{p_user:user,p_portfolio:body.portfolioId,p_universe:body.universeId,p_revision:body.baseRevision,p_exclusions:[...new Set(body.exclusions)]}));return {revision};
  }
  if(['compare','enrich'].includes(body.action)){
    check(uuid(body.accountId)&&typeof body.symbol==='string'&&validDate(body.date),'Choose a source holding and valid analysis date.');
    const strategy=await value(db.from('replacement_strategies').select('*').eq('portfolio_id',body.portfolioId).eq('user_id',user).maybeSingle());check(strategy,'Save a reviewed portfolio universe first.');
    const [universe,state,activity,daily]=await Promise.all([value(db.from('replacement_universes').select('id,hash,document').eq('id',strategy.universe_id).eq('user_id',user).single()),value(db.rpc('read_import_state',{p_user:user})),value(db.rpc('read_activity',{p_user:user})),value(db.from('massive_daily_cache').select('*').lte('price_date',body.date).order('price_date',{ascending:false}).limit(1).maybeSingle())]);
    const report=compareReplacements({universe:universe.document,state,portfolioId:body.portfolioId,accountId:body.accountId,symbol:body.symbol,date:body.date,excluded:strategy.exclusions,activity:activity.state,daily,today:new Date().toISOString().slice(0,10)});
    const metadata={universeId:universe.id,universeHash:universe.hash,strategyRevision:strategy.revision,activityRevision:activity.revision};
    if(!body.mode&&body.action==='compare')return {...report,...metadata};
    check(daily?.price_date&&Date.parse(body.date+'T00:00:00Z')-Date.parse(daily.price_date+'T00:00:00Z')<=7*86400000,'Refresh daily prices; ranking needs a saved price date within seven days.');
    const args={universe:universe.document,state:correctionView(state),daily,mode:body.mode,amount:body.amount,poolLimit:body.poolLimit??20};
    const preliminary=scoreReplacements(report,args),symbols=[body.symbol,...preliminary.scoring.pool];
    const cached=await value(db.from('replacement_metric_cache').select('symbol,kind,payload,fetched_at').eq('as_of',daily.price_date).in('symbol',symbols));
    const metrics={};for(const r of cached)(metrics[r.symbol]??={})[r.kind]=r.payload;
    if(body.action==='enrich'){
      const pending=symbols.flatMap(symbol=>['profile','history'].filter(kind=>{const payload=metrics[symbol]?.[kind];if(!payload)return true;if(payload.error)return Date.now()-Date.parse(payload.failedAt)>15*60000;return kind==='profile'&&payload.identityVersion!==1;}).map(kind=>({symbol,kind})));
      if(!pending.length)return {done:true,completed:symbols.length*2,total:symbols.length*2};
      check(options.apiKey,'Configure the server-side Massive key before refreshing ranking evidence.');
      const claim=await value(db.rpc('claim_massive_request'));if(claim!=='ok')return {done:false,retryAfter:15,completed:symbols.length*2-pending.length,total:symbols.length*2};
      const next=pending[0];try{
        let payload;try{payload=await fetchReplacementMetric(next.symbol,daily.price_date,next.kind,{apiKey:options.apiKey,fetchImpl:options.fetchImpl});}catch(e){if(/rate limit/i.test(e.message))return {done:false,retryAfter:60,completed:symbols.length*2-pending.length,total:symbols.length*2};payload={error:`${next.symbol} ${next.kind}: market evidence unavailable. Retry after 15 minutes.`,failedAt:new Date().toISOString()};}
        await value(db.from('replacement_metric_cache').upsert({symbol:next.symbol,as_of:daily.price_date,kind:next.kind,payload,fetched_at:new Date().toISOString()}));
      }finally{await value(db.from('massive_budget').update({lease_until:new Date().toISOString()}).eq('id',true));}
      return {done:pending.length===1,completed:symbols.length*2-pending.length+1,total:symbols.length*2,symbol:next.symbol,kind:next.kind};
    }
    return {...scoreReplacements(report,{...args,metrics}),...metadata,metricsAsOf:daily.price_date};
  }
  throw new ReviewError('Unknown replacement action.');
}

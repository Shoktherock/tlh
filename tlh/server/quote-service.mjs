import {ReviewError} from '../src/review-error.mjs';
import {correctionView} from '../src/import/corrections.mjs';
import {lookupListing as lookup} from './listing-lookup.mjs';
import {massiveService} from './massive-service.mjs';

export const QUOTE_TTL_MS=15*60*1000;
export const exchanges={XNAS:'NASDAQ',XNGS:'NASDAQ Global Select',XNYS:'NYSE',ARCX:'NYSE Arca',BATS:'Cboe BZX',XASE:'NYSE American'};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const check=(ok,message)=>{if(!ok)throw new ReviewError(message);};
const identity=h=>JSON.stringify([h.position.security.symbol,h.position.security.broker_security_id??null,h.position.security.exchange??null,h.position.currency??null,h.confirmedCurrency??null]);
export const quoteKey=m=>`twelve-data:${m.provider_symbol}:${m.mic}:USD`;
const fresh=(q,now)=>q&&Date.parse(q.fetched_at)<=Date.parse(now)&&Date.parse(now)-Date.parse(q.fetched_at)<QUOTE_TTL_MS;
const safeError=code=>({code,message:({unconfigured:'Live quotes are not configured. A server-side provider key is required.',rate_limit:'Quote allowance reached. Try again later; existing prices are retained.',busy:'A refresh is already in progress. Reload cached quotes shortly.',unavailable:'Provider request failed. Existing prices are retained.',not_found:'Provider has no quote for this mapping.',access_denied:'The provider account cannot access this quote.',identity_mismatch:'Provider symbol, exchange or currency does not match the reviewed mapping.',invalid_quote:'Provider returned invalid price or market-time evidence.',cache_write:'The quote could not be saved. Retry before using it.'})[code]??'Quote unavailable.'});

// Fixed official endpoint; no caller-controlled URL, credential or provider error text.
// last_quote_at is the market quote time. timestamp is a candle opening time and
// must never be substituted for it or for our separate fetched_at timestamp.
export async function fetchTwelveQuote(mapping,{apiKey,fetchImpl=fetch,now=()=>new Date().toISOString()}){
  if(!apiKey)return {error:safeError('unconfigured')};
  const url=new URL('https://api.twelvedata.com/quote');
  for(const [k,v] of Object.entries({symbol:mapping.provider_symbol,mic_code:mapping.mic,country:'United States',apikey:apiKey,format:'JSON',prepost:'false'}))url.searchParams.set(k,v);
  try{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(12000),redirect:'error'});
    if(!response.ok)return {error:safeError(response.status===429?'rate_limit':response.status===404?'not_found':[401,403].includes(response.status)?'access_denied':'unavailable')};
    const data=await response.json();
    if(data?.status==='error')return {error:safeError(data.code===429?'rate_limit':data.code===404?'not_found':[401,403].includes(data.code)?'access_denied':'unavailable')};
    if(data?.symbol!==mapping.provider_symbol||data.mic_code!==mapping.mic||data.currency!=='USD')return {error:safeError('identity_mismatch')};
    const fetchedAt=now();
    if(typeof data.close!=='string'||data.close.length>40||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(data.close)||!Number.isSafeInteger(data.last_quote_at)||data.last_quote_at<=0||data.last_quote_at*1000>Date.parse(fetchedAt))return {error:safeError('invalid_quote')};
    return {quote:{key:quoteKey(mapping),provider:'twelve-data',provider_symbol:data.symbol,mic:data.mic_code,currency:'USD',price:data.close,observed_at:new Date(data.last_quote_at*1000).toISOString(),fetched_at:fetchedAt}};
  }catch{return {error:safeError('unavailable')};}
}

export async function quoteService(repo,user,body,options={}){
  check(uuid(user),'Sign in to continue.');
  if(body?.provider==='massive'||body?.action==='read'&&!body.provider&&options.defaultProvider==='massive')return massiveService(repo,user,body,options);
  check(['read','map','unmap','refresh','automap'].includes(body?.action),'Unknown quote action.');
  const state=correctionView(await repo.snapshot(user)),now=options.now??(()=>new Date().toISOString());
  const holding=(account,symbol)=>state.accounts.some(a=>a.id===account)?state.holdings[account]?.[symbol]:null;
  let automatic=null;
  if(body.action==='automap'){
    const h=holding(body.accountId,body.symbol);
    check(h?.active,'Choose an active holding in your account.');
    const existing=(await repo.mappings(user)).find(m=>m.account_id===body.accountId&&m.symbol===body.symbol);
    if(existing)automatic={code:existing.identity===identity(h)?'preserved':'review',message:existing.identity===identity(h)?'Existing mapping preserved.':'Holding changed; review its mapping.'};
    else if((h.position.currency??h.confirmedCurrency)!=='USD'||h.position.currency&&h.confirmedCurrency&&h.position.currency!==h.confirmedCurrency)automatic={code:'review',message:'Resolve the holding currency before mapping.'};
    else if(!/^[A-Z][A-Z0-9.-]{0,24}$/.test(body.symbol)||h.position.security.symbol!==body.symbol)automatic={code:'review',message:'Review the brokerage symbol manually.'};
    else if(!options.apiKey)automatic=safeError('unconfigured');
    else{
      // Metadata and quote requests share the conservative provider budget.
      const claim=await repo.claim(quoteKey({provider_symbol:body.symbol,mic:'XNAS'}));
      if(claim!=='ok')automatic=safeError(claim);
      else{
        const lookup=await lookupListing(body.symbol,options);
        if(lookup.error)automatic=lookup.error;
        else{
          const listing=lookup.listing,reported=h.position.security.exchange;
          if(reported&&![listing.mic_code,listing.exchange,exchanges[listing.mic_code]].some(v=>v?.toUpperCase()===reported.toUpperCase()))automatic={code:'review',message:'Provider exchange differs from imported evidence; review manually.'};
          else{
            const current=correctionView(await repo.snapshot(user)).holdings[body.accountId]?.[body.symbol];
            check(current?.active&&identity(current)===identity(h),'Holding changed during lookup. Retry.');
            await repo.mapIfAbsent({user_id:user,account_id:body.accountId,symbol:body.symbol,provider_symbol:listing.symbol,mic:listing.mic_code,identity:identity(h)});
            automatic={code:'matched',message:`Exact USD listing found: ${listing.symbol} / ${listing.mic_code}.`};
          }
        }
      }
    }
  }
  if(['map','unmap'].includes(body.action)){
    const h=holding(body.accountId,body.symbol);
    check(h?.active,'Choose an active holding in your account.');
    if(body.action==='unmap')await repo.unmap(user,body.accountId,body.symbol);
    else{
      check(body.reviewed===true,'Review the provider symbol, exchange and USD currency.');
      check(typeof body.providerSymbol==='string'&&/^[A-Z0-9][A-Z0-9.-]{0,24}$/.test(body.providerSymbol)&&Object.hasOwn(exchanges,body.mic),'Choose a supported US exchange and an exact provider symbol.');
      check((h.position.currency??h.confirmedCurrency)==='USD'&&!(h.position.currency&&h.confirmedCurrency&&h.position.currency!==h.confirmedCurrency),'Resolve the holding currency to USD before mapping a quote.');
      await repo.map({user_id:user,account_id:body.accountId,symbol:body.symbol,provider_symbol:body.providerSymbol,mic:body.mic,identity:identity(h)});
    }
  }
  const mappings=await repo.mappings(user),items=mappings.map(m=>{
    const h=holding(m.account_id,m.symbol);
    return {accountId:m.account_id,symbol:m.symbol,mapping:{providerSymbol:m.provider_symbol,mic:m.mic},valid:Boolean(h?.active&&m.identity===identity(h)),security:h?.position.security,source:m};
  });
  if(body.action==='refresh'){
    check(Array.isArray(body.holdings)&&body.holdings.length>0&&body.holdings.length<=8,'Choose 1–8 mapped holdings per refresh.');
    check(body.holdings.every(r=>uuid(r.accountId)&&typeof r.symbol==='string'&&items.some(i=>i.accountId===r.accountId&&i.symbol===r.symbol&&i.valid)),'A quote mapping is missing or changed. Review the mapping again.');
  }
  const saved=await repo.quotes([...new Set(items.filter(i=>i.valid).map(i=>quoteKey(i.source)))]),cache=new Map(saved.map(q=>[q.key,q]));
  const outcomes=new Map();
  for(const item of items){
    if(!item.valid)continue;
    const key=quoteKey(item.source),selected=body.action==='refresh'&&body.holdings.some(r=>r.accountId===item.accountId&&r.symbol===item.symbol);
    if(!selected||outcomes.has(key)||fresh(cache.get(key),now()))continue;
    let result;
    if(!options.apiKey)result={error:safeError('unconfigured')};
    else{
      const claim=await repo.claim(key);
      if(claim!=='ok')result={error:safeError(claim)};
      else{
        result=await fetchTwelveQuote(item.source,options);
        if(result.quote){try{const stored=await repo.save(result.quote);cache.set(key,stored);}catch{result={error:safeError('cache_write')};}}
      }
    }
    outcomes.set(key,result);
  }
  return {configured:Boolean(options.apiKey),provider:'Twelve Data',ttlSeconds:900,automatic,items:items.map(({source,security,...item})=>{
    const q=item.valid?cache.get(quoteKey(source)):null;
    return {...item,quote:q?{accountId:item.accountId,symbol:item.symbol,security,kind:'provider',provider:q.provider,providerSymbol:q.provider_symbol,mic:q.mic,price:q.price,currency:q.currency,observedAt:new Date(q.observed_at).toISOString(),fetchedAt:new Date(q.fetched_at).toISOString(),reference:`Twelve Data · ${q.provider_symbol} · ${q.mic}`} :null,
      cacheStatus:q?(fresh(q,now())?'fresh':'stale'):'missing',error:item.valid?(outcomes.get(quoteKey(source))?.error??null):{code:'mapping_changed',message:'Holding identity or currency changed. Review the quote mapping again.'}};
  })};
}

// All access is server-side after Auth. Shared cache rows contain no account IDs,
// quantities, bases or credentials. Private mappings never enter that cache.
export function quoteRepository(db){
  const value=async request=>{const {data,error}=await request;if(error)throw new ReviewError('Quote storage is unavailable. Try again.');return data;};
  return {
    snapshot:user=>value(db.rpc('read_import_state',{p_user:user})),
    async mappings(user){const rows=[];for(let start=0;;start+=500){const page=await value(db.from('quote_mappings').select('*').eq('user_id',user).order('account_id').order('symbol').range(start,start+499));rows.push(...page);if(page.length<500)return rows;}},
    map:row=>value(db.from('quote_mappings').upsert(row,{onConflict:'account_id,symbol'})),
    mapIfAbsent:row=>value(db.from('quote_mappings').upsert(row,{onConflict:'account_id,symbol',ignoreDuplicates:true})),
    unmap:(user,account,symbol)=>value(db.from('quote_mappings').delete().eq('user_id',user).eq('account_id',account).eq('symbol',symbol)),
    async quotes(keys){const rows=[];for(let start=0;start<keys.length;start+=100)rows.push(...await value(db.from('price_cache').select('*').in('key',keys.slice(start,start+100))));return rows;},
    claim:key=>value(db.rpc('claim_quote_request',{p_key:key})),
    save:row=>value(db.rpc('save_quote',{p_quote:row})),
    dailyRead:date=>value(date?db.from('massive_daily_cache').select('*').eq('price_date',date).maybeSingle():db.from('massive_daily_cache').select('*').order('price_date',{ascending:false}).limit(1).maybeSingle()),
    dailyClaim:()=>value(db.rpc('claim_massive_request')),
    dailySave:batch=>value(db.from('massive_daily_cache').upsert(batch,{onConflict:'price_date'})),
    dailyRelease:()=>value(db.from('massive_budget').update({lease_until:new Date().toISOString()}).eq('id',true)),
  };
}

const lookupListing=(symbol,options)=>lookup(symbol,options,exchanges);

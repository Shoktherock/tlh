import {ReviewError} from '../src/review-error.mjs';
import {correctionView} from '../src/import/corrections.mjs';

const nyDateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
export const nyDate=value=>nyDateFormatter.format(new Date(value));
export function previousWeekday(now){const d=new Date(`${nyDate(now)}T12:00:00Z`);do{d.setUTCDate(d.getUTCDate()-1);}while([0,6].includes(d.getUTCDay()));return d.toISOString().slice(0,10);}
const failure=(code,message)=>({error:{code,message}});
const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(`${d}T00:00:00Z`))&&new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)===d;
export async function fetchMassiveDaily(date,{massiveApiKey,fetchImpl=fetch,now=()=>new Date().toISOString()}){
  if(!massiveApiKey)return failure('unconfigured','Add the server-side Massive API key to fetch daily prices.');
  const url=new URL(`https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/${date}`);
  url.searchParams.set('adjusted','false');url.searchParams.set('include_otc','false');
  try{
    const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${massiveApiKey}`},signal:AbortSignal.timeout(25000),redirect:'error'});
    if(!response.ok)return failure(response.status===429?'rate_limit':'unavailable',response.status===429?'Massive request allowance reached. Retry in a minute.':'Massive could not supply this date. Check plan access or try an earlier trading date.');
    const text=await response.text();if(text.length>12000000)return failure('invalid','Market response was too large.');
    // Preserve the provider's decimal price token before JSON numeric conversion.
    const data=JSON.parse(text.replace(/("c"\s*:\s*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/g,(_m,p,n)=>p+JSON.stringify(n)));
    if(data.status!=='OK'||data.adjusted!==false||!Array.isArray(data.results)||data.results.length>50000||data.resultsCount!==data.results.length)return failure('invalid','Massive returned an incomplete or unexpected daily summary.');
    if(!data.results.length)return failure('no_session','No daily prices for this date. Choose an earlier trading day.');
    const prices={},duplicates=new Set(),fetchedAt=now(),fetchedTime=Date.parse(fetchedAt),barDates=new Map();
    const barDate=t=>{if(!barDates.has(t))barDates.set(t,nyDate(t));return barDates.get(t);};
    for(const r of data.results){
      if(typeof r.T!=='string'||!/^[A-Z][A-Z0-9.-]{0,24}$/.test(r.T)||r.otc===true)continue;
      if(Object.hasOwn(prices,r.T)||duplicates.has(r.T)){delete prices[r.T];duplicates.add(r.T);continue;}
      if(typeof r.c!=='string'||r.c.length>40||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(r.c)||!Number.isSafeInteger(r.t)||r.t<=0||r.t>fetchedTime||barDate(r.t)!==date)continue;
      prices[r.T]={price:r.c,barAt:new Date(r.t).toISOString()};
    }
    if(!Object.keys(prices).length)return failure('invalid','No valid prices were returned for the requested date.');
    return {batch:{price_date:date,fetched_at:fetchedAt,prices}};
  }catch{return failure('unavailable','Massive request failed. Previously saved prices are retained.');}
}

export async function massiveService(repo,user,body,options={}){
  if(!['read','daily-refresh'].includes(body.action))throw new ReviewError('Choose a daily-price action.');
  const now=options.now??(()=>new Date().toISOString()),target=body.date??previousWeekday(now());
  if(!validDate(target)||target>=nyDate(now())||Date.parse(target)<Date.parse(now())-730*86400000)throw new ReviewError('Choose a completed date within the last two years.');
  let batch=await repo.dailyRead(body.action==='read'?null:target),error=null;
  if(body.action==='daily-refresh'&&(!batch||Date.parse(now())-Date.parse(batch.fetched_at)>=86400000)){
    if(!options.massiveApiKey)error=failure('unconfigured','Add the server-side Massive API key to fetch daily prices.').error;
    else{
      const claim=await repo.dailyClaim();
      if(claim!=='ok')error=failure(claim,'A market refresh is already running or the five-per-minute allowance is used. Retry in a minute.').error;
      else{
        try{
          const fetched=await fetchMassiveDaily(target,options);
          if(fetched.error)error=fetched.error;
          else{await repo.dailySave(fetched.batch);batch=fetched.batch;}
        }finally{await repo.dailyRelease();}
      }
    }
  }
  // On a failed new date, retain the most recently saved market day, explicitly labelled.
  if(!batch)batch=await repo.dailyRead(null);
  const state=correctionView(await repo.snapshot(user)),items=[],freshnessDate=previousWeekday(now());
  for(const account of state.accounts)for(const [symbol,h] of Object.entries(state.holdings[account.id]??{})){
    if(!h.active)continue;
    // Reviewed Berkshire Class B alias only; do not rewrite arbitrary slash symbols.
    const providerSymbol=symbol==='BRK/B'?'BRK.B':symbol;
    const currency=h.position.currency??h.confirmedCurrency;
    const exchange=h.position.security.exchange;
    const supportedExchange=!exchange||['XNAS','XNGS','XNMS','XNCM','XNYS','ARCX','BATS','XASE','NASDAQ','NYSE','NYSE ARCA','NYSE AMERICAN','CBOE BZX'].includes(exchange.toUpperCase());
    const valid=/^[A-Z][A-Z0-9.-]{0,24}$/.test(providerSymbol)&&currency==='USD'&&!(h.position.currency&&h.confirmedCurrency&&h.position.currency!==h.confirmedCurrency)&&h.position.security.symbol===symbol&&supportedExchange;
    const p=valid&&batch?.prices[providerSymbol];
    const itemError=!valid?{code:'review',message:/^\d/.test(symbol)?'This security identifier is not a supported stock ticker. Review broker valuation and lot evidence; do not assume zero value.':'Resolve currency, symbol or US listing identity before using daily prices.'}:!p?{code:'missing',message:symbol==='FSKAX'?'FSKAX has no price in this stock-market daily summary. Use a verified fund NAV as a labelled scenario price or another supported source.':'No exact symbol in the saved daily summary. Use another source or a scenario price.'}:null;
    items.push({accountId:account.id,symbol,valid,cacheStatus:p?(batch.price_date<freshnessDate?'stale':'daily'):'missing',error:itemError,
      quote:p?{accountId:account.id,symbol,security:h.position.security,kind:'provider',provider:'massive',providerSymbol,currency:'USD',price:p.price,priceDate:batch.price_date,priceType:'daily-close',observedAt:null,barAt:p.barAt,fetchedAt:new Date(batch.fetched_at).toISOString(),reference:`Massive · daily close ${batch.price_date} · unadjusted · ${symbol}`} :null});
  }
  return {provider:'Massive',configured:Boolean(options.massiveApiKey),items,error,priceDate:batch?.price_date??null,suggestedDate:previousWeekday(now()),requestedDate:target};
}


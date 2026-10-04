import {nyDate} from './massive-service.mjs';
export async function fetchReplacementMetric(symbol,date,kind,{apiKey,fetchImpl=fetch}){
  if(!apiKey)throw Error('Configure the server-side Massive key first.');
  if(!/^[A-Z][A-Z0-9.-]{0,24}$/.test(symbol))throw Error('Unsupported provider symbol.');
  const start=new Date(Date.parse(date+'T12:00:00Z')-400*86400000).toISOString().slice(0,10);
  const path=kind==='profile'?`/v3/reference/tickers/${symbol}?date=${date}`:`/v2/aggs/ticker/${symbol}/range/1/day/${start}/${date}?adjusted=true&sort=asc&limit=50000`;
  const response=await fetchImpl(`https://api.massive.com${path}`,{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(25000),redirect:'error'});
  if(!response.ok)throw Error(response.status===429?'Provider rate limit; pause and retry shortly.':'Provider could not supply this evidence; check plan access.');
  const text=await response.text();if(text.length>1000000)throw Error('Market evidence exceeded size limit.');const data=JSON.parse(text);
  if(!['OK','DELAYED'].includes(data.status)||data.next_url)throw Error('Incomplete market evidence response.');
  if(kind==='profile'){
    const r=data.results;if(r?.ticker!==symbol||r.currency_name?.toLowerCase()!=='usd'||r.locale!=='us'||r.market!=='stocks')throw Error('Provider identity requires review.');
    return {identityVersion:1,cik:typeof r.cik==='string'&&/^\d{1,10}$/.test(r.cik)?r.cik.padStart(10,'0'):null,marketCap:Number.isFinite(r.market_cap)&&r.market_cap>0?r.market_cap:null,industry:typeof r.sic_code==='string'?r.sic_code:null,industryName:r.sic_description??null,source:'Massive ticker overview',asOf:date};
  }
  if(data.ticker!==symbol||data.adjusted!==true||!Array.isArray(data.results)||data.results.length<2||data.results.length>500||data.resultsCount!==data.results.length)throw Error('Insufficient or invalid adjusted history.');
  let previous='';const bars=data.results.map(r=>{const day=nyDate(r.t);if(day<=previous||day<start||day>date||!Number.isFinite(r.c)||r.c<=0)throw Error('Invalid history observation.');previous=day;return {date:day,close:r.c};});
  return {bars,source:'Massive split-adjusted daily closes; not dividend-adjusted total returns',asOf:date};
}

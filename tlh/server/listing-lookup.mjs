// Use provider listing metadata, never infer an exchange from a ticker.
export async function lookupListing(symbol,{apiKey,fetchImpl=fetch},exchanges){
  const url=new URL('https://api.twelvedata.com/symbol_search');
  for(const [k,v] of Object.entries({symbol,outputsize:'120',apikey:apiKey}))url.searchParams.set(k,v);
  const error=(code,message)=>({error:{code,message}});
  try{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(12000),redirect:'error'});
    const data=await response.json();
    if(response.status===429||data?.code===429)return error('rate_limit','Provider allowance reached. Try again later.');
    if(!response.ok||data?.status==='error')return error('unavailable','Listing lookup failed. Review or retry later.');
    if(!Array.isArray(data.data)||data.data.length>=120)return error('review','Listing search is incomplete; review manually.');
    const matches=data.data.filter(v=>v.symbol===symbol&&v.country==='United States'&&v.currency==='USD'&&Object.hasOwn(exchanges,v.mic_code));
    const unique=[...new Map(matches.map(v=>[JSON.stringify([v.symbol,v.mic_code,v.instrument_type]),v])).values()];
    if(unique.length!==1)return error('review',unique.length?'Multiple exact listings; review manually.':'No exact US dollar listing; review manually.');
    const listing=unique[0];
    if(!Object.hasOwn(exchanges,listing.mic_code)||!['Common Stock','ETF','REIT','American Depositary Receipt','Closed-end Fund'].includes(listing.instrument_type))return error('review','This exchange or security type requires manual review.');
    return {listing};
  }catch{return error('unavailable','Listing lookup failed. Review or retry later.');}
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchTwelveQuote,quoteService,quoteKey} from '../server/quote-service.mjs';
import {combineValuationPrices,buildValuation,prepareScenarioPrice} from '../src/valuation/engine.mjs';
import {sampleFiles} from '../src/sample.mjs';
import {readSource} from '../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../src/import/engine.mjs';
const user='11111111-1111-4111-8111-111111111111',now='2026-09-15T18:00:00.000Z';
const mapping={provider_symbol:'EXAMPLE',mic:'XNAS'};
const payload=(extra={})=>({symbol:'EXAMPLE',mic_code:'XNAS',currency:'USD',close:'90.00001',timestamp:1,last_quote_at:Date.parse(now)/1000,...extra});
const options=body=>({apiKey:'test-secret-never-returned',now:()=>now,fetchImpl:async()=>new Response(JSON.stringify(body))});
async function setup(){
  const initial=emptyState(),plan=await previewImport(initial,await Promise.all(sampleFiles().map(readSource)),{accountId:null,accountLabel:'Synthetic quotes',accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});
  const state=acceptPreview(initial,plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic quote tests.'}).state;
  const maps=[],cache=new Map(),calls=[];
  const repo={snapshot:async id=>{assert.equal(id,user);return structuredClone(state);},mappings:async()=>structuredClone(maps),map:async row=>{const index=maps.findIndex(m=>m.account_id===row.account_id&&m.symbol===row.symbol);if(index>=0)maps.splice(index,1);maps.push(row);},unmap:async(_u,a,s)=>{const index=maps.findIndex(m=>m.account_id===a&&m.symbol===s);if(index>=0)maps.splice(index,1);},quotes:async keys=>keys.flatMap(k=>cache.has(k)?[cache.get(k)]:[]),claim:async key=>{calls.push(key);return 'ok';},save:async q=>{cache.set(q.key,q);return q;}};
  const accountId=state.accounts[0].id,run=(body,opts=options(payload()))=>quoteService(repo,user,body,opts);
  repo.mapIfAbsent=async row=>{if(!maps.some(m=>m.account_id===row.account_id&&m.symbol===row.symbol))maps.push(row);};
  const map=async(symbol='EXAMPLE',providerSymbol=symbol)=>run({action:'map',accountId,symbol,providerSymbol,mic:'XNAS',reviewed:true});
  const refresh=(symbols=['EXAMPLE'],opts)=>run({action:'refresh',holdings:symbols.map(symbol=>({accountId,symbol}))},opts);
  return {state,repo,cache,calls,accountId,run,map,refresh};
}

test('automatic mapping preserves reviewed mappings, validates currency and leaves evidence unchanged',async()=>{
  const f=await setup(),before=structuredClone(f.state);
  const body={action:'automap',accountId:f.accountId,symbol:'EXAMPLE'};
  const metadata=options({data:[{symbol:'EXAMPLE',mic_code:'XNGS',country:'United States',currency:'USD',instrument_type:'Common Stock'}]});
  const result=await f.run(body,metadata);assert.equal(result.automatic.code,'matched');assert.equal(result.items[0].mapping.mic,'XNGS');assert.deepEqual(f.state,before);
  const count=f.calls.length;assert.equal((await f.run(body,metadata)).automatic.code,'preserved');assert.equal(f.calls.length,count);
  await assert.rejects(f.run({...body,accountId:user},metadata),/active holding/);
  f.state.holdings[f.accountId].EXAMPLE.confirmedCurrency='EUR';assert.equal((await f.run(body,metadata)).automatic.code,'review');assert.equal(f.calls.length,count);
});
test('provider validates identity, preserves exact decimals and separates quote time from candle time',async()=>{
  const r=await fetchTwelveQuote(mapping,options(payload()));assert.equal(r.quote.price,'90.00001');assert.equal(r.quote.observed_at,now);assert.equal(r.quote.fetched_at,now);assert(!JSON.stringify(r).includes('test-secret'));
  for(const extra of [{symbol:'OTHER'},{mic_code:'XNYS'},{currency:'EUR'}])assert.equal((await fetchTwelveQuote(mapping,options(payload(extra)))).error.code,'identity_mismatch');
});
test('daily closes remain distinct from live timestamps and cannot price earlier valuation dates',async()=>{
  const f=await setup(),security=f.state.holdings[f.accountId].EXAMPLE.position.security;
  const daily={accountId:f.accountId,symbol:'EXAMPLE',security,kind:'provider',provider:'massive',price:'90',currency:'USD',priceType:'daily-close',priceDate:'2026-09-14',observedAt:null};
  let row=buildValuation(f.state,[daily],now).find(r=>r.symbol==='EXAMPLE');assert.equal(row.priceStatus,'daily-close');assert.equal(row.marketValue,'180');assert(row.reasons.some(r=>r.includes('not a live quote')));
  row=buildValuation(f.state,[daily],'2026-09-14T18:00:00Z').find(r=>r.symbol==='EXAMPLE');assert.equal(row.priceStatus,'future');assert.equal(row.marketValue,null);
});
test('missing, numeric, malformed and future provider fields fail closed; explicit zero is preserved',async()=>{
  for(const extra of [{close:90},{close:'NaN'},{close:'-1'},{close:'1e2'},{last_quote_at:undefined},{last_quote_at:Date.parse(now)/1000+1},{last_quote_at:0}])assert.equal((await fetchTwelveQuote(mapping,options(payload(extra)))).error.code,'invalid_quote');
  assert.equal((await fetchTwelveQuote(mapping,options(payload({close:'0'})))).quote.price,'0');
});
test('HTTP and provider errors, malformed JSON, timeout and secrets are safely handled',async()=>{
  for(const [status,expected] of [[404,'not_found'],[401,'access_denied'],[403,'access_denied'],[429,'rate_limit'],[500,'unavailable']]){
    const result=await fetchTwelveQuote(mapping,{...options({}),fetchImpl:async()=>new Response('test-secret',{status})});
    assert.equal(result.error.code,expected);assert(!JSON.stringify(result).includes('test-secret'));
  }
  for(const [code,expected] of [[429,'rate_limit'],[404,'not_found'],[403,'access_denied'],[500,'unavailable']])assert.equal((await fetchTwelveQuote(mapping,options({status:'error',code,message:'test-secret'}))).error.code,expected);
  for(const opts of [{...options({}),fetchImpl:async()=>new Response('test-secret',{status:429})},{...options({}),fetchImpl:async()=>{throw Error('test-secret');}},{...options({}),fetchImpl:async()=>new Response('test-secret')}]){const r=await fetchTwelveQuote(mapping,opts);assert(r.error);assert(!JSON.stringify(r).includes('test-secret'));}
  assert.equal((await fetchTwelveQuote(mapping,{})).error.code,'unconfigured');
});
test('quote reads and mapping never call the provider or change imported evidence',async()=>{
  const f=await setup(),before=structuredClone(f.state);await f.map();const read=await f.run({action:'read'},{now:()=>now});assert.equal(read.configured,false);assert.equal(read.items[0].cacheStatus,'missing');assert.equal(f.calls.length,0);assert.deepEqual(f.state,before);
  await f.run({action:'unmap',accountId:f.accountId,symbol:'EXAMPLE'});assert.equal((await f.run({action:'read'})).items.length,0);
});
test('mapping requires ownership, explicit review, supported exchange and resolved USD identity',async()=>{
  const f=await setup(),base={action:'map',accountId:f.accountId,symbol:'EXAMPLE',providerSymbol:'EXAMPLE',mic:'XNAS',reviewed:true};
  for(const extra of [{accountId:user},{reviewed:false},{mic:''},{providerSymbol:'ABC&apikey=bad'}])await assert.rejects(f.run({...base,...extra}));
  f.state.holdings[f.accountId].EXAMPLE.confirmedCurrency=null;await assert.rejects(f.run(base),/USD/);
});
test('NASDAQ Global Select uses its exact provider MIC without relaxing identity checks',async()=>{
  const f=await setup();
  await f.run({action:'map',accountId:f.accountId,symbol:'EXAMPLE',providerSymbol:'MSFT',mic:'XNGS',reviewed:true});
  const result=await f.refresh(['EXAMPLE'],options(payload({symbol:'MSFT',mic_code:'XNGS'})));
  assert.equal(result.items[0].quote.mic,'XNGS');assert.equal(result.items[0].quote.providerSymbol,'MSFT');
  assert.equal((await fetchTwelveQuote({provider_symbol:'MSFT',mic:'XNGS'},options(payload({symbol:'MSFT',mic_code:'XNAS'})))).error.code,'identity_mismatch');
});
test('refresh honors the exact TTL boundary, reuses the shared cache, and invalidates changed identities',async()=>{
  const f=await setup();await f.map();let r=await f.refresh();assert.equal(r.items[0].quote.price,'90.00001');assert.equal(f.calls.length,1);
  await f.refresh();assert.equal(f.calls.length,1);
  await f.refresh(['EXAMPLE'],{...options(payload()),now:()=>new Date(Date.parse(now)+899999).toISOString()});assert.equal(f.calls.length,1);
  await f.refresh(['EXAMPLE'],{...options(payload()),now:()=>new Date(Date.parse(now)+900000).toISOString()});assert.equal(f.calls.length,2);
  f.state.holdings[f.accountId].EXAMPLE.position.security.broker_security_id='changed';r=await f.run({action:'read'});assert.equal(r.items[0].valid,false);assert.equal(r.items[0].quote,null);await assert.rejects(f.refresh(),/mapping/);
});
test('partial failures retain the last good cache and successful siblings; limits and unavailable configuration isolate cleanly',async()=>{
  const f=await setup();await f.map();await f.map('FUND');await f.refresh();
  const later=new Date(Date.parse(now)+900000).toISOString();const opts={...options({}),now:()=>later,fetchImpl:async url=>new Response(JSON.stringify(url.searchParams.get('symbol')==='FUND'?payload({symbol:'FUND',close:'8'}):{status:'error',code:429}))};
  const r=await f.refresh(['EXAMPLE','FUND'],opts);assert.equal(r.items[0].error.code,'rate_limit');assert.equal(r.items[0].quote.price,'90.00001');assert.equal(r.items[1].quote.price,'8');
  const missing=await f.refresh(['EXAMPLE'],{now:()=>later});assert.equal(missing.items[0].error.code,'unconfigured');assert.equal(missing.items[0].quote.price,'90.00001');
  f.repo.claim=async()=> 'busy';assert.equal((await f.refresh(['EXAMPLE'],{...opts,now:()=>later})).items[0].error.code,'busy');
  await assert.rejects(f.refresh(Array(9).fill('EXAMPLE')),/1–8/);
});
test('failed cache writes do not substitute unsaved or zero prices',async()=>{
  const f=await setup();await f.map();f.repo.save=async()=>{throw Error('db secret');};const r=await f.refresh();assert.equal(r.items[0].quote,null);assert.equal(r.items[0].error.code,'cache_write');assert(!JSON.stringify(r).includes('db secret'));
});
test('provider valuations distinguish sources, stale cache, scenario fallback, future quotes and scenario-only mode',async()=>{
  const f=await setup();await f.map();const r=await f.refresh(),scenario=prepareScenarioPrice(f.state,{accountId:f.accountId,symbol:'EXAMPLE',price:'80',currency:'USD',reference:'Synthetic scenario',observedAt:now});
  const combine=(items=r.items,mode)=>combineValuationPrices(f.state,[scenario],items,now,mode);
  assert.equal(combine()[0].kind,'provider');assert.equal(combine(r.items,'scenario')[0].kind,'user-scenario');
  const failed=r.items.map(i=>({...i,error:{message:'Unavailable'},cacheStatus:'stale'}));assert(combine(failed)[0].fallbackReason);assert.equal(buildValuation(f.state,combine(failed),now).find(r=>r.symbol==='EXAMPLE').marketValue,'160');
  const stale=combineValuationPrices(f.state,[],failed,now);assert.equal(stale[0].quoteWarning,'Unavailable');assert.equal(stale[0].kind,'provider');
  const future=r.items.map(i=>({...i,quote:{...i.quote,observedAt:'2026-09-16T18:00:00.000Z'}}));assert.equal(combine(future)[0].kind,'user-scenario');
  const excluded=buildValuation(f.state,combineValuationPrices(f.state,[],future,now),now).find(r=>r.symbol==='EXAMPLE');assert.equal(excluded.pnl,null);assert.equal(excluded.priceStatus,'future');
});
test('database UTC offsets normalize to valuation timestamps without losing market time',async()=>{
  const f=await setup();await f.map();await f.refresh();const q=f.cache.get(quoteKey(mapping));q.observed_at=q.observed_at.replace('Z','+00:00');q.fetched_at=q.fetched_at.replace('Z','+00:00');const r=await f.run({action:'read'});assert.equal(r.items[0].quote.observedAt,now);assert.equal(r.items[0].quote.fetchedAt,now);
  const selected=combineValuationPrices(f.state,[],r.items,now);assert.equal(buildValuation(f.state,selected,now).find(r=>r.symbol==='EXAMPLE').priceStatus,'recent');
});

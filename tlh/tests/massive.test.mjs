import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchMassiveDaily,massiveService,previousWeekday} from '../server/massive-service.mjs';
import {buildValuation} from '../src/valuation/engine.mjs';
const now=()=> '2026-09-22T18:00:00.000Z',date='2026-09-21';
const result={status:'OK',adjusted:false,resultsCount:1,results:[{T:'MSFT',c:123.4567,t:Date.parse('2026-09-21T20:00:00Z')}]};
const options=data=>({now,massiveApiKey:'secret',fetchImpl:async url=>{assert.equal(url.searchParams.get('adjusted'),'false');return new Response(JSON.stringify(data));}});
test('Massive bulk prices preserve decimals, date and unadjusted evidence',async()=>{
  const r=await fetchMassiveDaily(date,options(result));assert.equal(r.batch.prices.MSFT.price,'123.4567');assert.equal(r.batch.price_date,date);
  assert.equal(previousWeekday('2026-09-21T18:00:00Z'),'2026-09-18');
  for(const extra of [{adjusted:true},{resultsCount:2},{status:'ERROR'},{results:[{...result.results[0],t:Date.parse('2026-09-20T20:00:00Z')}]},{results:[{...result.results[0],c:-1}]}])assert((await fetchMassiveDaily(date,options({...result,...extra}))).error);
  assert((await fetchMassiveDaily(date,options({...result,resultsCount:2,results:[...result.results,...result.results]}))).error);
});
test('one bulk request prices owned exact USD holdings, reuses cache, and retains data on failure',async()=>{
  const account='11111111-1111-4111-8111-111111111111',holding={active:true,position:{security:{symbol:'MSFT'},currency:'USD',quantity:'2',total_basis:'100'},confirmedCurrency:null};
  const state={accounts:[{id:account,label:'test'}],holdings:{[account]:{MSFT:holding,FOREIGN:{...holding,position:{...holding.position,security:{symbol:'FOREIGN'},currency:'EUR'}}}},corrections:[]};
  let batch=null,calls=0,claims=0;
  const repo={snapshot:async()=>structuredClone(state),dailyRead:async d=>!d||batch?.price_date===d?batch:null,dailyClaim:async()=>{claims++;return 'ok';},dailySave:async b=>{batch=b;},dailyRelease:async()=>{}};
  const opts={...options(result),fetchImpl:async()=>{calls++;return new Response(JSON.stringify(result));}};
  let r=await massiveService(repo,'user',{action:'daily-refresh',date},opts);assert.equal(r.items[0].quote.price,'123.4567');assert.equal(r.items[1].quote,null);assert.equal(r.items[1].valid,false);
  await massiveService(repo,'user',{action:'daily-refresh',date},opts);assert.equal(calls,1);assert.equal(claims,1);
  r=await massiveService(repo,'user',{action:'daily-refresh',date:'2026-09-18'},{...opts,fetchImpl:async()=>new Response('secret',{status:403})});assert.equal(r.priceDate,date);assert(r.error);assert(!JSON.stringify(r).includes('secret'));
  assert.deepEqual(await repo.snapshot(),state);
  await assert.rejects(massiveService(repo,'user',{action:'daily-refresh',date:'2026-09-22'},opts),/completed date/);
});
test('full market batch handles repeated and distinct timestamps without losing date validation',async()=>{
 const rows=Array.from({length:15000},(_,i)=>({T:`S${i}`,c:123.45,t:Date.parse('2026-09-21T20:00:00Z')+(i%3)*1000}));
 rows.push({T:'WRONGDAY',c:1,t:Date.parse('2026-09-20T20:00:00Z')});
 const r=await fetchMassiveDaily(date,options({status:'OK',adjusted:false,resultsCount:rows.length,results:rows}));
 assert.equal(Object.keys(r.batch.prices).length,15000);assert.equal(r.batch.prices.S14999.price,'123.45');assert.equal(r.batch.prices.WRONGDAY,undefined);
});
test('reviewed Berkshire share-class alias prices the original holding without rewriting arbitrary symbols',async()=>{
 const holding=symbol=>({active:true,position:{security:{symbol},currency:'USD',quantity:'1',total_basis:'100'}});
 const state={accounts:[{id:'a'}],holdings:{a:{'BRK/B':holding('BRK/B'),'OTHER/B':holding('OTHER/B'),FSKAX:holding('FSKAX')}}};
 const repo={dailyRead:async()=>({price_date:date,fetched_at:now(),prices:{'BRK.B':{price:'500',barAt:now()}}}),snapshot:async()=>state};
 const r=await massiveService(repo,'u',{action:'read'},{now});
 assert.equal(r.items[0].symbol,'BRK/B');assert.equal(r.items[0].quote.providerSymbol,'BRK.B');assert.equal(r.items[0].quote.security.symbol,'BRK/B');assert.equal(r.items[1].quote,null);assert.match(r.items[2].error.message,/fund NAV/);
});

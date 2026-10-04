import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lookupListing} from '../server/listing-lookup.mjs';
import {runQuoteQueue} from '../src/valuation/quote-queue.mjs';
const listing={symbol:'MSFT',mic_code:'XNGS',country:'United States',currency:'USD',instrument_type:'Common Stock'};
const lookup=data=>lookupListing('MSFT',{apiKey:'secret',fetchImpl:async()=>new Response(JSON.stringify({data}))},{XNGS:'NASDAQ Global Select',XNYS:'NYSE'});
test('listing matching rejects ambiguous, unsupported, foreign, alias and truncated searches',async()=>{
  assert.equal((await lookup([listing])).listing.mic_code,'XNGS');
  assert.equal((await lookup([listing,{...listing,mic_code:'IEXG'}])).listing.mic_code,'XNGS');
  for(const rows of [[listing,{...listing,mic_code:'XNYS'}],[{...listing,symbol:'MSFT.A'}],[{...listing,currency:'EUR'}],[{...listing,country:'Canada'}],[{...listing,instrument_type:'Warrant'}],Array(120).fill(listing)])assert.equal((await lookup(rows)).error.code,'review');
});
test('bulk queue maps once, preserves existing mappings, paces refresh and reports exceptions',async()=>{
  const rows=['A','B','C'].map(symbol=>({accountId:'account',symbol})),calls=[],waits=[],issues=[];
  const items=[{...rows[0],valid:true,mapping:{providerSymbol:'A',mic:'XNYS'},quote:null}];
  await runQuoteQueue({rows,signal:new AbortController().signal,wait:async ms=>waits.push(ms),publish:()=>{},progress:(_m,i)=>issues.splice(0,issues.length,...i),request:async body=>{
    calls.push(body);
    let automatic=null;
    if(body.action==='automap'){if(body.symbol==='B'){items.push({...rows[1],valid:true,mapping:{providerSymbol:'B',mic:'XNYS'},quote:null});automatic={code:'matched'};}else automatic={code:'review',message:'No match'};}
    if(body.action==='refresh'){const item=items.find(i=>i.symbol===body.holdings[0].symbol);item.quote={fetchedAt:new Date().toISOString()};}
    return {items:structuredClone(items),automatic};
  }});
  assert.deepEqual(calls.filter(c=>c.action==='automap').map(c=>c.symbol),['B','C']);
  assert.equal(calls.filter(c=>c.action==='refresh').length,2);assert.equal(issues[0].symbol,'C');assert(waits.every(ms=>ms===8000));
});
test('stopping during a paced wait prevents the next provider action',async()=>{
  const controller=new AbortController(),calls=[];
  await runQuoteQueue({rows:[{accountId:'a',symbol:'A'},{accountId:'a',symbol:'B'}],signal:controller.signal,wait:async()=>controller.abort(),publish:()=>{},progress:()=>{},request:async b=>{calls.push(b);return {items:[],automatic:{code:'review'}};}});
  assert.equal(calls.filter(c=>c.action==='automap').length,1);
});
test('persistent quota exhaustion retries once then stops instead of looping',async()=>{
  const waits=[],calls=[];
  await assert.rejects(runQuoteQueue({rows:[{accountId:'a',symbol:'A'}],signal:new AbortController().signal,wait:async ms=>waits.push(ms),publish:()=>{},progress:()=>{},request:async b=>{calls.push(b);return {items:[],automatic:{code:'rate_limit'}};}}),/resume later/);
  assert.equal(calls.filter(c=>c.action==='automap').length,2);assert.deepEqual(waits,[61000]);
});

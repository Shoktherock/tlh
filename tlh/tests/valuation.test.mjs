import {test} from 'node:test';
import assert from 'node:assert/strict';
import {multiply,subtract,total,prepareScenarioPrice,buildValuation,valuationSummary} from '../src/valuation/engine.mjs';
import {sampleFiles} from '../src/sample.mjs';
import {readSource} from '../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../src/import/engine.mjs';
import {previewCorrection,acceptCorrection} from '../src/import/corrections.mjs';
const now='2026-09-13T12:00:00.000Z';
async function fixture(){let s=emptyState();const sources=await Promise.all(sampleFiles().map(readSource));for(const label of ['Taxable A','IRA B']){const plan=await previewImport(s,sources,{accountId:null,accountLabel:label,accountType:label==='IRA B'?'traditional_ira':'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});s=acceptPreview(s,plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic valuation input.'}).state;}return s;}
const price=(s,extra={})=>prepareScenarioPrice(s,{accountId:s.accounts[0].id,symbol:'EXAMPLE',price:'90',currency:'USD',reference:'Synthetic test price',observedAt:now,...extra});

test('valuation arithmetic is exact for fractional quantities, large values, signed losses and cancellation',()=>{
  assert.equal(multiply('0.1','0.2'),'0.02');assert.equal(subtract('0.02','0.03'),'-0.01');
  assert.equal(multiply('100000000000000000.0001','0.00001'),'1000000000000.000000001');
  assert.equal(multiply('1'+'0'.repeat(220),'2'),'2'+'0'.repeat(220));
  assert.equal(total(['-0.01','0.03','-0.02']),'0');assert.equal(subtract('0','0.00'),'0');assert.equal(multiply(null,'100'),null);assert.equal(subtract('10',null),null);
});

test('prices stay account-scoped, duplicate lots stay separate, and position totals never include lot values twice',async()=>{
  const state=await fixture(),before=structuredClone(state),rows=buildValuation(state,[price(state)],now);
  const a=rows.find(r=>r.accountId===state.accounts[0].id&&r.symbol==='EXAMPLE'),b=rows.find(r=>r.accountId===state.accounts[1].id&&r.symbol==='EXAMPLE');
  assert.equal(a.marketValue,'180');assert.equal(a.pnl,'-20');assert.equal(a.lots.length,2);assert.deepEqual(a.lots.map(l=>l.pnl),['-10','-10']);assert.equal(b.pnl,null);
  const summary=valuationSummary(rows)[0];assert.equal(summary.marketValue,'180');assert.equal(summary.pnl,'-20');assert.equal(summary.knownPnl,1);assert.equal(summary.positions,6);assert.deepEqual(state,before);
});

test('unknown basis, currencies and missing prices are excluded explicitly; zero price stays a real zero',async()=>{
  const state=await fixture(),id=state.accounts[0].id;state.holdings[id].EXAMPLE.position.total_basis=null;
  let rows=buildValuation(state,[price(state,{price:'0'})],now),row=rows.find(r=>r.accountId===id&&r.symbol==='EXAMPLE');assert.equal(row.marketValue,'0');assert.equal(row.pnl,null);assert(row.reasons.includes('Cost basis is unknown'));
  const summary=valuationSummary(rows)[0];assert.equal(summary.marketValue,'0');assert.equal(summary.pnl,null);assert.equal(summary.knownPnl,0);
  state.holdings[id].EXAMPLE.confirmedCurrency=null;rows=buildValuation(state,[price(state)],now);row=rows.find(r=>r.accountId===id&&r.symbol==='EXAMPLE');assert.equal(row.marketValue,null);assert(row.reasons.includes('Evidence currency is unknown'));
});

test('price freshness uses the explicit valuation time; future and invalid prices never create artificial losses',async()=>{
  const state=await fixture();const get=p=>buildValuation(state,[p],now).find(r=>r.accountId===state.accounts[0].id&&r.symbol==='EXAMPLE');
  assert.equal(get(price(state,{observedAt:'2026-09-13T11:45:00Z'})).priceStatus,'recent');
  const stale=get(price(state,{observedAt:'2026-09-13T11:44:59Z'}));assert.equal(stale.priceStatus,'stale');assert.equal(stale.pnl,'-20');
  assert.equal(get(price(state,{observedAt:null})).priceStatus,'time-unknown');
  assert.equal(get(price(state,{observedAt:'2026-09-13T12:00:01Z'})).pnl,null);
  assert.equal(get({...price(state),price:'NaN'}).pnl,null);assert.equal(get({...price(state),security:{symbol:'OTHER'}}).priceStatus,'invalid');
  assert.throws(()=>price(state,{observedAt:'2026-02-30T12:00:00Z'}),/timestamp/);assert.throws(()=>buildValuation(state,[],'bad'),/valuation date/);
});

test('currency groups do not mix and conflicting price/source currencies block arithmetic',async()=>{
  const state=await fixture(),a=state.accounts[0].id,b=state.accounts[1].id;
  state.holdings[b].EXAMPLE.confirmedCurrency='EUR';let rows=buildValuation(state,[price(state),price(state,{accountId:b,currency:'EUR',price:'120'})],now);
  const summary=valuationSummary(rows);assert.equal(summary.find(s=>s.currency==='USD').pnl,'-20');assert.equal(summary.find(s=>s.currency==='EUR').pnl,'40');
  rows=buildValuation(state,[price(state,{currency:'EUR'})],now);assert.equal(rows.find(r=>r.accountId===a&&r.symbol==='EXAMPLE').marketValue,null);
  state.holdings[a].EXAMPLE.position.currency='EUR';rows=buildValuation(state,[price(state,{currency:'EUR'})],now);const conflict=rows.find(r=>r.accountId===a&&r.symbol==='EXAMPLE');assert.equal(conflict.pnl,null);assert(conflict.reasons.includes('Reported and confirmed currencies conflict'));
});

test('applied corrections affect valuations; suspended corrections and retained/position-only evidence remain visible',async()=>{
  let state=await fixture();const id=state.accounts[0].id;
  const correction=previewCorrection(state,{baseRevision:state.revision,accountId:id,symbol:'EXAMPLE',kind:'set',target:{section:'position',field:'total_basis'},value:'190',reason:'Synthetic corrected basis.'},'test-actor');state=acceptCorrection(state,correction,{reviewed:true}).state;
  let rows=buildValuation(state,[price(state)],now),row=rows.find(r=>r.accountId===id&&r.symbol==='EXAMPLE');assert.equal(row.pnl,'-10');assert(row.issues.length>0);assert.equal(state.holdings[id].EXAMPLE.position.total_basis,'200.00');
  state.holdings[id].EXAMPLE.position.source_id='later-source';state.holdings[id].EXAMPLE.lotCoverage='retained';row=buildValuation(state,[price(state)],now).find(r=>r.accountId===id&&r.symbol==='EXAMPLE');assert.equal(row.pnl,'-20');assert.equal(row.corrections[0].status,'conflict');assert(row.issues.some(i=>i.title==='Previous lots retained'));
  const noLots=rows.find(r=>r.accountId===id&&r.symbol==='000CVR000');assert.equal(noLots.lots.length,0);assert(noLots.issues.some(i=>i.category==='Lot coverage'));
  state.holdings[id].EXAMPLE.active=false;assert(!buildValuation(state,[],now).some(r=>r.accountId===id&&r.symbol==='EXAMPLE'));
});

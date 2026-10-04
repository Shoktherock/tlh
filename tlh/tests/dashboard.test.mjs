import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildDashboard} from '../src/valuation/dashboard.mjs';
import {prepareScenarioPrice,total} from '../src/valuation/engine.mjs';
import {sampleSnapshot} from '../src/sample.mjs';
import {readSource} from '../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../src/import/engine.mjs';
const asOf='2026-09-18T12:00:00Z';
async function fixture(){
  const snapshot=structuredClone(sampleSnapshot);
  for(const record of [...snapshot.accounts[0].positions,...snapshot.accounts[0].lot_scopes])record.effective_at=asOf;
  const lots=snapshot.accounts[0].lot_scopes[0].lots;lots[0].acquisition_date='2026-09-01';lots[0].broker_holding_period='Short Term';
  const p=await previewImport(emptyState(),[await readSource({name:'synthetic.json',text:JSON.stringify(snapshot)})],{accountId:null,accountLabel:'Same name',accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});
  const state=acceptPreview(emptyState(),p,{symbols:p.rows.map(r=>r.symbol),includeCash:false,mappingReviewed:true,timingReviewed:true,reason:'Dashboard fixture'}).state,id=state.accounts[0].id;
  state.accounts[0].portfolioId='portfolio-a';state.cash[id]={amount:'12.34',currency:'USD',effective_date:'2026-09-01'};
  const prices=[prepareScenarioPrice(state,{accountId:id,symbol:'EXAMPLE',price:'90',currency:'USD',reference:'Synthetic price',observedAt:asOf})];
  return {state,prices,asOf,termDate:'2026-09-18',ordinaryPurchase:true};
}
test('dashboard partitions position P/L into terms exactly and never adds lots or cash to securities',async()=>{
  const f=await fixture(),before=structuredClone(f),r=buildDashboard(f),t=r.totals[0];
  assert.equal(t.marketValue,'180');assert.equal(t.pnl,'-20');assert.equal(t.short,'-10');assert.equal(t.long,'-10');assert.equal(t.unresolved,'0');assert.equal(t.cash,'12.34');assert.equal(t.basis,'250');assert.equal(t.priced,1);assert.equal(t.positions,2);assert.equal(t.unavailablePnl,1);assert.equal(total([t.short,t.long,t.unresolved]),t.pnl);assert.deepEqual(f,before);
});
test('unconfirmed or missing terms are unresolved amounts, while unavailable P/L remains unknown',async()=>{
  const f=await fixture();let t=buildDashboard({...f,ordinaryPurchase:false}).totals[0];assert.equal(t.unresolved,'-20');assert.equal(t.long,'0');
  f.state.holdings[f.state.accounts[0].id].EXAMPLE.lotScope.lots[0].acquisition_date=null;t=buildDashboard(f).totals[0];assert.equal(t.unresolved,'-10');assert.equal(t.long,'-10');
  t=buildDashboard({...f,prices:[]}).totals[0];assert.equal(t.pnl,null);assert.equal(t.short,null);assert.equal(t.unresolved,null);assert.equal(t.unavailablePnl,2);
});
test('incomplete, mismatched and differently dated lot scopes cannot produce a misleading term partition',async()=>{
  for(const change of [h=>h.lotCoverage='retained',h=>h.lotScope=null,h=>h.lotScope.lots[0].quantity='0.5',h=>h.lotScope.effective_at='2026-09-17T12:00:00Z',h=>h.position.total_basis='201']){
    const f=await fixture(),h=f.state.holdings[f.state.accounts[0].id].EXAMPLE;change(h);const r=buildDashboard(f),t=r.totals[0];assert.equal(t.short,'0');assert.equal(t.long,'0');assert.equal(t.unresolved,t.pnl);assert(r.rows[0].terms.reasons.length>0);
  }
});
test('portfolio and account filters use identity rather than duplicate labels; empty accounts stay visible',async()=>{
  const f=await fixture(),a=f.state.accounts[0];f.state.accounts.push({...a,id:'second',portfolioId:'portfolio-b'},{...a,id:'empty',portfolioId:'portfolio-a'});f.state.holdings.second=structuredClone(f.state.holdings[a.id]);f.state.holdings.empty={};
  let r=buildDashboard({...f,portfolioId:'portfolio-a'});assert.equal(r.accounts.length,2);assert.equal(r.positions,2);assert.equal(r.accounts.find(a=>a.id==='empty').positions,0);
  r=buildDashboard({...f,accountId:'second'});assert.equal(r.accounts.length,1);assert.equal(r.priced,0);assert.equal(r.totals[0].pnl,null);
});
test('multiple currencies and unknown cash never become a single monetary total',async()=>{
  const f=await fixture(),a=f.state.accounts[0];f.state.accounts.push({...a,id:'euro'},{...a,id:'unknown'});f.state.holdings.euro={};f.state.holdings.unknown={};f.state.cash.euro={amount:'9.99',currency:'EUR'};f.state.cash.unknown={amount:'999',currency:null};
  let r=buildDashboard(f);assert.equal(r.totals.find(t=>t.currency==='EUR').cash,'9.99');assert.equal(r.totals.find(t=>t.currency==='USD').cash,'12.34');assert.equal(r.totals.find(t=>t.currency==='Unknown').cash,null);
  f.state.cash.euro.confirmedCurrency='USD';r=buildDashboard(f);assert.equal(r.cash.find(c=>c.accountId==='euro').usable,false);assert.equal(r.totals.find(t=>t.currency==='USD').cash,'12.34');
});
test('zero prices stay zero, future prices are unavailable and stale prices keep visible freshness counts',async()=>{
  const f=await fixture();f.prices[0].price='0';let r=buildDashboard(f);assert.equal(r.totals[0].marketValue,'0');assert.equal(r.totals[0].pnl,'-200');
  f.prices[0].observedAt='2026-09-19T12:00:00Z';r=buildDashboard(f);assert.equal(r.totals[0].pnl,null);assert.equal(r.accounts[0].prices.future,1);
  f.prices[0].observedAt='2026-09-17T12:00:00Z';r=buildDashboard(f);assert.equal(r.totals[0].pnl,'-200');assert.equal(r.accounts[0].prices.stale,1);
});
test('cash-only and empty workspaces remain useful without invented holdings or currency totals',async()=>{
  const f=await fixture();f.state.holdings={};const r=buildDashboard(f);assert.equal(r.positions,0);assert.equal(r.totals[0].marketValue,null);assert.equal(r.totals[0].cash,'12.34');
  assert.deepEqual(buildDashboard({...f,state:emptyState()}).totals,[]);assert.throws(()=>buildDashboard({...f,termDate:'2026-02-30'}),/valid/);
});

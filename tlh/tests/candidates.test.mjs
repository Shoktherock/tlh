import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildCandidates,ordinaryHoldingTerm,shiftDate} from '../src/analysis/candidates.mjs';
import {defaultInputs} from '../src/analysis/inputs.mjs';
import {sampleSnapshot} from '../src/sample.mjs';
import {readSource} from '../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../src/import/engine.mjs';
import {prepareScenarioPrice} from '../src/valuation/engine.mjs';
import {emptyActivity,previewActivity,activityTemplate} from '../src/activity/engine.mjs';
const asOf='2026-09-18T12:00:00Z',sale='2026-09-18';
async function fixture(){
  let state=emptyState();const snapshot=structuredClone(sampleSnapshot);
  for(const a of snapshot.accounts)for(const record of [...a.positions,...a.lot_scopes]){record.effective_at=asOf;record.effective_date=null;}
  const sources=[await readSource({name:'synthetic.json',text:JSON.stringify(snapshot)})];
  for(const [label,type] of [['Taxable','taxable'],['IRA','roth_ira']]){const p=await previewImport(state,sources,{accountId:null,accountLabel:label,accountType:type,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});state=acceptPreview(state,p,{symbols:p.rows.map(r=>r.symbol),includeCash:false,mappingReviewed:true,timingReviewed:true,reason:'Synthetic analysis'}).state;}
  const input=defaultInputs(state.accounts);input.analysisDate=sale;input.minLoss.amount='0';input.rates={federalShort:'30',federalLong:'15',state:'5'};input.household='all_known_listed';for(const a of input.accounts)a.scope='include';
  const prices=[prepareScenarioPrice(state,{accountId:state.accounts[0].id,symbol:'EXAMPLE',price:'90',currency:'USD',reference:'Synthetic scenario',observedAt:asOf})];
  return {state,prices,asOf,input,activity:emptyActivity(),today:'2026-11-01',ordinaryPurchase:true};
}
async function batch(f,accountId,rows=[],coverage={start:'2026-08-19',end:'2026-10-18',status:'complete',noActivity:!rows.length}){
  const doc={...activityTemplate(),reference:'Synthetic history',coverage,rows};const p=await previewActivity(f.activity,accountId,{name:'history.json',text:JSON.stringify(doc)});
  f.activity.events.push({...p.batch,actor:'synthetic',at:asOf});return p;
}
const buy=(date,quantity='0.25',extra={})=>({...activityTemplate().rows[0],rowRef:crypto.randomUUID(),date,quantity,symbol:'EXAMPLE',...extra});
const candidates=f=>buildCandidates(f).rows.filter(r=>r.candidate);
test('calendar terms use anniversaries, exclude acquisition day and include sale day; leap dates and 30-day windows are exact',()=>{
  assert.equal(ordinaryHoldingTerm('2025-09-18','2026-09-18'),'short');assert.equal(ordinaryHoldingTerm('2025-09-18','2026-09-19'),'long');assert.equal(ordinaryHoldingTerm('2024-02-29','2025-02-28'),'short');assert.equal(ordinaryHoldingTerm('2024-02-29','2025-03-01'),'long');assert.equal(ordinaryHoldingTerm(null,sale),'unknown');assert.equal(ordinaryHoldingTerm('2027-01-01',sale),'unknown');assert.equal(shiftDate('2024-03-01',-30),'2024-01-31');assert.equal(shiftDate(sale,30),'2026-10-18');
});
test('separate lot rows yield exact losses and conditional arithmetic without adding position totals or mutating input',async()=>{
  const f=await fixture(),before=structuredClone(f),r=candidates(f);assert.equal(r.length,2);assert.deepEqual(r.map(x=>x.loss),['10','10']);assert.deepEqual(r.map(x=>x.scenarioSavings),['2','2']);assert(r.every(x=>x.screen.status==='insufficient_history'));assert.notEqual(r[0].key,r[1].key);assert.deepEqual(f,before);
});
test('scope, taxable classification, per-lot threshold and currency exclusions stay visible',async()=>{
  const f=await fixture();f.input.minLoss.amount='10.0001';assert.equal(candidates(f).length,0);f.input.minLoss.amount='10';assert.equal(candidates(f).length,2);f.input.minLoss.currency='EUR';assert.equal(candidates(f).length,0);f.input.minLoss.currency='USD';f.input.accounts[0].scope='omit';f.input.accounts[0].reason='Excluded test';assert.equal(candidates(f).length,0);assert(buildCandidates(f).rows.some(r=>r.excluded.some(x=>x.includes('taxable'))));
});
test('missing/zero prices, unknown basis, incomplete lots and future snapshots never manufacture candidates',async()=>{
  const f=await fixture();assert.equal(candidates({...f,prices:[]}).length,0);f.prices[0].price='0';assert.equal(candidates(f)[0].loss,'100');const h=f.state.holdings[f.state.accounts[0].id].EXAMPLE;h.lotScope.lots[0].total_basis=null;assert.equal(candidates(f).length,1);h.lotCoverage='retained';assert.equal(candidates(f).length,0);h.lotCoverage='complete';f.input.analysisDate='2026-09-17';assert.equal(candidates(f).length,0);
});
test('term assumptions, unknown dates and broker-date conflicts withhold tax arithmetic; zero rates remain zero',async()=>{
  const f=await fixture();assert.equal(candidates({...f,ordinaryPurchase:false})[0].term.term,'unknown');assert.equal(candidates({...f,ordinaryPurchase:false})[0].scenarioSavings,null);f.input.rates={federalShort:'0',federalLong:'0',state:'0'};assert.equal(candidates(f)[0].scenarioSavings,'0');f.state.holdings[f.state.accounts[0].id].EXAMPLE.lotScope.lots[0].broker_holding_period='Short Term';assert.equal(candidates(f).find(r=>r.index===0).term.term,'unknown');f.input.rates.state=null;assert(candidates(f).every(r=>r.scenarioSavings===null));
});
test('inclusive ±30-day acquisitions flag even in omitted IRA accounts; fractional quantities are retained without allocations',async()=>{
  const f=await fixture(),ira=f.state.accounts[1].id;f.input.accounts[1].scope='omit';f.input.accounts[1].reason='Not a harvesting account';
  await batch(f,ira,[buy('2026-08-18'),buy('2026-08-19','0.125'),buy('2026-10-18','0.5'),buy('2026-10-19')],{start:'2026-08-18',end:'2026-10-19',status:'partial',noActivity:false});
  const s=candidates(f)[0].screen;assert.equal(s.status,'possible_acquisition');assert.deepEqual(s.evidence.map(e=>e.quantity),['0.125','0.5']);assert(s.evidence.every(e=>e.accountType==='roth_ira'));assert.equal(s.matchedQuantity,null);assert.equal(s.disallowedLoss,null);
});
test('only candidate snapshot row is excluded as original; same-date lots and ambiguous original activity remain distinct',async()=>{
  const f=await fixture(),id=f.state.accounts[0].id,h=f.state.holdings[id].EXAMPLE;
  for(const l of h.lotScope.lots){l.acquisition_date='2026-09-01';l.broker_holding_period='Short Term';}
  await batch(f,id,[buy('2026-09-01','1')]);const s=candidates(f)[0].screen;
  assert.equal(s.excludedOriginal.length,1);assert.equal(s.evidence.filter(e=>e.kind==='snapshot').length,1);assert.equal(s.evidence.filter(e=>e.possibleOriginal).length,1);assert(s.evidence.find(e=>e.kind==='snapshot').sourceId);
});
test('history declarations cannot clear future windows, missing household accounts or unknown transactions',async()=>{
  const f=await fixture();for(const a of f.state.accounts)await batch(f,a.id);
  assert.equal(candidates(f)[0].screen.status,'no_same_symbol_acquisition_observed');assert.equal(candidates({...f,today:sale})[0].screen.status,'insufficient_history');f.input.household='not_reviewed';assert.equal(candidates(f)[0].screen.status,'insufficient_history');f.input.household='all_known_listed';
  await batch(f,f.state.accounts[0].id,[buy(null,null,{symbol:null})],{start:'2026-09-01',end:'2026-09-30',status:'partial',noActivity:false});assert.equal(candidates(f)[0].screen.status,'possible_acquisition');assert(candidates(f)[0].screen.gaps.length>0);
});
test('withdrawn activity is not screened, disposals and transfers remain unresolved rather than netting away acquisitions',async()=>{
  const f=await fixture();const p=await batch(f,f.state.accounts[0].id,[buy('2026-09-10'),buy('2026-09-11','0.25',{action:'sell'}),buy('2026-09-12','0.25',{action:'transfer_in'})]);
  let s=candidates(f)[0].screen;assert.equal(s.evidence.length,1);assert.equal(s.uncertainties.length,2);
  f.activity.events.push({kind:'withdraw',id:crypto.randomUUID(),batchId:p.batch.id,reason:'Synthetic withdrawal',actor:'test',at:asOf});s=candidates(f)[0].screen;assert.equal(s.evidence.length,0);assert.equal(s.status,'insufficient_history');
});
test('stale, conflicting and mixed-date evidence remains visible but withholds tax arithmetic',async()=>{
  const f=await fixture();f.prices[0].observedAt='2026-09-17T12:00:00Z';let r=candidates(f)[0];assert.equal(r.loss,'10');assert.equal(r.scenarioSavings,null);assert(r.warnings.some(x=>x.includes('15 minutes')));f.prices[0].observedAt=asOf;f.state.holdings[f.state.accounts[0].id].EXAMPLE.position.total_basis='201';r=buildCandidates(f).rows.find(r=>r.symbol==='EXAMPLE'&&r.accountId===f.state.accounts[0].id);assert.equal(r.scenarioSavings,null);assert.equal(r.candidate,false);assert(r.warnings.some(x=>x.includes('differ')));
});
test('available rate scenarios rank exactly and a historical short-term label can mature to long-term',async()=>{
  const f=await fixture(),id=f.state.accounts[0].id,fund=f.state.holdings[id].FUND;
  for(const l of fund.lotScope.lots){l.acquisition_date='2026-09-01';l.broker_holding_period='Short Term';}
  f.prices.push(prepareScenarioPrice(f.state,{accountId:id,symbol:'FUND',price:'60',currency:'USD',reference:'Synthetic ranking',observedAt:asOf}));
  const rows=candidates(f);assert.deepEqual(rows.map(r=>r.symbol),['FUND','FUND','EXAMPLE','EXAMPLE']);assert.deepEqual(rows.map(r=>r.scenarioSavings),['3.5','3.5','2','2']);
  const h=f.state.holdings[id].EXAMPLE;h.lotScope.effective_at='2025-06-01T12:00:00Z';for(const l of h.lotScope.lots)l.broker_holding_period='Short Term';assert.equal(candidates(f).find(r=>r.symbol==='EXAMPLE').term.term,'long');
});

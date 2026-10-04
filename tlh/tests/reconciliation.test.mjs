import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconciliationIssues} from '../src/import/reconciliation.mjs';

function fixture(){
  const position={quantity:'0.3',total_basis:'30.00',currency:'USD',effective_date:'2026-09-08',source_id:'positions',source_ref:'row-3'};
  const scope={status:'complete',effective_date:'2026-09-08',source_id:'lots',source_ref:'panel/EXAMPLE',reported_totals:{quantity:'0.300',total_basis:'30.00'},lots:[{row_ref:'one',quantity:'0.1',total_basis:'10',currency:'USD',acquisition_date:'2025-01-01'},{row_ref:'two',quantity:'0.2',total_basis:'20',currency:'USD',acquisition_date:'2025-01-01'}]};
  return {accounts:[{id:'a',label:'Account A'}],holdings:{a:{EXAMPLE:{active:true,position,lotScope:scope,lotCoverage:'complete',confirmedCurrency:'USD',warnings:[],unresolved:false,lastImportId:'recent'}}},imports:[{id:'original',accountId:'a',acceptedAt:'2026-09-08',sources:[{id:'lots',name:'old-lots.json',path:'a/old'}],decisions:{reason:'Original'}},{id:'recent',accountId:'a',acceptedAt:'2026-09-09',sources:[{id:'positions',name:'positions.csv',path:'a/new'}],decisions:{reason:'Current'}}]};
}
test('exact decimals and matching evidence produce no issue without modifying state',()=>{
  const state=fixture(),before=JSON.stringify(state);assert.deepEqual(reconciliationIssues(state),[]);assert.equal(JSON.stringify(state),before);
});
test('position discrepancies are scoped by field; different effective dates suppress same-time claims',()=>{
  const state=fixture(),h=state.holdings.a.EXAMPLE;h.position.quantity='0.4';h.position.total_basis='40';
  let issues=reconciliationIssues(state);assert.deepEqual(issues.map(i=>i.code).sort(),['ROWS_POSITION_quantity','ROWS_POSITION_total_basis']);
  assert.equal(issues[0].totals.rows.quantity,'0.3');
  h.lotScope.effective_date='2026-09-07';h.lotScope.reported_totals.quantity='0.5';issues=reconciliationIssues(state);
  assert.ok(issues.some(i=>i.code==='EFFECTIVE_TIMES_DIFFER'));assert.ok(issues.some(i=>i.code==='ROWS_REPORTED_quantity'));assert.ok(!issues.some(i=>i.code.startsWith('ROWS_POSITION')));
  h.lotScope.effective_date=null;issues=reconciliationIssues(state);assert.match(issues.find(i=>i.code==='ROWS_POSITION_quantity').message,/not a verified same-time/);
});
test('unknown basis is not zero and duplicate lot rows retain their identities',()=>{
  const state=fixture(),h=state.holdings.a.EXAMPLE;h.lotScope.lots[1]={...h.lotScope.lots[0],row_ref:'two'};h.position.quantity='0.2';h.lotScope.reported_totals.quantity='0.2';h.position.total_basis='20';h.lotScope.reported_totals.total_basis='20';
  assert.deepEqual(reconciliationIssues(state),[]);
  h.lotScope.lots[1].total_basis=null;h.lotScope.lots[0].acquisition_date=null;
  const issues=reconciliationIssues(state);assert.equal(issues.find(i=>i.code==='LOT_total_basis_UNKNOWN').totals.rows.total_basis,null);assert.deepEqual(issues.find(i=>i.code==='ACQUISITION_UNKNOWN').lotRows,[0]);assert.equal(h.lotScope.lots.length,2);
  assert.ok(!issues.some(i=>i.code==='ROWS_POSITION_total_basis'));
});
test('retained evidence links to its original account source rather than the latest import',()=>{
  const state=fixture();state.holdings.a.EXAMPLE.lotCoverage='retained';state.holdings.a.EXAMPLE.active=false;
  state.accounts.push({id:'b',label:'Account B'});state.holdings.b={EXAMPLE:structuredClone(state.holdings.a.EXAMPLE)};
  state.imports.push({id:'recent-b',accountId:'b',acceptedAt:'2026-09-10',sources:[{id:'lots',name:'other-account-lots.json',path:'b/private',backupSourceId:'lots'}],decisions:{reason:'Separate account'}});
  const issues=reconciliationIssues(state),a=issues.find(i=>i.accountId==='a'),b=issues.find(i=>i.accountId==='b');
  assert.notEqual(a.id,b.id);assert.equal(a.active,false);assert.equal(a.evidence.find(e=>e.role==='Accepted lots').source.path,'a/old');assert.equal(b.evidence.find(e=>e.role==='Accepted lots').source.path,'b/private');
  assert.equal(a.review.reason,'Current');
});
test('review notes cannot resolve source conflicts and only effective currency gaps are flagged',()=>{
  const state=fixture(),h=state.holdings.a.EXAMPLE;h.warnings=[{code:'SOURCE_CONFLICT_REVIEWED',message:'Accepted as unresolved.'},{code:'SOURCE_CONFLICT_REVIEWED',message:'Same flag.'}];h.unresolved=true;h.position.currency=null;h.lotScope.lots.forEach(l=>l.currency=null);
  let issues=reconciliationIssues(state);assert.equal(issues.filter(i=>i.code==='SOURCE_CONFLICT').length,1);assert.ok(!issues.some(i=>i.code==='CURRENCY_UNKNOWN'));
  h.confirmedCurrency=null;assert.ok(reconciliationIssues(state).some(i=>i.code==='CURRENCY_UNKNOWN'));
  h.confirmedCurrency='USD';h.lotScope.lots[0].currency='EUR';h.lotScope.lots[1].currency='USD';issues=reconciliationIssues(state);
  assert.ok(issues.some(i=>i.code==='CURRENCY_CONFLICT'));assert.equal(issues[0].totals.rows.total_basis,null);assert.ok(!issues.some(i=>i.code==='ROWS_POSITION_total_basis'));
});

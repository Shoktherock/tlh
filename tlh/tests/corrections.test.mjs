import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sampleFiles,sampleSnapshot} from '../src/sample.mjs';
import {readSource} from '../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../src/import/engine.mjs';
import {previewCorrection,acceptCorrection,correctionView,latestCorrections} from '../src/import/corrections.mjs';
import {reconciliationIssues} from '../src/import/reconciliation.mjs';
import {exportBackup,validateBackup,restorePlan} from '../src/import/recovery.mjs';

const options={accountId:null,accountLabel:'Synthetic correction account',accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false};
const decide=plan=>({symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Reviewed synthetic evidence.'});
async function fixture(){const s=emptyState(),plan=await previewImport(s,await Promise.all(sampleFiles().map(readSource)),options);return acceptPreview(s,plan,decide(plan)).state;}
function request(state,target={section:'lots',field:'effective_date'},value='2026-09-08',extra={}){return {baseRevision:state.revision,accountId:state.accounts[0].id,symbol:'EXAMPLE',target,value,kind:'set',reason:'Verified synthetic broker evidence.',...extra};}
function correct(state,target,value,extra){return acceptCorrection(state,previewCorrection(state,request(state,target,value,extra),'synthetic-actor'),{reviewed:true}).state;}
async function replace(state,edit){const snapshot=structuredClone(sampleSnapshot);edit(snapshot);const plan=await previewImport(state,[await readSource({name:'changed.json',text:JSON.stringify(snapshot)})],{...options,accountId:state.accounts[0].id});return {plan,state:acceptPreview(state,plan,decide(plan)).state};}

test('corrections resolve only their field and preserve raw holdings, lots, sources and actor audit',async()=>{
  const raw=await fixture(),before=structuredClone(raw),state=correct(raw),id=state.accounts[0].id;
  assert.deepEqual(raw,before);assert.deepEqual(state.holdings,raw.holdings);assert.deepEqual(state.imports,raw.imports);
  assert.equal(state.corrections[0].actor,'synthetic-actor');assert.equal(state.revision,raw.revision+1);
  assert.equal(correctionView(state).holdings[id].EXAMPLE.lotScope.effective_date,'2026-09-08');
  assert(!reconciliationIssues(state).some(i=>i.symbol==='EXAMPLE'&&i.code==='LOT_TIME_UNKNOWN'));
  assert(reconciliationIssues(state).some(i=>i.symbol==='FUND'&&i.code==='LOT_TIME_UNKNOWN'));
  const numeric=correct(state,{section:'lot',field:'total_basis',row:0},'101.00000001');
  const view=correctionView(numeric);assert.equal(view.holdings[id].EXAMPLE.lotScope.lots[0].total_basis,'101.00000001');assert.equal(view.holdings[id].EXAMPLE.lotScope.lots[1].total_basis,'100.00');
  assert(reconciliationIssues(numeric).some(i=>i.symbol==='EXAMPLE'&&i.category==='Totals'));
  assert.equal(reconciliationIssues(numeric).find(i=>i.symbol==='EXAMPLE').evidence.find(e=>e.role==='Accepted lots').effectiveAt,null);
});

test('server rules reject missing reason, invalid dates/decimals, unknown quantities, stale or unreviewed requests',async()=>{
  const state=await fixture();
  for(const req of [request(state,undefined,'2026-02-30'),request(state,undefined,'09/08/2026'),request(state,{section:'lot',field:'quantity',row:0},'0'),request(state,{section:'position',field:'quantity'},null),request(state,{section:'position',field:'total_basis'},'-1'),request(state,{section:'lot',field:'total_basis',row:99},'5'),request(state,undefined,undefined,{reason:' '})])assert.throws(()=>previewCorrection(state,req,'actor'));
  assert.throws(()=>previewCorrection(state,{...request(state),baseRevision:0},'actor'),/stale/);
  const plan=previewCorrection(state,request(state),'actor');assert.throws(()=>acceptCorrection(state,plan,{reviewed:false}),/Review/);
  assert.throws(()=>acceptCorrection({...state,revision:99},plan,{reviewed:true}),/stale/);
  const unknown=correct(state,{section:'lot',field:'total_basis',row:0},null);
  assert.equal(correctionView(unknown).holdings[state.accounts[0].id].EXAMPLE.lotScope.lots[0].total_basis,null);
});

test('identical imports retain corrections; zero is an explicit reviewed quantity and withdrawal restores the raw active view',async()=>{
  let state=correct(await fixture(),{section:'position',field:'quantity'},'0');const id=state.accounts[0].id;
  assert.equal(correctionView(state).holdings[id].EXAMPLE.active,false);assert.equal(state.holdings[id].EXAMPLE.active,true);
  const plan=await previewImport(state,await Promise.all(sampleFiles().map(readSource)),{...options,accountId:id});
  const repeated=acceptPreview(state,plan,decide(plan));assert.equal(repeated.duplicate,true);assert.equal(correctionView(repeated.state).correctionStates[0].status,'active');
  const event=state.corrections[0];state=correct(state,event.target,null,{kind:'revoke',previousId:event.id});assert.equal(correctionView(state).holdings[id].EXAMPLE.active,true);
});

test('later changed evidence suspends corrections, warns before import and supports reviewed reapply or withdrawal',async()=>{
  let state=correct(await fixture());const raw=structuredClone(state.holdings);
  const result=await replace(state,s=>{s.snapshot_id='later';s.accounts[0].lot_scopes[0].lots[0].acquisition_date='2024-01-10';});
  assert(result.plan.correctionConflicts.some(c=>c.symbol==='EXAMPLE'));assert(result.plan.rows.find(r=>r.symbol==='EXAMPLE').requiresReason);
  state=result.state;assert.equal(correctionView(state).correctionStates[0].status,'conflict');
  assert(reconciliationIssues(state).some(i=>i.title==='Manual correction needs review'));
  assert.equal(correctionView(state).holdings[state.accounts[0].id].EXAMPLE.lotScope.effective_date,null);
  state=correct(state,undefined,'2026-09-08',{previousId:state.corrections[0].id});assert.equal(correctionView(state).correctionStates[0].status,'active');
  const prior=latestCorrections(state)[0];state=correct(state,prior.target,null,{kind:'revoke',previousId:prior.id});
  assert.equal(correctionView(state).correctionStates.length,0);assert.equal(state.corrections.length,3);assert.equal(raw[state.accounts[0].id].EXAMPLE.lotScope.lots[0].total_basis,'100.00');
});

test('retained lots keep corrections, changed duplicate rows require withdrawal even when the old row vanished',async()=>{
  let state=correct(await fixture(),{section:'lot',field:'total_basis',row:1},'99');
  state=(await replace(state,s=>{s.accounts[0].lot_scopes[0].status='failed';s.accounts[0].lot_scopes[0].lots=[];})).state;
  assert.equal(correctionView(state).correctionStates[0].status,'active');
  state=(await replace(state,s=>{s.snapshot_id='one-row';s.accounts[0].lot_scopes[0].lots.pop();s.accounts[0].lot_scopes[0].completeness_evidence.displayed_row_count=1;s.accounts[0].lot_scopes[0].reported_totals={quantity:'1',total_basis:'100'};s.accounts[0].positions[0].quantity='1';s.accounts[0].positions[0].total_basis='100';})).state;
  const prior=latestCorrections(state)[0];assert.equal(correctionView(state).correctionStates[0].status,'conflict');
  assert.throws(()=>previewCorrection(state,request(state,prior.target,'99',{previousId:prior.id}),'actor'));
  state=correct(state,prior.target,null,{kind:'revoke',previousId:prior.id});assert.equal(latestCorrections(state).length,0);
  assert.equal((await validateBackup(JSON.parse(await exportBackup(state)))).state.corrections.length,2);
});

test('backup interleaves imports/corrections, rejects altered anchors, and preserves conflicts and withdrawal on restore/re-export',async()=>{
  let state=correct(await fixture());state=correct(state,{section:'position',field:'total_basis'},'199.75');
  state=(await replace(state,s=>{s.snapshot_id='changed';s.accounts[0].lot_scopes[0].lots[0].acquisition_date='2024-01-10';})).state;
  const p=latestCorrections(state).find(c=>c.target.section==='position');state=correct(state,p.target,null,{kind:'revoke',previousId:p.id});
  const verified=await validateBackup(JSON.parse(await exportBackup(state)));
  assert.equal(verified.state.corrections.length,3);assert.equal(correctionView(verified.state).correctionStates[0].status,'conflict');
  const corrupt=JSON.parse(await exportBackup(state));corrupt.state.corrections[0].basis.effective_date='2020-01-01';await assert.rejects(validateBackup(corrupt),/historical/);
  const current={...emptyState(),accounts:[{id:'destination',label:'Restore',type:'taxable',broker:'schwab'}]};
  const plan=await restorePlan(verified,current,{[state.accounts[0].id]:'destination'},{id:'object',path:'private/backup'});
  const restored={...current,revision:plan.imports.length+plan.corrections.length,holdings:plan.holdings,cash:plan.cash,imports:plan.imports,corrections:plan.corrections};
  assert.equal(plan.corrections[2].previousId,plan.corrections[1].id);
  const again=await validateBackup(JSON.parse(await exportBackup(restored,async source=>verified.files.find(f=>f.id===source.id).text)));
  assert.equal(again.state.corrections.length,3);assert.equal(correctionView(again.state).correctionStates[0].status,'conflict');
});

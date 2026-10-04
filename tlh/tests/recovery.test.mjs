import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sampleFiles,sampleSnapshot} from '../src/sample.mjs';
import {readSource} from '../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../src/import/engine.mjs';
import {validateBackup,exportBackup,restorePlan} from '../src/import/recovery.mjs';

async function fixture(){
  const sources=await Promise.all(sampleFiles().map(readSource));
  const options={accountId:null,accountLabel:'Local trust',accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false};
  const plan=await previewImport(emptyState(),sources,options);
  const decisions={symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Reviewed local evidence.'};
  const first=acceptPreview(emptyState(),plan,decisions);const accountId=first.state.accounts[0].id;
  const partial=structuredClone(sampleSnapshot);partial.accounts[0].lot_scopes.forEach(s=>{s.status='failed';s.lots=[];s.issues.push({code:'INCOMPLETE',severity:'error',message:'Unavailable',source_ref:'lots'});});
  const next=await previewImport(first.state,[await readSource({name:'partial.json',text:JSON.stringify(partial)})],{...options,accountId});
  return acceptPreview(first.state,next,{...decisions,symbols:['EXAMPLE'],includeCash:false}).state;
}
test('backup replays partial decisions, retained lots, cash and history without mutating the pilot',async()=>{
  const state=await fixture();const before=JSON.stringify(state);
  const text=await exportBackup(state);const verified=await validateBackup(JSON.parse(text));
  assert.equal(JSON.stringify(state),before);assert.deepEqual(verified.state.holdings,state.holdings);assert.deepEqual(verified.state.cash,state.cash);
  assert.equal(verified.summary[0].imports,2);assert.equal(verified.summary[0].holdings,3);assert.equal(verified.summary[0].lots,4);
  assert.equal((await validateBackup(state)).fingerprint,verified.fingerprint);
  const again=JSON.parse(text);again.exportedAt='2027-01-01';assert.equal((await validateBackup(again)).fingerprint,verified.fingerprint);
});
test('corrupt evidence, forged holdings, duplicate history and missing review decisions reject',async()=>{
  const state=await fixture();
  const tamper=async edit=>{const b=structuredClone(state);edit(b);await assert.rejects(validateBackup(b));};
  await tamper(b=>b.imports[0].sources[0].text+=' ');
  await tamper(b=>b.holdings[b.accounts[0].id].EXAMPLE.position.quantity='999');
  await tamper(b=>b.imports.push(b.imports[0]));
  await tamper(b=>b.imports[0].decisions.mappingReviewed=false);
  await tamper(b=>delete b.imports[0].sources[0].text);
  await tamper(b=>b.accounts[0].id='__proto__');
});
test('restore remaps accounts and all history references; a hydrated restored backup replays again',async()=>{
  const verified=await validateBackup(await fixture());const current=emptyState();current.accounts=[{id:'target',label:'Restored trust',type:'taxable',broker:'schwab'}];
  const plan=await restorePlan(verified,current,{[verified.summary[0].id]:'target'},{id:'backup-object',path:'private/backup'});
  assert.equal(plan.imports.length,2);assert.equal(plan.imports[1].priorHoldings.EXAMPLE.lastImportId,plan.imports[0].id);
  assert.equal(plan.holdings.target.EXAMPLE.lastImportId,plan.imports[1].id);assert.equal(plan.cash.target.lastImportId,plan.imports[0].id);
  assert.equal(plan.imports[0].decisions.reason,'Reviewed local evidence.');assert.equal(plan.imports[0].sources[0].text,undefined);
  const restored={...current,revision:2,holdings:plan.holdings,cash:plan.cash,imports:plan.imports};
  const text=await exportBackup(restored,async s=>verified.files.find(f=>f.id===s.backupSourceId).text);
  assert.equal((await validateBackup(JSON.parse(text))).summary[0].imports,2);
  await assert.rejects(restorePlan(verified,restored,{[verified.summary[0].id]:'target'},{id:'x',path:'x'}),/empty/);
  await assert.rejects(restorePlan(verified,current,{},{}),/Map every/);
  current.accounts[0].type='roth_ira';await assert.rejects(restorePlan(verified,current,{[verified.summary[0].id]:'target'},{}),/same account type/);
});

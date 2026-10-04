import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityTemplate,normalizeActivity,previewActivity,emptyActivity,activityView,activityCoverage,validateActivityState,restoreActivity} from '../src/activity/engine.mjs';
const account='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',at='2026-09-17T12:00:00Z';
const accounts=[{id:account,label:'Synthetic',type:'taxable'}];
const doc=()=>({...activityTemplate(),coverage:{start:'2026-09-01',end:'2026-09-17',status:'complete',noActivity:false}});
const source=d=>({name:'activity.json',text:JSON.stringify(d)});
const accept=(state,p)=>({version:1,events:[...state.events,{...p.batch,actor:user,at}]});
const withdraw=(s,id)=>({version:1,events:[...s.events,{kind:'withdraw',id:crypto.randomUUID(),batchId:id,reason:'Source correction',actor:user,at}]});
test('manual activity preserves actions, decimal precision, meaningful zero and unknown fields',()=>{
  const d=doc();d.rows[0].quantity='1.2500';d.rows[0].cashAmount='-125.000';const r=normalizeActivity(d);assert.equal(r.rows[0].quantity,'1.25');assert.equal(r.rows[0].cashAmount,'-125');
  d.rows[0].quantity=null;d.rows[0].date=null;d.rows[0].currency=null;assert.equal(normalizeActivity(d).rows[0].quantity,null);
  d.rows[0].action='adjustment';d.rows[0].quantity='-0.5';assert.equal(normalizeActivity(d).rows[0].quantity,'-0.5');d.rows[0].action='sell';assert.throws(()=>normalizeActivity(d),/decimal/);
});
test('UTF-8 BOM source text remains intact and hashes/replays consistently',async()=>{
  const original={name:'bom.json',text:'\uFEFF'+JSON.stringify(doc())},p=await previewActivity(emptyActivity(),account,original);assert.equal(p.batch.source.text,original.text);await validateActivityState(accept(emptyActivity(),p));
});
test('malformed rows, invalid calendar dates and partial empty files fail as a whole',()=>{
  for(const patch of [{date:'2026-02-30'},{date:'2026-10-01'},{quantity:'NaN'},{quantity:1},{action:'split'},{symbol:'abc'},{brokerId:''}]){const d=doc();d.rows.push({...d.rows[0],rowRef:'second',...patch});assert.throws(()=>normalizeActivity(d));}
  const d=doc();d.rows=[];assert.throws(()=>normalizeActivity(d),/no-activity/);d.coverage.noActivity=true;assert.equal(normalizeActivity(d).rows.length,0);d.coverage.status='partial';assert.throws(()=>normalizeActivity(d));
});
test('identical-looking rows within one source retain multiplicity; equivalent renamed/reordered sources are a no-op',async()=>{
  const d=doc();d.rows.push({...d.rows[0],rowRef:'row-2'});const p=await previewActivity(emptyActivity(),account,source(d));assert.equal(p.newRows,2);assert.notEqual(p.batch.transactions[0].id,p.batch.transactions[1].id);
  const s=accept(emptyActivity(),p);d.rows.reverse();const again=await previewActivity(s,account,{name:'renamed.json',text:JSON.stringify(d)});assert.equal(again.duplicate,p.batch.id);assert.equal(activityView(s).transactions.length,2);
});
test('broker IDs deduplicate per account and block contradictory values including within a source',async()=>{
  const d=doc();d.rows[0].brokerId='id-1';let p=await previewActivity(emptyActivity(),account,source(d));const s=accept(emptyActivity(),p);d.coverage.start='2026-08-01';p=await previewActivity(s,account,source(d));assert.equal(p.newRows,0);assert.equal(p.rows[0].status,'known-id');assert.deepEqual(p.batch.dependencies,[s.events[0].id]);
  d.rows[0].quantity='2';p=await previewActivity(s,account,source(d));assert.equal(p.rows[0].status,'conflicting-id');assert.equal(p.unresolved.length,1);
  assert.equal((await previewActivity(s,user,source(d))).newRows,1);
  d.rows.push({...d.rows[0],rowRef:'row-2',quantity:'3'});assert.equal((await previewActivity(emptyActivity(),account,source(d))).rows[1].status,'conflicting-id');
});
test('overlaps without IDs require explicit choices and cannot consume one existing record twice',async()=>{
  const d=doc(),first=await previewActivity(emptyActivity(),account,source(d)),s=accept(emptyActivity(),first);d.coverage.start='2026-08-01';d.rows.push({...d.rows[0],rowRef:'row-2'});
  const id=first.batch.transactions[0].id;let p=await previewActivity(s,account,source(d));assert.equal(p.unresolved.length,2);
  p=await previewActivity(s,account,source(d),{'row-1':id,'row-2':id});assert.equal(p.unresolved.length,1);
  p=await previewActivity(s,account,source(d),{'row-1':id,'row-2':'keep'});assert.equal(p.newRows,1);assert.equal(p.duplicateRows,1);assert.equal(activityView(accept(s,p)).transactions.length,2);
});
test('unknown fields cause possible overlap review rather than manufacturing a new acquisition',async()=>{
  const d=doc(),p=await previewActivity(emptyActivity(),account,source(d)),s=accept(emptyActivity(),p);d.rows[0].quantity=null;d.rows[0].date=null;d.rows[0].currency=null;
  const r=await previewActivity(s,account,source(d));assert.equal(r.rows[0].status,'ambiguous');assert.equal(r.warnings.length,1);
});
test('inclusive range union handles adjacent ranges and reports exact holes and unrepresented accounts',async()=>{
  let s=emptyActivity();for(const [start,end] of [['2024-02-28','2024-02-29'],['2024-03-01','2024-03-02'],['2024-03-04','2024-03-04']]){const d=doc();d.rows=[];d.coverage={start,end,status:'complete',noActivity:true};s=accept(s,await previewActivity(s,account,source(d)));}
  let r=activityCoverage(s,[...accounts,{id:user,label:'Omitted'}],'2024-02-28','2024-03-04');assert.deepEqual(r[0].gaps,[{start:'2024-03-03',end:'2024-03-03'}]);assert.equal(r[1].status,'gaps');
  r=activityCoverage(s,accounts,'2024-02-28','2024-03-02');assert.equal(r[0].status,'covered_in_supplied_records');
});
test('partial, unknown and adjustment evidence cannot silently establish complete coverage',async()=>{
  for(const change of [d=>d.coverage.status='partial',d=>d.rows[0].quantity=null,d=>d.rows[0].date=null,d=>d.rows[0].action='adjustment']){const d=doc();change(d);const p=await previewActivity(emptyActivity(),account,source(d)),s=accept(emptyActivity(),p);assert.notEqual(activityCoverage(s,accounts,'2026-09-01','2026-09-17')[0].status,'covered_in_supplied_records');}
});
test('withdrawal preserves originals and suspends dependent overlap sources and their coverage',async()=>{
  const d=doc();d.rows[0].brokerId='id-1';const p=await previewActivity(emptyActivity(),account,source(d));let s=accept(emptyActivity(),p);d.coverage.start='2026-08-01';const later=await previewActivity(s,account,source(d));s=accept(s,later);s=withdraw(s,p.batch.id);
  const v=activityView(s);assert.equal(v.batches.length,2);assert.equal(v.transactions.length,0);assert.equal(v.suspended.length,1);assert.equal(activityCoverage(s,accounts,'2026-09-01','2026-09-17')[0].status,'gaps');await validateActivityState(s);
});
test('backups replay original bytes, overlap choices and multiplicity; tampering is rejected',async()=>{
  const d=doc();const p=await previewActivity(emptyActivity(),account,source(d));let s=accept(emptyActivity(),p);d.coverage.start='2026-08-01';s=accept(s,await previewActivity(s,account,source(d),{'row-1':'keep'}));
  const reordered=JSON.parse(JSON.stringify(s),(k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v);assert.equal((await validateActivityState(reordered)).events.length,2);
  const tampered=structuredClone(s);tampered.events[0].transactions[0].quantity='99';await assert.rejects(validateActivityState(tampered),/row changed/);
  const backup={format:'tlh-activity-backup',version:1,exportedAt:at,accounts,state:s};const restored=await restoreActivity(backup,{[account]:user},[{id:user,type:'taxable'}],emptyActivity());assert.equal(activityView(restored).transactions.length,2);assert(restored.events.every(e=>e.accountId===user));
  await assert.rejects(restoreActivity(backup,{[account]:user},[{id:user,type:'traditional_ira'}],emptyActivity()),/same type/);
  await assert.rejects(restoreActivity(backup,{[account]:account},accounts,s),/no existing activity/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {manualTemplate,parseManualCsv,validateManual} from '../src/import/manual.mjs';
import {readSource,assemble} from '../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../src/import/engine.mjs';
import {previewCorrection,acceptCorrection,correctionView} from '../src/import/corrections.mjs';
import {exportBackup,validateBackup,restorePlan} from '../src/import/recovery.mjs';
import {sampleFiles} from '../src/sample.mjs';

const options={accountId:null,accountLabel:'Manual test',accountType:'taxable',currency:null,sourceAccountRef:'',completeAccount:false};
const decision=plan=>({symbols:plan.rows.map(r=>r.symbol),includeCash:false,mappingReviewed:true,timingReviewed:true,reason:'Reviewed synthetic manual source.'});
const source=data=>readSource({name:'manual.json',text:JSON.stringify(data)});
async function first(){const state=emptyState(),plan=await previewImport(state,[await readSource({name:'manual.csv',text:manualTemplate()})],options);return acceptPreview(state,plan,decision(plan)).state;}

test('manual CSV and JSON normalize equivalently while duplicate lots and unknown fields stay explicit',async()=>{
  const data=parseManualCsv(manualTemplate()),csv=await readSource({name:'template.csv',text:'\uFEFF'+manualTemplate()}),json=await source(data);
  assert.equal(csv.kind,'manual');assert.equal(data.positions[0].lots.rows.length,2);assert.deepEqual(data.positions[0].lots.rows[0],data.positions[0].lots.rows[1]);
  const s=emptyState(),a=await previewImport(s,[csv],options),b=await previewImport(s,[json],options);assert.equal(a.contentHash,b.contentHash);
  assert.equal(a.rows.find(r=>r.symbol==='POSITION_ONLY').next.position.total_basis,null);assert.equal(a.csvPresent,false);assert.equal(a.cash,null);
  const accepted=acceptPreview(s,a,decision(a));assert(accepted.state.imports[0].sources[0].text.startsWith('\uFEFF'));
  const repeat=await previewImport(accepted.state,[json],{...options,accountId:accepted.state.accounts[0].id});assert(acceptPreview(accepted.state,repeat,decision(repeat)).duplicate);
  const padded=manualTemplate().split('\r\n').map((line,i)=>line+(i<4?',,,,,,,,':'')).join('\r\n');assert.deepEqual(parseManualCsv(padded),data);
  assert.deepEqual(parseManualCsv(manualTemplate().replaceAll('EXAMPLE','example')),data);
  assert.throws(()=>parseManualCsv(padded.replace('"TLH Manual Evidence","1",','"TLH Manual Evidence","1","ignored extra",')),/template/);
});

test('manual validation rejects invalid dates, numeric types, duplicate symbols, malformed rows and undeclared lot coverage',()=>{
  const edit=fn=>{const data=parseManualCsv(manualTemplate());fn(data);assert.throws(()=>validateManual(data));};
  edit(d=>d.positions[0].quantity=2);edit(d=>d.positions[0].quantity='-1');edit(d=>d.positions[0].lots.rows[0].quantity='0');
  edit(d=>d.positions[0].lots.rows[0].acquisition_date='2026-02-30');edit(d=>d.positions[0].lots.coverage='assumed');edit(d=>d.positions[0].lots.rows=[]);
  edit(d=>d.positions.push(d.positions[0]));edit(d=>d.positions[0].symbol='__proto__');edit(d=>d.reference='');edit(d=>d.reason='');edit(d=>d.positions[0].unsupported='ignored');
  edit(d=>d.positions.push({...d.positions[0],symbol:'example'}));
  assert.throws(()=>parseManualCsv(manualTemplate().replace('"SCOPE","EXAMPLE"','"SCOPE","MISSING"')),/position/);
  assert.throws(()=>parseManualCsv(manualTemplate().replace('"Type","Symbol"','"Kind","Symbol"')),/columns/);
  assert.throws(()=>parseManualCsv(manualTemplate().replace('"LOT","EXAMPLE",""','"LOT","EXAMPLE","unexpected"')),/unexpected/);
});

test('manual partial evidence retains complete lots and scoped acceptance leaves absent holdings untouched',async()=>{
  const before=await first(),id=before.accounts[0].id,data=parseManualCsv(manualTemplate());data.positions=data.positions.slice(0,1);data.positions[0].lots.coverage='partial';data.positions[0].lots.rows.pop();
  const plan=await previewImport(before,[await source(data)],{...options,accountId:id,completeAccount:true});
  assert.equal(plan.rows.find(r=>r.symbol==='POSITION_ONLY').action,'retain');
  const next=acceptPreview(before,plan,{...decision(plan),symbols:['EXAMPLE']}).state;
  assert.deepEqual(next.holdings[id].EXAMPLE.lotScope,before.holdings[id].EXAMPLE.lotScope);assert.equal(next.holdings[id].EXAMPLE.supplementalScope.lots.length,1);
  assert.equal(next.holdings[id].EXAMPLE.lotCoverage,'retained');assert.deepEqual(next.holdings[id].POSITION_ONLY,before.holdings[id].POSITION_ONLY);
});

test('manual discrepancy needs a reason, older evidence archives, and separate brokerage/manual sources are never silently combined',async()=>{
  const before=await first(),id=before.accounts[0].id,data=parseManualCsv(manualTemplate());data.positions[0].lots.rows[0].total_basis='101.123456789';
  let plan=await previewImport(before,[await source(data)],{...options,accountId:id});assert(plan.rows.find(r=>r.symbol==='EXAMPLE').requiresReason);
  assert.throws(()=>acceptPreview(before,plan,{...decision(plan),reason:''}),/reason/);
  data.positions[0].lots.effective_date='2026-09-07';plan=await previewImport(before,[await source(data)],{...options,accountId:id});assert.equal(plan.rows.find(r=>r.symbol==='EXAMPLE').lotAction,'archive');
  const original=await readSource(sampleFiles()[0]),manual=await source(data);assert.throws(()=>assemble([manual,original],''),/separately/);
});

test('manual source, acceptance actor, and later correction survive backup restore and re-export',async()=>{
  let state=await first();state.imports[0].acceptedBy='recorded-test-actor';const id=state.accounts[0].id;
  state=acceptCorrection(state,previewCorrection(state,{baseRevision:state.revision,accountId:id,symbol:'EXAMPLE',target:{section:'lot',field:'total_basis',row:1},kind:'set',value:'99',reason:'Synthetic verified basis.'},'correction-actor'),{reviewed:true}).state;
  const verified=await validateBackup(JSON.parse(await exportBackup(state)));assert.equal(verified.state.imports[0].acceptedBy,'recorded-test-actor');
  const current={...emptyState(),accounts:[{id:'restore',label:'Restore',type:'taxable',broker:'schwab'}]};const plan=await restorePlan(verified,current,{[id]:'restore'},{id:'object',path:'private'});
  const restored={...current,revision:2,imports:plan.imports,corrections:plan.corrections,holdings:plan.holdings,cash:plan.cash};
  const again=await validateBackup(JSON.parse(await exportBackup(restored,async s=>verified.files.find(f=>f.id===s.id).text)));
  assert.equal(again.state.imports[0].acceptedBy,'recorded-test-actor');assert.equal(correctionView(again.state).holdings.restore.EXAMPLE.lotScope.lots[1].total_basis,'99');
});

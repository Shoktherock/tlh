import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectSchwabActivity} from '../src/activity/schwab.mjs';
import {parseActivitySource,previewActivity,emptyActivity,activityView,validateActivityState,restoreActivity,activityCoverage} from '../src/activity/engine.mjs';
import {csv,source} from './fixtures/schwab-activity.mjs';
const account=crypto.randomUUID(),user=crypto.randomUUID(),at='2026-09-17T12:00:00Z';
const accept=(state,p)=>({version:1,events:[...state.events,{...p.batch,actor:user,at}]});
const withdraw=(s,id)=>({version:1,events:[...s.events,{kind:'withdraw',id:crypto.randomUUID(),batchId:id,reason:'Correct source',actor:user,at}]});
test('Schwab CSV retains multiplicity, original precision, signed cash, notes and unknown IDs',async()=>{
  const p=await previewActivity(emptyActivity(),account,source()),rows=p.document.rows;
  assert.equal(p.newRows,3);assert.equal(rows[0].quantity,'1234');assert.equal(rows[0].cashAmount,'15233.72');assert.equal(rows[1].quantity,'10.25');assert.equal(rows[1].cashAmount,'-206.26');assert.equal(rows[1].brokerId,null);assert.equal(rows[1].exchange,null);assert.match(rows[0].note,/CLASS A; Price: \$12.345; Fees & Comm: \$0.01/);assert.equal(p.document.format,'tlh-schwab-activity');assert.equal(p.batch.source.text,csv);
  assert.equal(activityCoverage(accept(emptyActivity(),p),[{id:account}],'2026-09-15','2026-09-16')[0].status,'gaps');
});
test('CSV requires explicit currency, trade-date and source-range review',()=>{
  for(const change of [s=>delete s.review,s=>s.review.currency='',s=>s.review.tradeDatesConfirmed=false,s=>s.review.coverage.end='2026-09-15',s=>s.review.coverage.status='invented',s=>s.review.sourceAccount='']){const s=source();change(s);assert.throws(()=>parseActivitySource(s));}
  assert.deepEqual([inspectSchwabActivity(csv).start,inspectSchwabActivity(csv).end],['2026-09-15','2026-09-16']);
});
test('bad headers, extra columns, malformed dates/quotes/numbers and contradictory signs reject the whole CSV',()=>{
  for(const broken of [csv.replace('Fees & Comm','Fees'),csv.replace('09/16/2026','02/30/2026'),csv.replace('09/16/2026','09/16/2026 as of 09/15/2026'),csv.replace('1,234','12,34'),csv.replace('20.1234','2e4'),csv.replace('-$206.26','$206.26'),csv.replace('$15233.72','-$15233.72'),csv.replace('"Sell"','"Sell","extra"'),csv+'"broken'])assert.throws(()=>parseActivitySource({...source(),text:broken}));
});
test('unsupported actions and unknowns remain evidence with uncertainty, never inferred acquisitions',async()=>{
  const s=source();s.text=csv.replace('"Sell"','"Stock Split"').replace('"1,234"','""');s.review.coverage.status='complete';const p=await previewActivity(emptyActivity(),account,s);
  assert.equal(p.document.rows[0].action,'other');assert.equal(p.document.rows[0].quantity,null);assert.match(p.document.rows[0].note,/Stock Split/);assert.equal(p.warnings.length,1);assert.equal(activityCoverage(accept(emptyActivity(),p),[{id:account}],'2026-09-15','2026-09-16')[0].status,'uncertain_records');
});
test('CSV renamed reimport is no-op; overlapping exports require decisions and preserve multiplicity',async()=>{
  const p=await previewActivity(emptyActivity(),account,source()),s=accept(emptyActivity(),p);
  assert.equal((await previewActivity(s,account,{...source(),name:'renamed.csv'})).duplicate,p.batch.id);
  const changedEvidence=await previewActivity(s,account,{...source(),text:csv.replace('$0.01','$0.02')});assert.equal(changedEvidence.duplicate,undefined);assert.equal(changedEvidence.unresolved.length,3);
  const later=source();later.review.coverage.start='2026-09-01';const unresolved=await previewActivity(s,account,later);assert.equal(unresolved.unresolved.length,3);
  const choices=Object.fromEntries(p.batch.transactions.map(t=>[t.rowRef,t.id]));const next=await previewActivity(s,account,later,choices);assert.equal(next.newRows,0);assert.equal(next.duplicateRows,3);await validateActivityState(accept(s,next));
});
test('CSV backup replays original text and declarations; suspended sources can be withdrawn and restored',async()=>{
  const p=await previewActivity(emptyActivity(),account,source());let s=accept(emptyActivity(),p);const later=source();later.review.coverage.start='2026-09-01';const choices=Object.fromEntries(p.batch.transactions.map(t=>[t.rowRef,t.id])),next=await previewActivity(s,account,later,choices);s=accept(s,next);s=withdraw(s,p.batch.id);s=withdraw(s,next.batch.id);
  await validateActivityState(s);const target=crypto.randomUUID();const backup={format:'tlh-activity-backup',version:1,exportedAt:at,accounts:[{id:account,type:'taxable'}],state:s};const restored=await restoreActivity(backup,{[account]:target},[{id:target,type:'taxable'}],emptyActivity());assert.equal(restored.events[0].source.text,csv);assert.equal(activityView(restored).transactions.length,0);
  const tampered=structuredClone(s);tampered.events[0].source.review.currency='EUR';await assert.rejects(validateActivityState(tampered),/USD/);
  const changed=structuredClone(s);changed.events[0].source.text=csv.replace('$15233.72','$15233.73');await assert.rejects(validateActivityState(changed),/does not match/);
});

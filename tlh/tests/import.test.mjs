import {syntheticLotsCsv} from '../../browser-helper/tests/fixtures/schwab-lots.synthetic.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readSource, parsePositions, decodeSourceBytes } from '../src/import/sources.mjs';
import { previewImport, acceptPreview, emptyState } from '../src/import/engine.mjs';
import { sampleFiles, sampleSnapshot, samplePositions } from '../src/sample.mjs';

const mapping = { accountId: null, accountLabel: 'Synthetic account', accountType: 'taxable', currency: 'USD', sourceAccountRef: 'synthetic-account', completeAccount: false };
test('source decoding preserves valid UTF-8 bytes including BOM and rejects lossy decoding',async()=>{
  const original='\uFEFF'+samplePositions;const bytes=new TextEncoder().encode(original);
  const decoded=decodeSourceBytes(bytes);assert.equal(decoded,original);assert.deepEqual(new TextEncoder().encode(decoded),bytes);
  assert.equal((await readSource({name:'bom.csv',text:decoded})).data.positions.length,3);
  assert.throws(()=>decodeSourceBytes(new Uint8Array([0xff,0xfe,0x41])),/encoded data|encoding/i);
});
const decision = plan => ({ symbols: plan.rows.map(r => r.symbol), includeCash: true, mappingReviewed: true, timingReviewed: true, reason: '' });
const sources = async (files = sampleFiles()) => Promise.all(files.map(readSource));
async function initial() {
  const files = await sources(); const preview = await previewImport(emptyState(), files, mapping);
  const result = acceptPreview(emptyState(), preview, decision(preview));
  return { files, preview, state: result.state, accountId: result.state.accounts[0].id };
}
function modifiedSnapshot(update) {
  const s = structuredClone(sampleSnapshot); update(s.accounts[0], s);
  return { name: 'updated.json', text: JSON.stringify(s) };
}

test('positions CSV preserves contingent rights, cash, quoted commas, fractional quantities, exact zeroes and dates', () => {
  const p = parsePositions(samplePositions);
  assert.equal(p.positions.length, 3); assert.equal(p.positions[2].total_basis, '0.00');
  assert.equal(p.positions[1].quantity, '0.5'); assert.equal(p.cash.amount, '12.34');
  assert.equal(p.date, '2026-09-08'); assert.deepEqual(p.issues, []);
  const quoted = parsePositions(samplePositions.replace('Example security', 'Example, ""quoted"" security'));
  assert.equal(quoted.positions[0].description, 'Example, "quoted" security');
});
test('malformed, truncated, duplicate and invalid-date inputs reject rather than dropping source rows', async () => {
  assert.throws(() => parsePositions(samplePositions.replace('2026/09/08', '2026/02/30')), /calendar/);
  assert.throws(() => parsePositions(samplePositions.replace('"Positions Total"', '"NOT A TOTAL"')));
  assert.throws(() => parsePositions(samplePositions.replace('"0.5"', '"-1"')));
  assert.throws(() => parsePositions(samplePositions.replace('"FUND",', '"EXAMPLE",')), /Duplicate/);
  await assert.rejects(readSource({ name:'wrong.json', text:JSON.stringify({...sampleSnapshot,schema_version:'2.0'}) }), /validation/);
});
test('stage and preview are read-only; acceptance counts lots and positions once and preserves source bytes', async () => {
  const files = await sources(); const state = emptyState(); const before = JSON.stringify(state);
  const plan = await previewImport(state, files, mapping);
  assert.equal(JSON.stringify(state), before); assert.equal(plan.rows.length, 3);
  const result = acceptPreview(state, plan, decision(plan));
  assert.equal(JSON.stringify(state), before);
  const holdings = result.state.holdings[result.state.accounts[0].id];
  assert.equal(holdings.EXAMPLE.position.quantity, '2');
  assert.equal(holdings.EXAMPLE.lotScope.lots.length, 2);
  assert.equal(holdings['000CVR000'].lotScope, null);
  assert.equal(result.state.cash[result.state.accounts[0].id].amount, '12.34');
  assert.equal(result.state.imports[0].sources[0].text, files[0].text);
  assert.equal(result.state.imports[0].sources[0].data.accounts[0].lot_scopes[0].lots[0].currency, null);
  assert.equal(holdings.EXAMPLE.confirmedCurrency, 'USD');
  assert.equal('transactions' in result.state, false);
});
test('renamed, reordered and reformatted equivalent observations are idempotent in the mapped account', async () => {
  const { state, accountId } = await initial();
  const json = modifiedSnapshot((a,s) => { s.snapshot_id='new-capture-id'; a.account_ref='new-source-ref'; a.lot_scopes.reverse(); a.lot_scopes.forEach(scope => { scope.lots.reverse(); scope.lots.forEach((l,i) => {l.row_ref=`new-${i}`;l.quantity+='0';}); }); });
  // Decimal normalization is explicit; use equivalent values without changing integer scale.
  const data = JSON.parse(json.text); data.accounts[0].lot_scopes.forEach(s=>s.lots.forEach(l=>{if(l.quantity==='10')l.quantity='1.0';})); json.text=JSON.stringify(data);
  const files = await sources([{name:'renamed.json',text:json.text},{name:'renamed.csv',text:samplePositions}]);
  const plan = await previewImport(state, files, {...mapping,accountId,sourceAccountRef:'new-source-ref'});
  const result=acceptPreview(state,plan,decision(plan));
  assert.equal(result.duplicate,true); assert.equal(result.state.revision,state.revision); assert.equal(result.state.imports.length,1);
});
test('identical content mapped to a different account stays separate despite matching source suffix', async () => {
  const {state,files}=await initial();
  const plan=await previewImport(state,files,{...mapping,accountLabel:'Separate account'});
  const result=acceptPreview(state,plan,decision(plan));
  assert.equal(result.duplicate,false);assert.equal(result.state.accounts.length,2);assert.equal(Object.keys(result.state.holdings).length,2);
});
test('failed, partial and absent scopes preserve prior lots and leave visible freshness warnings', async () => {
  const {state,accountId}=await initial();
  for (const status of ['failed','partial','skipped']) {
    const file=modifiedSnapshot(a=>{
      a.positions=a.positions.slice(0,1);a.lot_scopes=a.lot_scopes.slice(0,1);
      const s=a.lot_scopes[0];s.status=status;if(status!=='partial')s.lots=[];
      s.issues.push({code:'INCOMPLETE',severity:'error',message:'Incomplete capture',source_ref:'lots'});
    });
    const plan=await previewImport(state,await sources([file]),{...mapping,accountId});
    const result=acceptPreview(state,plan,decision(plan));const holdings=result.state.holdings[accountId];
    assert.equal(holdings.EXAMPLE.lotScope.lots.length,2);assert.equal(holdings.EXAMPLE.lotCoverage,'retained');
    assert.equal(holdings.FUND.active,true);assert.equal(holdings.FUND.lotScope.lots.length,2);
  }
});
test('changed unknown-date lots require a review reason and retain historical evidence after replacement', async () => {
  const {state,accountId}=await initial();
  const file=modifiedSnapshot(a=>{a.positions[0].quantity='3';a.positions[0].total_basis='300.00';const s=a.lot_scopes[0];s.reported_totals.quantity='3';s.reported_totals.total_basis='300.00';s.lots[0].quantity='2';s.lots[0].total_basis='200.00';});
  const plan=await previewImport(state,await sources([file]),{...mapping,accountId});
  assert.throws(()=>acceptPreview(state,plan,decision(plan)),/reason/);
  const result=acceptPreview(state,plan,{...decision(plan),reason:'Reviewed new source against brokerage; effective date remains unknown.'});
  assert.equal(result.state.holdings[accountId].EXAMPLE.lotScope.lots[0].quantity,'2');
  assert.equal(result.state.imports.at(-1).priorHoldings.EXAMPLE.lotScope.lots[0].quantity,'1');
});
test('lot and position discrepancies stay unresolved and never become invented residual lots',async()=>{
  const file=modifiedSnapshot(a=>{a.positions[0].quantity='3';a.lot_scopes[0].issues.push({code:'POSITION_QUANTITY_MISMATCH',severity:'warning',message:'Quantity differs',source_ref:'lots'});});
  const plan=await previewImport(emptyState(),await sources([file]),mapping);
  assert.equal(plan.rows[0].requiresReason,true);
  const result=acceptPreview(emptyState(),plan,{...decision(plan),reason:'Keep discrepancy unresolved.'});
  const h=Object.values(result.state.holdings)[0].EXAMPLE;
  assert.equal(h.position.quantity,'3');assert.equal(h.lotScope.lots.length,2);assert.equal(h.unresolved,true);
});
test('older known lots cannot replace newer current lots even with a review reason',async()=>{
  const newer=modifiedSnapshot(a=>a.lot_scopes.forEach(s=>{s.effective_date='2026-09-08';}));
  const first=await previewImport(emptyState(),await sources([newer]),mapping);
  const state=acceptPreview(emptyState(),first,decision(first)).state;const accountId=state.accounts[0].id;
  const older=modifiedSnapshot(a=>{const s=a.lot_scopes[0];s.effective_date='2026-09-01';s.lots[0].acquisition_date='2024-01-10';});
  const plan=await previewImport(state,await sources([older]),{...mapping,accountId});
  assert.equal(plan.rows.find(r=>r.symbol==='EXAMPLE').lotAction,'archive');
  const result=acceptPreview(state,plan,{...decision(plan),reason:'Archive old source.'});
  assert.equal(result.state.holdings[accountId].EXAMPLE.lotScope.lots[0].acquisition_date,'2025-01-10');
});
test('only an explicitly complete newer account CSV can close a missing position',async()=>{
  const {state,accountId}=await initial();
  const csv=samplePositions.split('\n').filter(l=>!l.startsWith('"EXAMPLE",')).join('\n').replace('2026/09/08','2026/09/09').replace('"$250.00"','"$50.00"');
  const files=await sources([{name:'positions.csv',text:csv}]);
  const partial=await previewImport(state,files,{...mapping,accountId});
  assert.equal(partial.rows.find(r=>r.symbol==='EXAMPLE').action,'retain');
  const complete=await previewImport(state,files,{...mapping,accountId,completeAccount:true});
  assert.equal(complete.rows.find(r=>r.symbol==='EXAMPLE').action,'close');
  const result=acceptPreview(state,complete,decision(complete));
  assert.equal(result.state.holdings[accountId].EXAMPLE.active,false);
  assert.equal(result.state.holdings[accountId].EXAMPLE.lotScope.lots.length,2);
  assert.equal('transactions' in result.state,false);
});
test('stale previews and missing decisions fail without changing accepted state',async()=>{
  const {state,preview}=await initial();const before=JSON.stringify(state);
  assert.throws(()=>acceptPreview(state,preview,decision(preview)),/stale/);
  assert.equal(JSON.stringify(state),before);
  assert.throws(()=>acceptPreview(emptyState(),preview,{...decision(preview),mappingReviewed:false}),/mapping/);
});
test('manual Positions-only files work without a helper and cash never creates lots',async()=>{
  const plan=await previewImport(emptyState(),await sources([{name:'positions.csv',text:samplePositions}]),{...mapping,sourceAccountRef:''});
  assert.equal(plan.rows.length,3);assert.ok(plan.rows.every(r=>r.next.lotScope===null));assert.equal(plan.cash.candidate.amount,'12.34');
});

test('closed holdings can reopen from newer positive evidence without creating a purchase',async()=>{
  const {state,accountId}=await initial();
  const absent=samplePositions.split('\n').filter(l=>!l.startsWith('"EXAMPLE",')).join('\n').replace('2026/09/08','2026/09/09').replace('"$250.00"','"$50.00"');
  const closure=await previewImport(state,await sources([{name:'absent.csv',text:absent}]),{...mapping,accountId,completeAccount:true});
  const closed=acceptPreview(state,closure,decision(closure)).state;
  const returning=await previewImport(closed,await sources([{name:'returning.csv',text:samplePositions.replace('2026/09/08','2026/09/10')}]),{...mapping,accountId});
  assert.equal(returning.rows.find(r=>r.symbol==='EXAMPLE').next.active,true);
  assert.equal('transactions' in acceptPreview(closed,returning,decision(returning)).state,false);
});

test('a later complete CSV with identical normalized values can close a previously retained missing holding',async()=>{
  const {state,accountId}=await initial();
  const absent=samplePositions.split('\n').filter(l=>!l.startsWith('"EXAMPLE",')).join('\n').replace('"$250.00"','"$50.00"');
  const first=await previewImport(state,await sources([{name:'same-day.csv',text:absent}]),{...mapping,accountId,completeAccount:true});
  const retained=acceptPreview(state,first,decision(first)).state;
  assert.equal(retained.holdings[accountId].EXAMPLE.active,true);
  const later=await previewImport(retained,await sources([{name:'new-day.csv',text:absent.replace('2026/09/08','2026/09/09')}]),{...mapping,accountId,completeAccount:true});
  const result=acceptPreview(retained,later,decision(later));
  assert.equal(result.duplicate,false);assert.equal(result.state.holdings[accountId].EXAMPLE.active,false);
});

test('partial acceptance of the same files can later add the remaining scopes without duplicating lots',async()=>{
  const files=await sources();const first=await previewImport(emptyState(),files,mapping);
  const state=acceptPreview(emptyState(),first,{...decision(first),symbols:['EXAMPLE'],includeCash:false}).state;
  const accountId=state.accounts[0].id;const later=await previewImport(state,files,{...mapping,accountId});
  const result=acceptPreview(state,later,decision(later));
  assert.equal(result.state.holdings[accountId].EXAMPLE.lotScope.lots.length,2);
  assert.equal(Object.keys(result.state.holdings[accountId]).length,3);
});

test('known currency conflicts cannot be overwritten by confirmation',async()=>{
  const file=modifiedSnapshot(a=>{a.positions[0].currency='EUR';});
  await assert.rejects(previewImport(emptyState(),await sources([file]),mapping),/currency conflicts/);
});

test('standalone observed-format Lot Details CSV retains duplicate lots and its source date',async()=>{
  const text=syntheticLotsCsv;
  const files=await sources([{name:'lot-details.csv',text}]);
  const plan=await previewImport(emptyState(),files,mapping);
  assert.equal(plan.rows.length,1);assert.equal(plan.rows[0].symbol,'DEMO');
  assert.equal(plan.rows[0].next.position.quantity,'3.500');
  assert.equal(plan.rows[0].next.lotScope.lots.length,3);
  assert.equal(plan.rows[0].next.lotScope.effective_date,'2026-09-06');
  assert.equal(plan.rows[0].next.lotScope.lots[0].quantity,plan.rows[0].next.lotScope.lots[1].quantity);
});

test('a conflicting security does not prevent accepting unrelated selected securities',async()=>{
  const csv=samplePositions.replace('"EXAMPLE","Example security","2"','"EXAMPLE","Example security","3"');
  const files=await sources([{name:'helper.json',text:JSON.stringify(sampleSnapshot)},{name:'positions.csv',text:csv}]);
  const plan=await previewImport(emptyState(),files,mapping);
  const result=acceptPreview(emptyState(),plan,{...decision(plan),symbols:['FUND']});
  const h=Object.values(result.state.holdings)[0];assert.equal(h.FUND.unresolved,false);assert.equal(h.EXAMPLE,undefined);
});

test('identical newer observations advance freshness and prevent older files from closing or replacing them',async()=>{
  const datedSnapshot = day => modifiedSnapshot(a => { a.positions.forEach(p=>p.effective_date=day); a.lot_scopes.forEach(s=>s.effective_date=day); });
  const first = await previewImport(emptyState(),await sources([datedSnapshot('2026-09-08')]),mapping);
  const state = acceptPreview(emptyState(),first,decision(first)).state;
  const accountId = state.accounts[0].id;
  const fresh = await previewImport(state,await sources([datedSnapshot('2026-09-10')]),{...mapping,accountId});
  const result = acceptPreview(state,fresh,decision(fresh));
  assert.equal(result.duplicate,false);
  assert.equal(result.state.holdings[accountId].EXAMPLE.position.effective_date,'2026-09-10');
  assert.equal(result.state.holdings[accountId].EXAMPLE.lotScope.effective_date,'2026-09-10');
  const absent = samplePositions.split('\n').filter(l=>!l.startsWith('"EXAMPLE",')).join('\n').replace('2026/09/08','2026/09/09').replace('"$250.00"','"$50.00"');
  const older = await previewImport(result.state,await sources([{name:'older.csv',text:absent}]),{...mapping,accountId,completeAccount:true});
  assert.equal(older.rows.find(r=>r.symbol==='EXAMPLE').action,'retain');
  const changed = datedSnapshot('2026-09-09'); const data=JSON.parse(changed.text);
  data.accounts[0].lot_scopes[0].lots[0].acquisition_date='2024-01-10'; changed.text=JSON.stringify(data);
  const oldLots=await previewImport(result.state,await sources([changed]),{...mapping,accountId});
  assert.equal(oldLots.rows.find(r=>r.symbol==='EXAMPLE').lotAction,'archive');
});

test('reviewed return to historical values is not suppressed as a duplicate',async()=>{
  const {state,accountId,files}=await initial();
  const changed=modifiedSnapshot(a=>{a.lot_scopes[0].lots[0].acquisition_date='2024-01-10';});
  const plan=await previewImport(state,await sources([changed,{name:'positions.csv',text:samplePositions}]),{...mapping,accountId});
  const updated=acceptPreview(state,plan,{...decision(plan),reason:'Reviewed corrected acquisition date.'}).state;
  const restore=await previewImport(updated,files,{...mapping,accountId});
  const restored=acceptPreview(updated,restore,{...decision(restore),reason:'Broker confirmed original date was correct.'});
  assert.equal(restored.duplicate,false);
  assert.equal(restored.state.holdings[accountId].EXAMPLE.lotScope.lots[0].acquisition_date,'2025-01-10');
  assert.equal(restored.state.imports.length,3);
  const repeat=await previewImport(restored.state,files,{...mapping,accountId});
  assert.equal(acceptPreview(restored.state,repeat,decision(repeat)).duplicate,true);
});
test('identical evidence adopts a supplied effective date without inventing one or changing legacy replay',async()=>{
 const {state,files,accountId}=await initial();
 const h=state.holdings[accountId].EXAMPLE;h.position.effective_at=null;h.position.effective_date=null;
 const plan=await previewImport(state,files,{...mapping,accountId});
 assert.equal(plan.rows.find(r=>r.symbol==='EXAMPLE').positionAction,'refresh');
 assert.ok(plan.rows.find(r=>r.symbol==='EXAMPLE').next.position.effective_date);
 const legacy=await previewImport(state,files,{...mapping,accountId},{legacyTiming:true});
 assert.equal(legacy.rows.find(r=>r.symbol==='EXAMPLE').next.position.effective_date,null);
 assert.equal(plan.options.timingPolicy,2);
});

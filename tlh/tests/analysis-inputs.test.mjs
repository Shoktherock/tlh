import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultInputs,validateInputs,projectInputs,inputWarnings,inputChanges,exportInputsBackup,restoreInputsBackup,inspectInputsBackup,validDate} from '../src/analysis/inputs.mjs';
const accounts=[{id:'11111111-1111-4111-8111-111111111111',label:'Taxable',type:'taxable',portfolioName:'Test'},{id:'22222222-2222-4222-8222-222222222222',label:'IRA',type:'traditional_ira',portfolioName:'Test'}];
test('defaults leave assumptions and inclusion unreviewed; zero stays distinct from unknown',()=>{
  const d=defaultInputs(accounts);assert.deepEqual(validateInputs(d,accounts),d);assert.equal(d.rates.federalShort,null);assert(d.accounts.every(a=>a.scope==='unreviewed'));assert(inputWarnings(d,accounts).some(w=>w.includes('No activity rows')));
  d.rates.federalShort='0.0000';d.minLoss.amount='0.00';const v=validateInputs(d,accounts);assert.equal(v.rates.federalShort,'0');assert.equal(v.minLoss.amount,'0');assert.equal(v.rates.federalLong,null);
});
test('rates and thresholds reject ambiguous formats and bound combined rates exactly',()=>{
  for(const value of ['NaN','1e2','-1','101',100,'01','1.00001',' 10']){const d=defaultInputs(accounts);d.rates.state=value;assert.throws(()=>validateInputs(d,accounts));}
  const d=defaultInputs(accounts);d.rates.federalShort='99.9999';d.rates.state='0.0001';assert.equal(validateInputs(d,accounts).rates.state,'0.0001');d.rates.state='0.0002';assert.throws(()=>validateInputs(d,accounts),/Combined/);
  d.rates.state=null;d.minLoss.amount='$100';assert.throws(()=>validateInputs(d,accounts),/Minimum loss/);d.minLoss.amount=null;d.minLoss.currency='usd';assert.throws(()=>validateInputs(d,accounts),/currency/);
});
test('calendar ranges preserve same-day and leap-day boundaries without timezone conversion',()=>{
  assert(validDate('2024-02-29'));assert(!validDate('2026-02-29'));assert(!validDate('2026-04-31'));assert(!validDate('2026-09-15T00:00:00Z'));
  const d=defaultInputs(accounts);d.accounts[0].history={status:'available',start:'2024-02-29',end:'2024-02-29',reference:'Statement',note:''};assert.deepEqual(validateInputs(d,accounts).accounts[0].history,d.accounts[0].history);
  d.accounts[0].history.start='2024-03-01';assert.throws(()=>validateInputs(d,accounts),/range/);
});
test('unverified history cannot claim verified coverage, omitted accounts need reasons, every owned account is represented',()=>{
  const d=defaultInputs(accounts);d.accounts[0].scope='omit';assert.throws(()=>validateInputs(d,accounts),/reason/);d.accounts[0].reason='Excluded for this scenario';validateInputs(d,accounts);
  d.accounts[0].history.status='complete';assert.throws(()=>validateInputs(d,accounts),/activity records/);d.accounts[0].history.status='available';assert.throws(()=>validateInputs(d,accounts),/range/);
  assert.throws(()=>validateInputs({...defaultInputs(accounts),accounts:[defaultInputs(accounts).accounts[0]]},accounts),/every/);
  const forged=defaultInputs(accounts);forged.accounts[1].accountId=forged.accounts[0].accountId;assert.throws(()=>validateInputs(forged,accounts),/duplicated/);
  forged.accounts[1].accountId='other';assert.throws(()=>validateInputs(forged,accounts),/owned/);
});
test('unknown fields, omitted details, empty references and unlisted household accounts are rejected or flagged',()=>{
  const d=defaultInputs(accounts);assert.throws(()=>validateInputs({...d,verified:true},accounts),/Unsupported/);
  d.household='additional_accounts';assert.throws(()=>validateInputs(d,accounts),/Household/);d.householdNote='External household IRA';assert(inputWarnings(validateInputs(d,accounts),accounts).some(w=>w.includes('unlisted')));
  d.accounts[0].history={status:'partial_available',start:'2026-01-01',end:'2026-09-01',reference:'',note:''};assert.throws(()=>validateInputs(d,accounts),/reference/);
});
test('new accounts remain unreviewed; planning inputs never alter or manufacture holdings or transactions',()=>{
  const d=defaultInputs(accounts);d.accounts[0].scope='include';const before=structuredClone(d),newAccount={id:'third',type:'unknown',label:'New'};
  const next=projectInputs(d,[...accounts,newAccount]);assert.equal(next.accounts[2].scope,'unreviewed');assert.equal(next.accounts[2].history.status,'not_reviewed');assert.deepEqual(d,before);assert(!Object.hasOwn(next,'transactions'));
  assert(inputChanges(null,d,accounts).some(c=>c.after==='Include'));assert.deepEqual(inputChanges(d,d,accounts),[]);
});
test('backup round-trip preserves declarations and unknowns with explicit type-safe account remapping',()=>{
  const d=defaultInputs(accounts);d.rates.federalLong='15';d.accounts[0].scope='include';d.accounts[1].scope='omit';d.accounts[1].reason='Not supplied';
  const backup=exportInputsBackup(d,accounts);assert.deepEqual(inspectInputsBackup(backup).input,d);
  const targets=accounts.map(a=>({...a,id:`new-${a.id}`})),mapping=Object.fromEntries(accounts.map((a,i)=>[a.id,targets[i].id]));const restored=restoreInputsBackup(backup,mapping,targets);assert.equal(restored.rates.federalLong,'15');assert.equal(restored.accounts[0].accountId,targets[0].id);assert.equal(restored.accounts[1].reason,'Not supplied');
  assert.throws(()=>restoreInputsBackup(backup,{},targets),/Map every/);assert.throws(()=>restoreInputsBackup(backup,{[accounts[0].id]:targets[1].id,[accounts[1].id]:targets[0].id},targets),/same type/);
  assert.throws(()=>inspectInputsBackup({...backup,version:2}),/version 1/);assert.throws(()=>inspectInputsBackup({...backup,input:{...d,transactions:[]}}),/Unsupported/);
});
test('duplicate labels and shared ID prefixes cannot hide an account change in the review',()=>{
  const sameNames=[{id:'11111111-1111-4111-8111-111111111111',label:'Same',type:'taxable'},{id:'11111111-2222-4222-8222-222222222222',label:'Same',type:'taxable'}];
  const before=defaultInputs(sameNames);before.accounts[0].scope='include';before.accounts[1].scope='omit';before.accounts[1].reason='Separate account';const after=structuredClone(before);after.accounts[0].scope='omit';after.accounts[0].reason='New omission';const changes=inputChanges(before,validateInputs(after,sameNames),sameNames);
  assert(changes.some(c=>c.label.includes(sameNames[0].id)&&c.before==='Include'&&c.after==='Omit'));
});

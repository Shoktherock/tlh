import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readinessSteps} from '../src/readiness.mjs';
const report=()=>({asOf:'2026-10-05T15:00:00Z',accounts:[{id:'a'}],rows:[{positionDate:'2026-10-02',lotCoverage:'complete',lots:[{}],issues:[],price:{kind:'provider',priceDate:'2026-10-02'},priceStatus:'daily-close',marketValue:'10'}]});
test('empty workspace never completes holdings, lots, reconciliation, prices or history',()=>{
  assert.ok(readinessSteps({asOf:report().asOf,accounts:[],rows:[]},[]).every(s=>!s.done));
});
test('old closing prices and scenarios are not fresh provider evidence',()=>{
  const r=report();
  assert.equal(readinessSteps(r,null).find(s=>s.id==='prices').done,true);
  r.rows[0].price.priceDate='2026-09-01';
  assert.equal(readinessSteps(r,null).find(s=>s.id==='prices').done,false);
  r.rows[0].price={kind:'user-scenario',priceDate:'2026-10-02'};
  assert.equal(readinessSteps(r,null).find(s=>s.id==='prices').done,false);
});
test('complete lots do not hide reconciliation or missing history',()=>{
  const r=report();r.rows[0].issues=[{title:'Basis mismatch'}];
  const steps=readinessSteps(r,null);
  assert.equal(steps.find(s=>s.id==='lots').done,true);
  assert.equal(steps.find(s=>s.id==='reconcile').done,false);
  assert.equal(steps.find(s=>s.id==='activity').done,false);
});
test('partial or uncertain transaction coverage cannot count as supplied coverage',()=>{
  const r=report();
  for(const status of ['gaps','uncertain_records'])assert.equal(readinessSteps(r,[{status}]).find(s=>s.id==='activity').done,false);
  assert.equal(readinessSteps(r,[{status:'covered_in_supplied_records'}]).find(s=>s.id==='activity').done,true);
});

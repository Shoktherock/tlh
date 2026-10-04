import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browsingInputs} from '../src/analysis/browse-inputs.mjs';
import {defaultInputs,validateInputs} from '../src/analysis/inputs.mjs';
test('browsing defaults are temporary, taxable-only and do not manufacture tax rates or reviewed history',()=>{
  const accounts=[{id:'tax',type:'taxable'},{id:'ira',type:'roth_ira'},{id:'unknown',type:'unknown'}];
  for(const saved of [null,defaultInputs(accounts)]){
    if(saved){saved.analysisDate='2026-09-01';saved.minLoss.amount='500';saved.accounts[0].scope='omit';saved.accounts[0].reason='Saved exclusion';saved.rates.federalShort='35';}
    const before=JSON.stringify(saved),result=browsingInputs(saved,accounts,'2026-09-23');
    validateInputs(result,accounts);assert.equal(result.analysisDate,'2026-09-23');assert.equal(result.minLoss.amount,'0');assert.deepEqual(result.accounts.map(a=>a.scope),['include','omit','omit']);assert.equal(result.rates.federalShort,null);assert.equal(result.accounts[0].history.status,'not_reviewed');assert.equal(JSON.stringify(saved),before);
  }
});

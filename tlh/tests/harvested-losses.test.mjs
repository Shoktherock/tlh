import {test} from 'node:test';import assert from 'node:assert/strict';import {harvestedLossSummary} from '../src/analysis/harvested-losses.mjs';
test('harvest summary scopes accepted taxable sales without presenting proceeds as loss',()=>{
 const batch=(id,accountId,transactions)=>({kind:'batch',id,accountId,document:{reference:'test'},dependencies:[],transactions});
 const sell=(date)=>({action:'sell',date,cashAmount:'1000'});
 const activity={events:[batch('a','tax',[sell('2026-09-20'),sell('2026-10-01'),sell(null)]),batch('b','ira',[sell('2026-09-20')])]};
 const r=harvestedLossSummary(activity,[{id:'tax',type:'taxable'},{id:'ira',type:'traditional_ira'}],'2026-09-29');
 assert.equal(r.saleCount,1);assert.equal(r.amount,null);assert.equal(r.unresolvedCount,1);assert.equal(r.future,1);assert.equal(r.undated,1);assert.equal(harvestedLossSummary(activity,[],'2026-09-29').saleCount,0);assert.equal(harvestedLossSummary(null,[],'2026-09-29'),null);
});

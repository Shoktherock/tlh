import {test} from 'node:test';import assert from 'node:assert/strict';import {brokerLossBreakdown} from '../src/analysis/loss-summary.mjs';
test('broker loss breakdown preserves exact currency totals and includes unrecognized labels without counting excluded lots',()=>{
 const r=(brokerTerm,loss,currency='USD',candidate=true)=>({brokerTerm,loss,currency,candidate});
 const result=brokerLossBreakdown([r('Short Term','0.1'),r('short-term','0.2'),r('Long Term','100.03'),r(null,'2'),r('other','3'),r('Long Term','999','USD',false),r('Long Term','4','EUR')]);
 assert.equal(result[0].amount,'105.33');assert.deepEqual(result[0].buckets,[{term:'short',count:2,amount:'0.3'},{term:'long',count:1,amount:'100.03'},{term:'unknown',count:2,amount:'5'}]);assert.equal(result[1].amount,'4');assert.deepEqual(brokerLossBreakdown([]),[]);
});

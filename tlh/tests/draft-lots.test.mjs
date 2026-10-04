import test from 'node:test';
import assert from 'node:assert/strict';
import {draftLots} from '../src/analysis/draft-lots.mjs';
const h={active:true,lotCoverage:'complete',lotScope:{source_id:'source',lots:[{quantity:'3',total_basis:'100',row_ref:'1'},{quantity:'1.25',total_basis:'125',row_ref:'2'}]}};
test('draft selection preserves distinct lots and calculates fractional proceeds and prorated basis',()=>{
 const before=structuredClone(h),r=draftLots(h,[{index:0,quantity:'1'},{index:1,quantity:'0.25'}],'90.12');
 assert.equal(r.quantity,'1.25');assert.equal(r.amount,'112.65');assert.equal(r.basis,'58.33');assert.equal(r.potentialLoss,'-54.32');assert.deepEqual(h,before);
 assert.equal(draftLots(h,[{index:0,quantity:'3'}],'20').basis,'100');
});
test('draft selection rejects missing, stale, duplicate and oversized quantities',()=>{
 for(const selections of [[],[{index:0,quantity:'3.000000000001'}],[{index:0,quantity:'0'}],[{index:0,quantity:'1e1'}],[{index:3,quantity:'1'}],[{index:0,quantity:'1'},{index:0,quantity:'1'}]])assert.throws(()=>draftLots(h,selections,'90'));
 assert.throws(()=>draftLots({...h,lotCoverage:'retained'},[{index:0,quantity:'1'}],'90'));
 assert.throws(()=>draftLots(h,[{index:0,quantity:'1'}],'0'));
});

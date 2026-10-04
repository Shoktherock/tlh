import {test} from 'node:test';import assert from 'node:assert/strict';import {transactionReconciliation} from '../src/analysis/transaction-reconciliation.mjs';
const state=date=>({accounts:[{id:'a'}],holdings:{a:{ABC:{active:true,position:{effective_date:date},lotScope:{observed_at:date?`${date}T18:00:00Z`:null}}}}});
const activity={events:[{kind:'batch',id:'b',accountId:'a',document:{reference:'test'},transactions:[{id:'s',action:'sell',symbol:'ABC',date:'2026-09-23',quantity:'1'}],dependencies:[]}]};
test('newer sales and ambiguous same-day evidence require reconciliation; later captures resolve the flag',()=>{
 for(const d of [null,'2026-09-22','2026-09-23'])assert.equal(transactionReconciliation(state(d),activity).length,1);
 assert.equal(transactionReconciliation(state('2026-09-24'),activity).length,0);
 const closed=state(null);closed.holdings.a.ABC.active=false;assert.equal(transactionReconciliation(closed,activity).length,0);
 const other=structuredClone(activity);other.events[0].accountId='other';assert.equal(transactionReconciliation(state(null),other).length,0);
});

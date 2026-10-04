import {test} from 'node:test';import assert from 'node:assert/strict';import {parseRealized,summarizeRealized} from '../src/realized/engine.mjs';import {realizedFixture} from './local/realized-fixture.mjs';
test('realized report parses exact reported amounts, range and term without counting transaction totals',()=>{
 const r=parseRealized(realizedFixture());assert.equal(r.summary.loss,'20');assert.equal(r.summary.net,'-20');assert.equal(r.summary.short,'-20');assert.equal(r.start,'2026-01-01');assert.equal(r.rows[0].disallowed,null);
 assert.throws(()=>parseRealized(realizedFixture({basis:'121'})),/reconcile/);
 assert.throws(()=>parseRealized(realizedFixture({end:'09/22/2026'})),/dates/);
 const rows=[...r.rows,{...r.rows[0],gainLoss:'30',term:'Long Term'}];assert.deepEqual([summarizeRealized(rows).loss,summarizeRealized(rows).gains,summarizeRealized(rows).net],['20','30','10']);
});

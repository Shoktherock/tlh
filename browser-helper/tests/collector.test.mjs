import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../src/collector.mjs';
import { validateSnapshot, securityKey } from '../src/contract.mjs';
import { fakeAdapter, options, position } from './fixtures.mjs';

test('automatically opens, paginates, closes, and continues to the next security', async () => {
  const adapter = fakeAdapter(); const result = await collect(adapter, options);
  assert.deepEqual(adapter.calls, ['open:ONE', 'read:ONE:0', 'next:ONE', 'read:ONE:1', 'close:ONE', 'open:TWO', 'read:TWO:0', 'next:TWO', 'read:TWO:1', 'close:TWO']);
  assert.deepEqual(result.accounts[0].lot_scopes.map((s) => s.status), ['complete', 'complete']);
  assert.deepEqual(validateSnapshot(result), { valid: true, errors: [] });
});
test('one failed panel is closed, reported, and does not lose the next security', async () => {
  const adapter = fakeAdapter({ fail: 'ONE' }); const result = await collect(adapter, options);
  assert.deepEqual(result.accounts[0].lot_scopes.map((s) => s.status), ['failed', 'complete']);
  assert.ok(adapter.calls.includes('close:ONE')); assert.ok(validateSnapshot(result).valid);
});
test('retry replaces incomplete scope and retains successful scope without duplication', async () => {
  const previous = await collect(fakeAdapter({ fail: 'ONE' }), options);
  const adapter = fakeAdapter(); const result = await collect(adapter, { ...options, previous });
  assert.equal(result.accounts[0].lot_scopes.length, 2);
  assert.equal(adapter.calls.filter((s) => s.startsWith('open')).length, 1);
  assert.deepEqual(result.accounts[0].lot_scopes[1], previous.accounts[0].lot_scopes[1]);
  assert.ok(validateSnapshot(result).valid);
});
test('changed positions block retry instead of reusing stale totals', async () => {
  const previous = await collect(fakeAdapter({ fail: 'ONE' }), options);
  const adapter = fakeAdapter(); adapter.positions = async () => ({ complete: true, positions: [{ ...position('ONE'), quantity: '1' }, position('TWO')] });
  await assert.rejects(collect(adapter, { ...options, previous }), { code: 'POSITION_CHANGED' });
});
test('cancellation retains collected rows and marks remaining scopes skipped', async () => {
  const controller = new AbortController();
  const result = await collect(fakeAdapter(), { ...options, signal: controller.signal, onProgress(event) { if (event.kind === 'page') controller.abort(); } });
  assert.deepEqual(result.accounts[0].lot_scopes.map((s) => s.status), ['partial', 'skipped']);
  assert.equal(result.accounts[0].lot_scopes[0].lots.length, 1); assert.ok(validateSnapshot(result).valid);
});
test('account switch discards in-flight rows and stops further clicks', async () => {
  const adapter = fakeAdapter({ contextChange: true }); const result = await collect(adapter, options);
  assert.equal(result.accounts[0].lot_scopes[0].lots.length, 0);
  assert.equal(adapter.calls.filter((s) => s.startsWith('open')).length, 1);
  assert.ok(validateSnapshot(result).valid);
});
test('repeated pagination stops without duplicating rows or claiming completeness', async () => {
  const result = await collect(fakeAdapter({ repeat: true }), options);
  for (const scope of result.accounts[0].lot_scopes) { assert.equal(scope.status, 'partial'); assert.equal(scope.lots.length, 1); }
  assert.ok(validateSnapshot(result).valid);
});
test('unknown basis/date stays null and is explicitly disclosed', async () => {
  const result = await collect(fakeAdapter({ unknown: true }), options);
  assert.equal(result.accounts[0].lot_scopes[0].lots[0].total_basis, null);
  assert.ok(result.accounts[0].lot_scopes[0].issues.some((i) => i.code === 'MISSING_LOT_FIELDS'));
  assert.ok(validateSnapshot(result).valid);
});
test('subset and filtered enumeration never claim complete positions coverage', async () => {
  const subset = await collect(fakeAdapter(), { ...options, selected: [securityKey(position('ONE').security)] });
  assert.equal(subset.accounts[0].positions_coverage, 'partial');
  const filtered = await collect(fakeAdapter({ complete: false }), options);
  assert.equal(filtered.accounts[0].positions_coverage, 'partial');
});

test('cleanup failure is disclosed and stops further navigation', async () => {
  const adapter = fakeAdapter(); adapter.closeLots = async () => { throw new Error('Panel stuck'); };
  const result = await collect(adapter, options);
  assert.ok(result.accounts[0].lot_scopes[0].issues.some((i) => i.code === 'CONTEXT_LOST'));
  assert.equal(result.accounts[0].lot_scopes[1].status, 'skipped');
  assert.equal(adapter.calls.filter((call) => call.startsWith('open')).length, 1);
});

test('pilot limit is enforced before opening any lot panel', async () => {
  const adapter = fakeAdapter();
  await assert.rejects(collect(adapter, { ...options, maxSecurities: 1 }), { code: 'PILOT_LIMIT' });
  assert.equal(adapter.calls.length, 0);
});

test('account changed since selection was reviewed blocks all collection clicks', async () => {
  const adapter = fakeAdapter();
  await assert.rejects(collect(adapter, { ...options, expectedContext: 'different-account' }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(adapter.calls.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../src/collector.mjs';
import { validateSnapshot, serializeSnapshot } from '../src/contract.mjs';
import { parseDecimal, sumDecimals, equalDecimals } from '../src/decimal.mjs';
import { fakeAdapter, options } from './fixtures.mjs';

test('money and fractional quantities stay exact, including beyond JS safe integers', () => {
  assert.equal(parseDecimal('$1,234.560'), '1234.560');
  assert.equal(sumDecimals(['0.1', '0.2']), '0.3');
  assert.equal(sumDecimals(['9007199254740993', '0.000001']), '9007199254740993.000001');
  assert.ok(equalDecimals('1.000', '1')); assert.equal(sumDecimals(['1', null]), null);
  assert.equal(parseDecimal('--', { allowUnknown: true }), null);
  for (const bad of ['1,23', '-1', '1e3', 'NaN', '']) assert.throws(() => parseDecimal(bad));
});
test('schema accepts valid export and rejects unsupported versions and missing fields', async () => {
  const result = await collect(fakeAdapter(), options); assert.equal(JSON.parse(serializeSnapshot(result)).schema_version, '1.0');
  result.schema_version = '2.0'; assert.equal(validateSnapshot(result).valid, false);
  result.schema_version = '1.0'; delete result.accounts[0].lot_scopes[0].lots[0].total_basis;
  assert.equal(validateSnapshot(result).valid, false);
});
test('invalid calendar dates and numeric coercions cannot pass validation', async () => {
  const result = await collect(fakeAdapter(), options);
  result.accounts[0].lot_scopes[0].lots[0].acquisition_date = '2025-02-30'; assert.equal(validateSnapshot(result).valid, false);
  result.accounts[0].lot_scopes[0].lots[0].acquisition_date = '2024-02-29';
  result.accounts[0].lot_scopes[0].lots[0].quantity = 1; assert.equal(validateSnapshot(result).valid, false);
});
test('identical-looking lots remain distinct; duplicate source row references do not', async () => {
  const result = await collect(fakeAdapter(), options); const scope = result.accounts[0].lot_scopes[0];
  scope.lots[1] = { ...scope.lots[0], row_ref: 'second-identical-lot' };
  scope.reported_totals = { quantity: '2', total_basis: '200' }; result.accounts[0].positions[0].quantity = '2'; result.accounts[0].positions[0].total_basis = '200';
  assert.ok(validateSnapshot(result).valid);
  scope.lots[1].row_ref = scope.lots[0].row_ref; assert.equal(validateSnapshot(result).valid, false);
});
test('empty complete scopes cannot imply liquidation without explicit zero evidence', async () => {
  const result = await collect(fakeAdapter(), options); const scope = result.accounts[0].lot_scopes[0];
  scope.lots = []; scope.completeness_evidence.displayed_row_count = 0;
  scope.reported_totals = { quantity: '0', total_basis: '0' };
  result.accounts[0].positions[0].quantity = '0'; result.accounts[0].positions[0].total_basis = '0';
  assert.equal(validateSnapshot(result).valid, false);
  scope.completeness_evidence.zero_position_confirmed = true; assert.ok(validateSnapshot(result).valid);
});
test('matching account suffixes do not merge distinct account references', async () => {
  const result = await collect(fakeAdapter(), options);
  result.accounts.push({ ...structuredClone(result.accounts[0]), account_ref: 'b' }); assert.ok(validateSnapshot(result).valid);
  result.accounts[1].account_ref = 'a'; assert.equal(validateSnapshot(result).valid, false);
});
test('timestamps and completeness claims are checked semantically', async () => {
  const result = await collect(fakeAdapter(), options);
  result.capture_completed_at = '2026-09-05T10:00:00Z'; assert.equal(validateSnapshot(result).valid, false);
  result.capture_completed_at = result.capture_started_at;
  result.accounts[0].lot_scopes[0].completeness_evidence.displayed_row_count = 100;
  assert.equal(validateSnapshot(result).valid, false);
});

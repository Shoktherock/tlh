import {syntheticLotsCsv} from './fixtures/schwab-lots.synthetic.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { schwabDate } from '../src/schwab-values.mjs';
import { parseSchwabLotReference, compareSchwabReference } from '../src/verify-schwab-csv.mjs';

const csv = syntheticLotsCsv;
function scopeFrom(reference) {
  return { security: { symbol: reference.symbol }, status: 'complete', lots: structuredClone(reference.lots),
    reported_totals: { ...reference.reported_totals }, issues: [] };
}
test('Schwab source dates validate actual calendar dates and preserve unknowns', () => {
  assert.equal(schwabDate('02/29/2024').value, '2024-02-29');
  for (const invalid of ['02/29/2025', '02/30/2024', '13/01/2025', '1/2/2025', 'various']) assert.equal(schwabDate(invalid).value, null);
  assert.equal(schwabDate('--').unknown, true); assert.equal(schwabDate('various').unknown, false);
});
test('observed lot CSV shape normalizes exact values and retains repeated lots', () => {
  const reference = parseSchwabLotReference(csv);
  assert.equal(reference.lots.length, 3); assert.equal(reference.lots[0].acquisition_date, '2024-02-29');
  assert.equal(reference.reported_totals.quantity, '3.500'); assert.equal(reference.reported_totals.total_basis, '350.00');
  assert.deepEqual(reference.issues, []); assert.equal('masked_identifier' in reference, false);
  assert.equal(compareSchwabReference(scopeFrom(reference), reference).matches, true);
});
test('comparison ignores row order/decimal formatting but preserves multiplicity', () => {
  const reference = parseSchwabLotReference(csv); const scope = scopeFrom(reference);
  scope.lots.reverse(); scope.lots[0].quantity = '1.5'; scope.lots[0].total_basis = '150';
  assert.equal(compareSchwabReference(scope, reference).matches, true);
  scope.lots.pop(); const result = compareSchwabReference(scope, reference);
  assert.equal(result.matches, false); assert.equal(result.missing_rows, 1);
});
test('same totals with different lot allocations fail the row comparison', () => {
  const reference = parseSchwabLotReference(csv); const scope = scopeFrom(reference);
  scope.lots[0].total_basis = '90'; scope.lots[1].total_basis = '110';
  const result = compareSchwabReference(scope, reference);
  assert.equal(result.matches, false); assert.equal(result.missing_rows, 2); assert.equal(result.unexpected_rows, 2);
});
test('unknown fields stay null and prevent a clean comparison result', () => {
  const reference = parseSchwabLotReference(csv.replace('"02/29/2024","1.000"', '"Various","1.000"').replace('"$90.00","$100.00","-$10.00"', '"$90.00","--","-$10.00"'));
  assert.equal(reference.lots[0].acquisition_date, null); assert.equal(reference.lots[0].total_basis, null);
  assert.equal(compareSchwabReference(scopeFrom(reference), reference).matches, false);
});
test('malformed/truncated CSV and misplaced Total rows are rejected', () => {
  assert.throws(() => parseSchwabLotReference(csv.slice(0, -4)), /Unterminated/);
  assert.throws(() => parseSchwabLotReference(csv.replace('"Open Date"', '"Purchase Date"')), /headers/);
  assert.throws(() => parseSchwabLotReference(csv.replace(/"Total"[^\n]+/, '')), /Total/);
  assert.throws(() => parseSchwabLotReference(csv + '"Total","0","--","--","0","0","0","0","--"\n'), /Total/);
});
test('BOM, CRLF, quoted grouping, and escaped quotes parse without numeric coercion', () => {
  const changed = '\uFEFF' + csv.replace('for ...000', 'for ""Synthetic Account"" ...000').replaceAll('"$100.00"', '"$1,000.00"').replaceAll('\n', '\r\n');
  const reference = parseSchwabLotReference(changed); assert.equal(reference.lots[0].cost_per_share, '1000.00');
  assert.ok(reference.issues.some((i) => i.code === 'REFERENCE_BASIS_MISMATCH'));
});
test('symbol and capture completeness mismatches cannot pass', () => {
  const reference = parseSchwabLotReference(csv); const scope = scopeFrom(reference);
  scope.security.symbol = 'OTHER'; scope.status = 'partial';
  const result = compareSchwabReference(scope, reference);
  assert.ok(result.issues.includes('SYMBOL_MISMATCH')); assert.ok(result.issues.includes('INCOMPLETE_CAPTURE'));
});

import { schwabDate, schwabDecimal } from './schwab-values.mjs';
import { sumDecimals, equalDecimals } from './decimal.mjs';

const headers = ['Open Date', 'Quantity', 'Price', 'Cost/Share', 'Market Value', 'Cost Basis', 'Gain/Loss ($)', 'Gain/Loss (%)', 'Holding Period'];

// Only for the observed Schwab Lot Details reference export. Not a TLH import adapter.
function csvRows(text) {
  const rows = []; let row = []; let field = ''; let quoted = false; let closed = false;
  const input = text.replace(/^\uFEFF/, '');
  const endField = () => { row.push(field); field = ''; closed = false; };
  const endRow = () => { endField(); if (row.some((cell) => cell.trim())) rows.push(row); row = []; };
  for (let index = 0; index < input.length; index++) {
    const ch = input[index];
    if (quoted) {
      if (ch === '"') {
        if (input[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closed = true; }
      } else field += ch;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      if (ch === ',') endField();
      else { endRow(); if (ch === '\r' && input[index + 1] === '\n') index++; }
    } else if (ch === '"') {
      if (field || closed) throw new Error('Unexpected quote in reference CSV.');
      quoted = true;
    } else {
      if (closed) throw new Error('Unexpected text after a closing CSV quote.');
      field += ch;
    }
  }
  if (quoted) throw new Error('Unterminated quoted field in reference CSV.');
  if (row.length || field || closed) endRow();
  return rows;
}

export function parseSchwabLotReference(text) {
  const rows = csvRows(text);
  if (rows.length < 3) throw new Error('Reference CSV needs a title, header, and Total row.');
  const title = /^(\S+) Lot Details for\s+.+?\s+as of\s+(.+)$/i.exec(rows[0][0]);
  if (!title) throw new Error('Unrecognized Schwab Lot Details title.');
  if (rows[1].length !== headers.length || rows[1].some((cell, index) => cell.trim() !== headers[index])) {
    throw new Error('Reference CSV headers do not match the observed Lot Details format.');
  }
  const lots = []; const issues = []; let totals = null;
  for (let index = 2; index < rows.length; index++) {
    const row = rows[index];
    if (row.length !== headers.length) throw new Error(`Reference data row ${index - 1} has the wrong number of columns.`);
    if (row[0].trim() === 'Total') {
      if (totals || index !== rows.length - 1) throw new Error('Reference CSV must end with exactly one Total row.');
      totals = { quantity: schwabDecimal(row[1]), total_basis: schwabDecimal(row[5], true) }; continue;
    }
    const date = schwabDate(row[0]);
    if (!date.value) issues.push({ code: date.unknown ? 'UNKNOWN_DATE' : 'UNPARSED_DATE', row: index - 1 });
    const quantity = schwabDecimal(row[1]);
    if (equalDecimals(quantity, '0')) throw new Error(`Reference data row ${index - 1} has zero quantity.`);
    const basis = schwabDecimal(row[5], true);
    if (basis === null) issues.push({ code: 'UNKNOWN_BASIS', row: index - 1 });
    lots.push({ acquisition_date: date.value, quantity, total_basis: basis,
      cost_per_share: schwabDecimal(row[3], true), broker_holding_period: row[8].trim() || null });
  }
  if (!totals) throw new Error('Reference CSV has no final Total row.');
  if (!equalDecimals(sumDecimals(lots.map((lot) => lot.quantity)), totals.quantity)) issues.push({ code: 'REFERENCE_QUANTITY_MISMATCH' });
  const totalBasis = sumDecimals(lots.map((lot) => lot.total_basis));
  if (totalBasis !== null && totals.total_basis !== null && !equalDecimals(totalBasis, totals.total_basis)) issues.push({ code: 'REFERENCE_BASIS_MISMATCH' });
  // Keep only the source as-of text. Account descriptors are not needed for this comparison.
  return { symbol: title[1], as_of_text: title[2], lots, reported_totals: totals, issues };
}

const canonicalDecimal = (value) => value === null ? null : (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);
const rowKey = (lot) => JSON.stringify([lot.acquisition_date, canonicalDecimal(lot.quantity), canonicalDecimal(lot.total_basis),
  canonicalDecimal(lot.cost_per_share), lot.broker_holding_period?.trim().toLowerCase() ?? null]);

export function compareSchwabReference(scope, reference) {
  const issues = reference.issues.map((finding) => finding.code);
  if (scope.security.symbol !== reference.symbol) issues.push('SYMBOL_MISMATCH');
  if (scope.status !== 'complete') issues.push('INCOMPLETE_CAPTURE');
  if (scope.issues.length) issues.push('CAPTURE_HAS_ISSUES');
  const remaining = new Map();
  for (const lot of reference.lots) { const key = rowKey(lot); remaining.set(key, (remaining.get(key) ?? 0) + 1); }
  let unexpected = 0;
  for (const lot of scope.lots) {
    const key = rowKey(lot); const count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1); else unexpected++;
  }
  const missing = [...remaining.values()].reduce((sum, count) => sum + count, 0);
  if (missing || unexpected) issues.push('LOT_ROWS_DIFFER');
  for (const field of ['quantity', 'total_basis']) {
    if (scope.reported_totals[field] === null || reference.reported_totals[field] === null) issues.push(`UNKNOWN_${field.toUpperCase()}_TOTAL`);
    else if (!equalDecimals(scope.reported_totals[field], reference.reported_totals[field])) issues.push(`${field.toUpperCase()}_TOTAL_DIFFERS`);
  }
  return { matches: issues.length === 0, reference_rows: reference.lots.length, captured_rows: scope.lots.length,
    missing_rows: missing, unexpected_rows: unexpected, issues: [...new Set(issues)] };
}

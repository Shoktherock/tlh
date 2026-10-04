import validateShape from '../generated/validate.cjs';
import { sumDecimals, equalDecimals } from './decimal.mjs';

export const issue = (code, message, source_ref, severity = 'warning') => ({ code, severity, message, source_ref });
export const securityKey = (security) => JSON.stringify([security.symbol, security.broker_security_id ?? null, security.exchange ?? null]);

export function scopeIssues(scope, position) {
  const issues = [];
  if (!scope.lots.length && scope.status !== 'complete') return issues;
  const check = (field, label) => {
    const sum = sumDecimals(scope.lots.map((lot) => lot[field]));
    const reported = scope.reported_totals[field];
    if (sum !== null && reported !== null && !equalDecimals(sum, reported)) {
      issues.push(issue(`${label}_MISMATCH`, `Collected ${label.toLowerCase()} does not match the displayed lot total.`, scope.source_ref));
    }
    if (position && sum !== null && position[field] !== null && !equalDecimals(sum, position[field])) {
      issues.push(issue(`POSITION_${label}_MISMATCH`, `Collected ${label.toLowerCase()} differs from the earlier position observation; review timestamps.`, scope.source_ref));
    }
  };
  check('quantity', 'QUANTITY');
  check('total_basis', 'BASIS');
  if (scope.lots.some((lot) => lot.total_basis === null || lot.acquisition_date === null || lot.currency === null)) {
    issues.push(issue('MISSING_LOT_FIELDS', 'Some lots have unknown basis, acquisition date, or currency.', scope.source_ref));
  }
  return issues;
}

export function validateSnapshot(snapshot) {
  if (!validateShape(snapshot)) {
    return { valid: false, errors: validateShape.errors.map((error) => `${error.instancePath || '/'} ${error.message}`) };
  }
  const errors = [];
  const unique = (values, label) => { if (new Set(values).size !== values.length) errors.push(`${label} must be unique`); };
  unique(snapshot.accounts.map((a) => a.account_ref), 'Account references');
  const start = Date.parse(snapshot.capture_started_at);
  const end = Date.parse(snapshot.capture_completed_at);
  if (start > end) errors.push('Capture end precedes start');
  for (const account of snapshot.accounts) {
    unique(account.positions.map((p) => securityKey(p.security)), 'Position security identities');
    unique(account.lot_scopes.map((s) => securityKey(s.security)), 'Lot scope security identities');
    for (const observation of [...account.positions, ...account.lot_scopes]) {
      const observed = Date.parse(observation.observed_at);
      if (observed < start || observed > end) errors.push('Observation outside capture interval');
      if (observation.effective_at && observation.effective_date && observation.effective_at.slice(0, 10) !== observation.effective_date) {
        errors.push('Effective date disagrees with effective timestamp');
      }
    }
    for (const scope of account.lot_scopes) {
      unique(scope.lots.map((lot) => lot.row_ref), 'Source row references');
      if (scope.status !== 'complete' && scope.issues.length === 0) errors.push('Incomplete scopes need an explanatory issue');
      if (['failed', 'skipped'].includes(scope.status) && scope.lots.length) errors.push('Failed/skipped scopes cannot contain lots');
      if (scope.status === 'complete' && scope.lots.length === 0 &&
          !(scope.completeness_evidence.zero_position_confirmed && equalDecimals(scope.reported_totals.quantity, '0'))) {
        errors.push('Empty complete scope needs explicit zero-position evidence');
      }
      if (scope.status === 'complete' && scope.completeness_evidence.displayed_row_count !== undefined &&
          scope.completeness_evidence.displayed_row_count !== scope.lots.length) errors.push('Complete scope row count mismatch');
      for (const lot of scope.lots) {
        if (equalDecimals(lot.quantity, '0')) errors.push('A lot must have positive quantity');
      }
      // Discrepancies are exportable observations, provided they are disclosed.
      const expected = scopeIssues(scope, account.positions.find((p) => securityKey(p.security) === securityKey(scope.security)));
      for (const finding of expected) {
        if (!scope.issues.some((i) => i.code === finding.code)) errors.push(`Undisclosed ${finding.code}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function serializeSnapshot(snapshot) {
  const result = validateSnapshot(snapshot);
  if (!result.valid) throw new Error(`Export validation failed: ${result.errors.join('; ')}`);
  return JSON.stringify(snapshot, null, 2);
}

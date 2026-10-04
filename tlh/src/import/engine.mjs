import { assemble, hash } from './sources.mjs';
import {annotateImportCorrections} from './corrections.mjs';
import { equalDecimals, sumDecimals } from '../../../browser-helper/src/decimal.mjs';

export const emptyState = () => ({ version: 1, revision: 0, accounts: [], holdings: {}, cash: {}, imports: [] });
const canonicalDecimal = value => value === null || value === undefined ? null : value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
const security = value => [value.symbol, value.broker_security_id ?? null, value.exchange ?? null];
const positionContent = p => p ? [security(p.security), canonicalDecimal(p.quantity), canonicalDecimal(p.total_basis), p.currency] : null;
const lotContent = l => [l.broker_lot_id, l.acquisition_date, l.raw_acquisition_date ?? null, canonicalDecimal(l.quantity), canonicalDecimal(l.total_basis), canonicalDecimal(l.cost_per_share), l.broker_holding_period?.trim().toLowerCase() ?? null, l.currency];
const scopeContent = s => s ? [s.status, canonicalDecimal(s.reported_totals.quantity), canonicalDecimal(s.reported_totals.total_basis), s.lots.map(lotContent).map(JSON.stringify).sort()] : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dated = p => p?.effective_at?.slice(0, 10) ?? p?.effective_date ?? null;
const effectiveTime = p => [p?.effective_at ?? null, p?.effective_date ?? null];
const holdingEffect = h => h ? [positionContent(h.position), effectiveTime(h.position), scopeContent(h.lotScope), effectiveTime(h.lotScope), h.active, h.closedByDate ?? null, h.lotCoverage, h.confirmedCurrency] : null;
const cashEffect = c => c ? [canonicalDecimal(c.amount), c.currency, c.confirmedCurrency, effectiveTime(c)] : null;
function order(incoming, previous) {
  if (!dated(incoming) || !dated(previous)) return 'unknown';
  if (incoming.effective_at && previous.effective_at) {
    const delta = Date.parse(incoming.effective_at) - Date.parse(previous.effective_at);
    return delta < 0 ? 'older' : delta > 0 ? 'newer' : 'same';
  }
  return dated(incoming) < dated(previous) ? 'older' : dated(incoming) > dated(previous) ? 'newer' : 'same';
}
const finding = (code, message) => ({ code, message });
function reconcile(position, scope) {
  const result = [];
  if (!scope) return result;
  for (const field of ['quantity', 'total_basis']) {
    const total = sumDecimals(scope.lots.map(l => l[field]));
    for (const [name, expected] of [['position', position[field]], ['reported lot total', scope.reported_totals[field]]]) {
      if (total !== null && expected !== null && !equalDecimals(total, expected)) result.push(finding('TOTAL_MISMATCH', `${field.replace('_', ' ')} does not match the ${name}.`));
    }
  }
  return result;
}

export async function previewImport(state, sources, options, {legacyTiming=false}={}) {
  options={...options,...(!legacyTiming?{timingPolicy:2}:{})};
  if (state.version !== 1) throw new Error('Unsupported local store version.');
  const account = state.accounts.find(a => a.id === options.accountId);
  if (options.accountId && !account) throw new Error('The target account no longer exists.');
  if (!account && (!options.accountLabel?.trim() || options.accountLabel.trim().length > 100)) throw new Error('Enter an account label of 1–100 characters.');
  if (!account && state.accounts.some(a => a.label === options.accountLabel.trim())) throw new Error('Choose the existing account, or give this separate account a distinct label.');
  if (!['taxable', 'traditional_ira', 'roth_ira', 'other', 'unknown'].includes(options.accountType)) throw new Error('Choose an account type.');
  if (options.currency !== null && !/^[A-Z]{3}$/.test(options.currency)) throw new Error('Choose a currency or explicitly keep it unknown.');
  const evidence = assemble(sources, options.sourceAccountRef);
  for (const p of evidence.positions) {
    if (['__proto__', 'constructor', 'prototype'].includes(p.security.symbol)) throw new Error('Unsupported security key.');
  }
  const currencies = [...evidence.positions, ...evidence.scopes.flatMap(s => s.lots)].map(p => p.currency).filter(Boolean);
  if (options.currency && currencies.some(c => c !== options.currency)) throw new Error('Confirmed currency conflicts with a reported source currency.');
  if (options.completeAccount && evidence.csvSymbols) {
    for (const p of evidence.positions.filter(p => !evidence.csvSymbols.includes(p.security.symbol))) evidence.issues.push({ ...finding('SOURCE_CONFLICT', 'The declared complete Positions CSV omits a security present in the lot snapshot. Review the differing observation times.'), symbol:p.security.symbol });
  }
  const prior = state.holdings[options.accountId] ?? {};
  const scopes = new Map(evidence.scopes.map(s => [s.security.symbol, s]));
  const rows = [];
  for (const position of evidence.positions) {
    const symbol = position.security.symbol;
    const scope = scopes.get(symbol) ?? null;
    const old = prior[symbol];
    if (old && !same(security(old.position.security), security(position.security))) throw new Error(`${symbol}: security identity differs from the accepted holding.`);
    const warnings = [];
    let requiresReason = false;
    const next = old ? structuredClone(old) : { position: null, lotScope: null, supplementalScope: null, active: true, warnings: [], lotCoverage: 'missing' };
    const positionSame = same(positionContent(old?.position), positionContent(position)) && old?.active === !equalDecimals(position.quantity, '0');
    const positionOrder = order(position, old?.closedByDate ? { effective_date: old.closedByDate } : old?.position);
    let positionAction = positionSame ? 'unchanged' : !old ? 'add' : positionOrder === 'older' ? 'archive' : 'replace';
    if (positionSame && (positionOrder === 'newer' || !legacyTiming && !dated(old?.position) && dated(position))) { next.position = position; positionAction = 'refresh'; }
    if (positionAction === 'archive') warnings.push(finding('OLDER_POSITIONS', 'Older position evidence is archived; the accepted position stays current.'));
    else if (!positionSame) {
      next.position = position;
      next.active = !equalDecimals(position.quantity, '0');
      if (next.active) delete next.closedByDate;
      if (old && positionOrder !== 'newer') { requiresReason = true; warnings.push(finding('POSITION_TIME_REVIEW', 'Changed position totals have unknown or overlapping effective times. Review before replacement.')); }
    }
    let lotAction = 'retain';
    if (scope?.status === 'complete') {
      const equal = same(scopeContent(old?.lotScope), scopeContent(scope));
      const lotOrder = order(scope, old?.lotScope);
      lotAction = equal ? 'unchanged' : !old?.lotScope ? 'add' : lotOrder === 'older' ? 'archive' : 'replace';
      if (equal && (lotOrder === 'newer' || !legacyTiming && !dated(old?.lotScope) && dated(scope))) { next.lotScope = scope; lotAction = 'refresh'; }
      if (lotAction === 'archive') warnings.push(finding('OLDER_LOTS', 'Older lots are archived; the accepted lot snapshot stays current.'));
      else {
        if (!equal) next.lotScope = scope;
        next.supplementalScope = null; next.lotCoverage = 'complete';
        if (!equal && old?.lotScope && lotOrder !== 'newer') { requiresReason = true; warnings.push(finding('LOT_TIME_REVIEW', 'Changed lots have unknown or overlapping effective times. Review before replacement.')); }
      }
    } else {
      next.supplementalScope = scope;
      next.lotCoverage = old?.lotScope ? 'retained' : scope?.status ?? 'missing';
      warnings.push(finding('LOTS_RETAINED', old?.lotScope ? 'New lots are absent or incomplete. Previous lots are retained and need a freshness review.' : 'No complete lot snapshot is available. This holding remains visible without actionable lot detail.'));
    }
    const comparisons = reconcile(next.position, next.lotScope);
    warnings.push(...comparisons);
    warnings.push(...(scope?.issues ?? []).map(i => finding(i.code, i.message)));
    if (comparisons.length) requiresReason = true;
    if (next.lotScope?.lots.some(l => l.acquisition_date === null || l.total_basis === null)) warnings.push(finding('UNKNOWN_LOT_FIELDS', 'Some acquisition dates or basis values are unknown.'));
    next.warnings = warnings;
    next.confirmedCurrency = options.currency;
    next.unresolved = comparisons.length > 0 || next.lotCoverage !== 'complete' || next.lotScope?.lots.some(l => l.acquisition_date === null || l.total_basis === null) || (!options.currency && next.position.currency === null);
    const changed = !same(holdingEffect(old), holdingEffect(next));
    rows.push({ symbol, action: !next.active && old?.active ? 'close' : !old ? 'add' : changed ? 'update' : positionAction === 'archive' || lotAction === 'archive' ? 'archive' : 'unchanged',
      positionAction, lotAction, current: old ?? null, next, warnings, requiresReason });
  }
  for (const [symbol, old] of Object.entries(prior)) {
    if (evidence.positions.some(p => p.security.symbol === symbol) || !old.active) continue;
    const newerComplete = options.completeAccount && evidence.csvSymbols && !evidence.csvSymbols.includes(symbol) && evidence.csvDate && dated(old.position) && evidence.csvDate > dated(old.position);
    const next = structuredClone(old);
    next.warnings = [finding(newerComplete ? 'ABSENT_FROM_COMPLETE_CSV' : 'ABSENT_FROM_UPLOAD', newerComplete ? 'Absent from a newer CSV you declared complete. Acceptance closes the current view without creating a sale.' : 'Absent from this upload. Previous holdings and lots are retained.')];
    if (newerComplete) { next.active = false; next.closedByDate = evidence.csvDate; }
    else { next.lotCoverage = old.lotScope ? 'retained' : old.lotCoverage; next.unresolved = true; }
    rows.push({ symbol, action: newerComplete ? 'close' : 'retain', positionAction: 'retain', lotAction: 'retain', current: old, next, warnings: next.warnings, requiresReason: false });
  }
  const oldCash = state.cash[options.accountId] ?? null;
  const cashOrder = order(evidence.cash, oldCash);
  const cash = evidence.cash ? { candidate: evidence.cash, next: oldCash && cashOrder === 'older' ? oldCash : { ...evidence.cash, confirmedCurrency: options.currency },
    action: oldCash && cashOrder === 'older' ? 'archive' : oldCash && oldCash.amount === evidence.cash.amount && oldCash.confirmedCurrency === options.currency ? 'unchanged' : oldCash ? 'update' : 'add',
    requiresReason: Boolean(oldCash && oldCash.amount !== evidence.cash.amount && !['older', 'newer'].includes(cashOrder)) } : null;
  const content = { positions: evidence.positions.map(positionContent).map(JSON.stringify).sort(), scopes: evidence.scopes.map(s => [security(s.security), scopeContent(s)]).map(JSON.stringify).sort(),
    cash: evidence.cash ? canonicalDecimal(evidence.cash.amount) : null, currency: options.currency, completeAccount: Boolean(options.completeAccount) };
  return annotateImportCorrections(state,{ baseRevision: state.revision, sources: structuredClone(sources), options: structuredClone(options), rows, cash, issues: evidence.issues,
    labels: evidence.labels, contentHash: await hash(JSON.stringify(content)), csvPresent: Boolean(evidence.csvSymbols),
    timing: sources.map(s => ({ name: s.name, from: s.kind === 'snapshot' ? s.data.capture_started_at : s.data.date, to: s.kind === 'snapshot' ? s.data.capture_completed_at : s.data.date })),
    createdAt: new Date().toISOString() });
}

export function acceptPreview(state, preview, decision, { id = () => crypto.randomUUID(), now = () => new Date().toISOString() } = {}) {
  if (state.revision !== preview.baseRevision) throw new Error('This preview is stale. Refresh it before accepting.');
  if (!decision.mappingReviewed || !decision.timingReviewed) throw new Error('Review source account mapping and timestamps before accepting.');
  const selected = new Set(decision.symbols);
  if ([...selected].some(s => !preview.rows.some(r => r.symbol === s))) throw new Error('Selection contains an unknown scope.');
  if (!selected.size && !(decision.includeCash && preview.cash)) throw new Error('Select at least one holding or cash observation.');
  const rows = preview.rows.filter(r => selected.has(r.symbol));
  const relevantConflict = (i, symbol) => i.code === 'CSV_BASIS_TOTAL' || (i.code === 'SOURCE_CONFLICT' && (!i.symbol || i.symbol === symbol));
  const conflicts = rows.some(r => preview.issues.some(i => relevantConflict(i,r.symbol)));
  if ((rows.some(r => r.requiresReason) || conflicts || (decision.includeCash && preview.cash?.requiresReason)) && !decision.reason?.trim()) throw new Error('Enter a review reason for unresolved differences or uncertain replacement times.');
  const accountId = preview.options.accountId ?? id();
  const effects = rows.map(r => [r.symbol, holdingEffect(r.next)]).map(JSON.stringify).sort();
  const cashSelected = Boolean(decision.includeCash && preview.cash);
  const selectionKey = JSON.stringify([preview.contentHash, [...selected].sort(), cashSelected, effects, cashSelected ? cashEffect(preview.cash.next) : null]);
  // Matching a historical import is only a no-op if its effects are still current.
  const alreadyCurrent = rows.every(r => same(holdingEffect(state.holdings[accountId]?.[r.symbol]), holdingEffect(r.next))) && (!cashSelected || same(cashEffect(state.cash[accountId]), cashEffect(preview.cash.next)));
  const duplicate = alreadyCurrent && state.imports.find(i => i.accountId === accountId && i.selectionKey === selectionKey);
  if (duplicate) return { state, duplicate: true, importId: duplicate.id };
  const next = structuredClone(state);
  if (!preview.options.accountId) next.accounts.push({ id: accountId, label: preview.options.accountLabel.trim(), type: preview.options.accountType, broker: 'schwab' });
  else if (!next.accounts.some(a => a.id === accountId)) throw new Error('Mapped account is missing.');
  const importId = id();
  next.holdings[accountId] ??= {};
  for (const row of rows) {
    next.holdings[accountId][row.symbol] = { ...structuredClone(row.next), lastImportId: importId };
    if (preview.issues.some(i => relevantConflict(i,row.symbol))) {
      next.holdings[accountId][row.symbol].unresolved = true;
      next.holdings[accountId][row.symbol].warnings.push(finding('SOURCE_CONFLICT_REVIEWED', 'Source disagreement accepted as unresolved. See the import review reason.'));
    }
  }
  if (decision.includeCash && preview.cash) next.cash[accountId] = { ...structuredClone(preview.cash.next), lastImportId: importId };
  next.imports.push({ id: importId, accountId, acceptedAt: now(), baseRevision: state.revision, selectionKey,
    sources: structuredClone(preview.sources), sourceLabels: [...preview.labels], decisions: structuredClone(decision), options: structuredClone(preview.options),
    outcomes: rows.map(r => ({ symbol: r.symbol, action: r.action, positionAction: r.positionAction, lotAction: r.lotAction, warnings: structuredClone(r.warnings) })),
    priorHoldings: Object.fromEntries(rows.filter(r => r.current).map(r => [r.symbol, structuredClone(r.current)])) });
  next.revision++;
  return { state: next, duplicate: false, importId };
}

import { issue, scopeIssues, securityKey } from './contract.mjs';

export class CollectionError extends Error {
  constructor(code, message, fatal = false) { super(message); this.code = code; this.fatal = fatal; }
}

const fallbackScope = (position, now) => ({
  security: position.security, status: 'skipped', observed_at: now(), effective_at: null, effective_date: null,
  source_ref: `lots/${position.source_ref}`, completeness_evidence: { traversal: 'Not traversed', pages_visited: 0 },
  reported_totals: { quantity: null, total_basis: null }, lots: [], issues: [],
});

export async function collect(adapter, {
  selected = null, signal, onProgress = () => {}, previous = null,
  now = () => new Date().toISOString(), id = () => crypto.randomUUID(), maxPages = 100,
  expectedContext, maxSecurities = Infinity,
} = {}) {
  const cancelled = () => {
    if (signal?.aborted) throw new CollectionError('CANCELLED', 'Collection cancelled by the user.', true);
  };
  cancelled();
  const started = now();
  const account = await adapter.account();
  const context = account.context;
  if (expectedContext !== undefined && context !== expectedContext) {
    throw new CollectionError('ACCOUNT_CHANGED', 'Account changed since the selection was displayed. Clear and review the selection again.', true);
  }
  const assert = async () => { cancelled(); await adapter.assertContext(context); };
  await assert();
  const enumeration = await adapter.positions({ selected, signal, onProgress });
  await assert();
  const keys = enumeration.positions.map((p) => securityKey(p.security));
  if (new Set(keys).size !== keys.length) throw new CollectionError('AMBIGUOUS_POSITIONS', 'Duplicate security identities need review.');
  const selectedSet = selected === null ? null : new Set(selected);
  if (selectedSet && [...selectedSet].some((key) => !keys.includes(key))) throw new CollectionError('POSITION_CHANGED', 'Selected positions changed. Refresh the selection.');
  const positions = enumeration.positions.filter((p) => selectedSet === null || selectedSet.has(securityKey(p.security)));
  if (!positions.length) throw new CollectionError('EMPTY_SELECTION', 'Select at least one position.');
  if (positions.length > maxSecurities) throw new CollectionError('PILOT_LIMIT', `Select at most ${maxSecurities} securities for this pilot.`);
  let saved = null;
  if (previous) {
    saved = previous.accounts[0];
    if (saved.account_ref !== account.account_ref) throw new CollectionError('ACCOUNT_CHANGED', 'Account changed. Start a new collection.');
    // Retrying against changed positions can hide trades; keep the existing export and require a fresh run.
    const content = (ps) => JSON.stringify(ps.map((p) => [securityKey(p.security), p.quantity, p.total_basis, p.currency]).sort());
    if (content(saved.positions) !== content(positions)) throw new CollectionError('POSITION_CHANGED', 'Positions changed. Start a new collection instead of retrying.');
  }
  const outputAccount = {
    account_ref: account.account_ref, display_label: account.display_label,
    masked_identifier: account.masked_identifier, account_type: account.account_type,
    positions_coverage: enumeration.complete && positions.length === enumeration.positions.length ? 'complete' : 'partial',
    positions: saved ? saved.positions : positions,
    lot_scopes: [], issues: [...(enumeration.issues ?? [])],
  };
  if (saved) outputAccount.issues.push(issue('RESUMED_CAPTURE', 'Successful scopes retain earlier observation times; retried scopes were observed later.', 'account'));
  const snapshot = {
    schema_version: '1.0', snapshot_id: id(), producer: { name: 'tlh-browser-helper-pilot', version: '0.3.0' },
    broker: adapter.broker, capture_started_at: previous?.capture_started_at ?? started,
    capture_completed_at: started, accounts: [outputAccount],
  };
  let stopReason = null;
  for (const position of positions) {
    const key = securityKey(position.security);
    const old = saved?.lot_scopes.find((scope) => securityKey(scope.security) === key);
    if (old?.status === 'complete') {
      outputAccount.lot_scopes.push(structuredClone(old));
      onProgress({ kind: 'scope', scope: old });
      continue;
    }
    let scope = fallbackScope(position, now);
    let opened = false;
    try {
      if (stopReason) throw stopReason;
      await assert();
      onProgress({ kind: 'opening', security: position.security });
      opened = true;
      const panel = await adapter.openLots(position.security, signal);
      await assert();
      scope.observed_at = now();
      scope.effective_at = panel.effective_at;
      scope.effective_date = panel.effective_date;
      scope.reported_totals = panel.reported_totals;
      scope.completeness_evidence.displayed_row_count = panel.row_count;
      const seenPages = new Set();
      while (true) {
        await assert();
        if (seenPages.size >= maxPages) throw new CollectionError('PAGE_LIMIT', 'Page limit reached; collection is partial.');
        const page = await adapter.readPage(position.security);
        await assert();
        if (seenPages.has(page.token)) throw new CollectionError('REPEATED_PAGE', 'Pagination repeated a page; collection is partial.');
        seenPages.add(page.token);
        scope.lots.push(...page.lots);
        scope.issues.push(...(page.issues ?? []));
        scope.completeness_evidence.pages_visited = seenPages.size;
        onProgress({ kind: 'page', security: position.security, rows: scope.lots.length, page: seenPages.size });
        if (page.last) break;
        await assert();
        await adapter.nextPage(signal);
      }
      await assert();
      if (panel.row_count !== scope.lots.length) throw new CollectionError('ROW_COUNT_MISMATCH', 'Collected rows do not match the displayed row count.');
      if (!scope.lots.length && !panel.zero_position_confirmed) throw new CollectionError('EMPTY_TABLE', 'An empty table is not proof of a zero holding.');
      scope.status = 'complete';
      scope.completeness_evidence.traversal = panel.traversal ?? 'Traversed every page through an explicit final-page marker.';
      if (panel.zero_position_confirmed) scope.completeness_evidence.zero_position_confirmed = true;
    } catch (error) {
      const reason = error instanceof CollectionError ? error : new CollectionError('COLLECTION_FAILED', 'Unexpected collection error; no additional page data was accepted.');
      if (reason.code === 'ACCOUNT_CHANGED' || reason.code === 'SESSION_EXPIRED') {
        // Discard this scope, as the current panel's provenance is now uncertain.
        scope = fallbackScope(position, now);
      }
      scope.status = scope.lots.length ? 'partial' : (reason.code === 'CANCELLED' || stopReason ? 'skipped' : 'failed');
      scope.issues.push(issue(reason.code, reason.message, scope.source_ref, 'error'));
      if (reason.fatal) stopReason = reason;
    } finally {
      // Recheck context before cleanup; never click controls in a newly selected account.
      if (opened) {
        try { await adapter.assertContext(context); await adapter.closeLots(); }
        catch {
          stopReason = new CollectionError('CONTEXT_LOST', 'Page context changed or the lot panel could not close. Start a new collection.', true);
          scope.issues.push(issue(stopReason.code, stopReason.message, scope.source_ref, 'error'));
        }
      }
    }
    scope.issues.push(...scopeIssues(scope, position));
    outputAccount.lot_scopes.push(scope);
    onProgress({ kind: 'scope', scope });
  }
  snapshot.capture_completed_at = now();
  return snapshot;
}

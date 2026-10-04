import { CollectionError } from '../collector.mjs';
import { parseDecimal } from '../decimal.mjs';
import { issue } from '../contract.mjs';

// These selectors belong ONLY to our synthetic test page. They are not Schwab selectors.
export function createDemoAdapter(doc = document, { delay = 300, timeout = 2000 } = {}) {
  const root = () => doc.querySelector('[data-tlh-demo="positions-v1"]');
  const requireRoot = () => {
    const node = root();
    if (!node) throw new CollectionError('UNSUPPORTED_PAGE', 'Open the local pilot positions page. Live Schwab support comes in Phase 2.', true);
    return node;
  };
  const wait = async (predicate, signal) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new CollectionError('CANCELLED', 'Collection cancelled by the user.', true);
      const result = predicate();
      if (result) { await new Promise((resolve) => setTimeout(resolve, delay)); return result; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new CollectionError('TIMEOUT', 'Lot panel or page did not finish loading. Retry this security.');
  };
  const value = (row, name, unknown = false) => {
    const cell = row.querySelector(`[data-field="${name}"]`);
    if (!cell) throw new CollectionError('TABLE_CHANGED', 'Expected table column is missing.');
    try { return parseDecimal(cell.textContent, { allowUnknown: unknown }); }
    catch { throw new CollectionError('INVALID_NUMBER', 'A displayed quantity or monetary value could not be parsed.'); }
  };
  const panel = () => doc.querySelector('[data-lot-panel]:not([hidden])');
  const adapter = {
    broker: 'synthetic-demo',
    async account() {
      const node = requireRoot();
      return { context: node.dataset.account, account_ref: node.dataset.account,
        display_label: 'Pilot account — synthetic data', masked_identifier: '...123', account_type: 'unknown' };
    },
    async assertContext(context) {
      const node = requireRoot();
      if (node.dataset.session === 'expired') throw new CollectionError('SESSION_EXPIRED', 'Session expired. Restore the session and retry.', true);
      if (node.dataset.account !== context) throw new CollectionError('ACCOUNT_CHANGED', 'Account changed during collection. Start a new collection.', true);
    },
    async positions() {
      const node = requireRoot();
      return { complete: node.dataset.coverage === 'complete', positions: [...node.querySelectorAll('[data-position]')].map((row, index) => ({
        security: { symbol: row.dataset.symbol }, quantity: value(row, 'quantity'), total_basis: value(row, 'basis', true),
        currency: 'USD', observed_at: new Date().toISOString(), effective_at: null, effective_date: null, source_ref: `positions/row-${index + 1}`,
      })) };
    },
    async openLots(security, signal) {
      const row = [...requireRoot().querySelectorAll('[data-position]')].find((item) => item.dataset.symbol === security.symbol);
      if (!row) throw new CollectionError('POSITION_CHANGED', 'Selected security is no longer displayed.');
      row.querySelector('[data-open-menu]').click();
      row.querySelector('[data-open-lots]').click();
      const node = await wait(() => {
        const current = panel();
        return current?.dataset.symbol === security.symbol && current.dataset.ready === 'true' && current;
      }, signal);
      return { row_count: Number(node.dataset.rowCount), reported_totals: {
        quantity: value(node.querySelector('[data-totals]'), 'quantity', true),
        total_basis: value(node.querySelector('[data-totals]'), 'basis', true),
      }, effective_at: null, effective_date: null, zero_position_confirmed: node.dataset.zero === 'true' };
    },
    async readPage(security) {
      const node = panel();
      if (!node || node.dataset.symbol !== security.symbol) throw new CollectionError('WRONG_PANEL', 'Lot panel does not match the selected security.', true);
      const issues = [];
      const lots = [...node.querySelectorAll('[data-lot]')].map((row) => {
        const rawDate = row.querySelector('[data-field="date"]').textContent.trim();
        const acquisition = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
        if (!acquisition && !['--', 'Unknown', ''].includes(rawDate)) issues.push(issue('UNPARSED_DATE', 'Acquisition date needs review.', row.dataset.rowRef));
        return { row_ref: row.dataset.rowRef, broker_lot_id: null, acquisition_date: acquisition,
          ...(acquisition === null && rawDate ? { raw_acquisition_date: rawDate } : {}),
          quantity: value(row, 'quantity'), total_basis: value(row, 'basis', true), cost_per_share: value(row, 'cost', true),
          broker_holding_period: row.querySelector('[data-field="term"]').textContent.trim() || null, currency: 'USD' };
      });
      return { token: node.dataset.page, last: node.dataset.last === 'true', lots, issues };
    },
    async nextPage(signal) {
      const old = panel().dataset.page;
      panel().querySelector('[data-next]').click();
      await wait(() => panel()?.dataset.ready === 'true' && panel().dataset.page !== old, signal);
    },
    async closeLots() {
      panel()?.querySelector('[data-close]').click();
      if (panel()) throw new CollectionError('CLOSE_FAILED', 'Lot panel did not close.', true);
    },
  };
  return adapter;
}

import { CollectionError } from '../src/collector.mjs';

export const time = '2026-09-06T10:00:00Z';
export function position(symbol = 'DEMO') {
  return { security: { symbol }, quantity: '2.5', total_basis: '250.00', currency: 'USD',
    observed_at: time, effective_at: null, effective_date: null, source_ref: `positions/${symbol}` };
}
export function lot(row = '1', quantity = '1') {
  return { row_ref: `lots/${row}`, broker_lot_id: null, acquisition_date: '2025-01-10',
    quantity, total_basis: quantity === '1' ? '100.00' : '150.00', cost_per_share: '100.00', broker_holding_period: 'Long Term', currency: 'USD' };
}
export function fakeAdapter({ fail = null, repeat = false, contextChange = false, unknown = false, complete = true, onRead = () => {} } = {}) {
  const calls = [];
  let page = 0; let opened = null; let changed = false;
  const adapter = {
    broker: 'synthetic-demo', calls,
    async account() { return { context: 'a', account_ref: 'a', display_label: 'Synthetic account', masked_identifier: '...123', account_type: 'unknown' }; },
    async assertContext() { if (changed) throw new CollectionError('ACCOUNT_CHANGED', 'Account changed.', true); },
    async positions() { return { complete, positions: [position('ONE'), position('TWO')] }; },
    async openLots(security) {
      opened = security.symbol; page = 0; calls.push(`open:${opened}`);
      if (fail === opened) throw new CollectionError('TIMEOUT', 'Panel timed out.');
      return { row_count: 2, reported_totals: { quantity: '2.5', total_basis: '250.00' }, effective_at: null, effective_date: null };
    },
    async readPage() {
      calls.push(`read:${opened}:${page}`); onRead(opened, page);
      if (contextChange) changed = true;
      const row = lot(`${opened}/${page}`, page === 0 ? '1' : '1.5');
      if (unknown) { row.total_basis = null; row.acquisition_date = null; }
      return { token: repeat ? '0' : String(page), last: !repeat && page === 1, lots: [row] };
    },
    async nextPage() { calls.push(`next:${opened}`); page++; },
    async closeLots() { calls.push(`close:${opened}`); opened = null; },
  };
  return adapter;
}
export const options = { now: () => time, id: () => 'synthetic-test-run' };

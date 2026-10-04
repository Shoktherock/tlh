import { CollectionError } from '../collector.mjs';
import { issue, securityKey } from '../contract.mjs';
import { schwabDate, schwabDecimal } from '../schwab-values.mjs';
import { sumDecimals, equalDecimals } from '../decimal.mjs';

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim() ?? '';
const visible = (node) => node && node.getClientRects().length > 0 && node.ownerDocument.defaultView.getComputedStyle(node).visibility !== 'hidden';
const fail = (code, message, fatal = false) => { throw new CollectionError(code, message, fatal); };
const decimal = (raw, unknown = false) => {
  try { return schwabDecimal(raw, unknown); }
  catch { fail('INVALID_NUMBER', 'An unsupported quantity or basis value needs review.'); }
};

// Selectors observed on the signed-in Positions page. No internal APIs or account storage.
export function createSchwabAdapter(doc = document, { timeout = 12000, settle = 400, broker = 'schwab', maxPositions = 2000 } = {}) {
  const references = new Map();
  let active = null;
  let discovery = { context: null, issues: [] };
  const accountState = () => {
    const selector = doc.getElementById('account-selector');
    const table = doc.getElementById('positionsDetails');
    if (!visible(selector) || !table) fail('SESSION_EXPIRED', 'Open the signed-in Schwab Positions page.', true);
    const bodies = [...table.querySelectorAll('tbody[id^="holdingsAccount_"]')];
    if (bodies.length !== 1 || !/Account ending in/i.test(selector.getAttribute('aria-label') ?? text(selector))) {
      fail('UNSUPPORTED_ACCOUNT_VIEW', 'Select one account in Schwab before opening the helper.', true);
    }
    if (doc.getElementById('grouped-by-security-type-checkbox-id')?.checked || doc.getElementById('condensed-table-view-checkbox-id')?.checked) {
      fail('UNSUPPORTED_VIEW', 'This pilot requires the ungrouped, expanded Positions table.', true);
    }
    const label = selector.getAttribute('aria-label') || text(selector);
    return { table, body: bodies[0], label, context: `${bodies[0].id}|${label}` };
  };
  const assert = (context) => {
    if (accountState().context !== context) fail('ACCOUNT_CHANGED', 'Account changed. Clear and review the selection again.', true);
  };
  const wait = async (predicate, signal, context) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (signal?.aborted) fail('CANCELLED', 'Collection cancelled by the user.', true);
      if (context) assert(context);
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fail('TIMEOUT', 'Lot details did not finish loading. Retry this security.');
  };
  const dialog = () => [...doc.querySelectorAll('#open-lot-overlay-modal-title')]
    .map((heading) => heading.closest('[role="dialog"]')).find(visible);
  const rows = (state) => [...state.body.querySelectorAll('tr.parent-position-row')];
  const symbol = (row) => text(row.querySelector('a.symbol-height'));
  const menuButton = (row) => row.querySelector('button[aria-label="Open Menu"]');
  const position = (row, table) => {
    const headers = [...table.querySelectorAll('thead th')];
    const field = (id) => {
      const index = headers.findIndex((header) => header.id === id);
      if (index < 0 || !row.cells[index]) fail('TABLE_CHANGED', 'Required Positions columns are missing.');
      return text(row.cells[index]);
    };
    return { security: { symbol: symbol(row) }, quantity: decimal(field('quantity')),
      total_basis: decimal(field('costBasis'), true), currency: null,
      observed_at: new Date().toISOString(), effective_at: null, effective_date: null,
      source_ref: `positions/${symbol(row)}` };
  };
  const findRow = (name, context) => {
    assert(context);
    const matches = rows(accountState()).filter((row) => symbol(row) === name);
    if (matches.length !== 1) fail('POSITION_CHANGED', 'A selected security disappeared or is ambiguous. Clear and review positions.', true);
    return matches[0];
  };
  const hydrate = async (name, signal, context) => {
    const row = findRow(name, context);
    // Schwab retains symbol skeletons while loading the other cells on scroll.
    // Resolve the row and its menu again after scrolling; element IDs can change.
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    let fingerprint = null; let stableSince = 0;
    return wait(() => {
      const current = findRow(name, context);
      if (!menuButton(current)) return false;
      const data = position(current, accountState().table);
      const next = JSON.stringify([data.security, data.quantity, data.total_basis, data.currency]);
      if (next !== fingerprint) { fingerprint = next; stableSince = Date.now(); }
      return Date.now() - stableSince >= settle && current;
    }, signal, context);
  };
  const readTable = (security) => {
    const node = dialog();
    if (!node) return null;
    const heading = text(node.querySelector('#open-lot-overlay-modal-title'));
    if (!heading.startsWith(`Lot Details: ${security.symbol} - `)) fail('WRONG_PANEL', 'Lot panel does not match the selected security.', true);
    if (/Lot Details are currently unavailable/i.test(text(node))) fail('LOTS_UNAVAILABLE', 'Schwab reports that lot details are currently unavailable.');
    const table = node.querySelector('#responsiveLotTable');
    if (!table) return null;
    const header = [...table.rows].find((row) => row.querySelector('button#openDate'));
    if (!header) fail('TABLE_CHANGED', 'Lot table headers are not recognized.');
    const columns = [...header.cells].map((cell) => cell.querySelector('button')?.id);
    for (const name of ['openDate', 'quantity', 'costPerShare', 'costBasis', 'holdingPeriod']) {
      if (columns.filter((id) => id === name).length !== 1) fail('TABLE_CHANGED', 'Required lot columns are missing or ambiguous.');
    }
    // Expand actual colspans so totals never shift silently into the wrong column.
    const cells = (row) => [...row.cells].flatMap((cell) => [text(cell), ...Array(cell.colSpan - 1).fill('')]);
    const bodyRows = [...table.rows].slice([...table.rows].indexOf(header) + 1);
    const totals = bodyRows.filter((row) => text(row.cells[0]) === 'Total');
    if (totals.length !== 1 || bodyRows.at(-1) !== totals[0]) return null;
    const totalCells = cells(totals[0]);
    const field = (values, id) => values[columns.indexOf(id)];
    if (totalCells.length !== columns.length) fail('TABLE_CHANGED', 'The lot total layout is not recognized.');
    const reported = { quantity: decimal(field(totalCells, 'quantity')), total_basis: decimal(field(totalCells, 'costBasis'), true) };
    const findings = [];
    const lots = bodyRows.slice(0, -1).map((row, index) => {
      const values = cells(row);
      if (values.length !== columns.length || [...row.cells].some((cell) => cell.colSpan !== 1)) fail('TABLE_CHANGED', 'A lot row is incomplete or uses an unsupported layout.');
      const raw = field(values, 'openDate');
      const date = schwabDate(raw);
      const row_ref = `lots/${security.symbol}/row-${index + 1}`;
      if (!date.value && !date.unknown) findings.push(issue('UNPARSED_DATE', 'Acquisition date needs review.', row_ref));
      const quantity = decimal(field(values, 'quantity'));
      if (equalDecimals(quantity, '0')) fail('INVALID_QUANTITY', 'Zero-quantity lot rows need review.');
      return { row_ref, broker_lot_id: null, acquisition_date: date.value,
        ...(!date.value && raw ? { raw_acquisition_date: raw } : {}), quantity,
        total_basis: decimal(field(values, 'costBasis'), true), cost_per_share: decimal(field(values, 'costPerShare'), true),
        broker_holding_period: field(values, 'holdingPeriod') || null, currency: null };
    });
    // Positive quantities must cover the entire displayed total. A footer alone cannot
    // establish completeness when a broker renders only a window of rows.
    const complete = lots.length > 0 && equalDecimals(sumDecimals(lots.map((lot) => lot.quantity)), reported.quantity);
    return { lots, reported, findings, complete };
  };
  return {
    broker, bulkPositions: true,
    async account() {
      const state = accountState();
      if (!references.has(state.context)) references.set(state.context, `schwab-${crypto.randomUUID()}`);
      const ending = /Account ending in\s+([\d\s]+)(?:Selected|$)/i.exec(state.label)?.[1].replace(/\s/g, '');
      const masked = ending ? `...${ending.slice(-3)}` : null;
      return { context: state.context, account_ref: references.get(state.context), display_label: `Schwab account ${masked ?? '(selected)'}`,
        masked_identifier: masked, account_type: 'unknown' };
    },
    async assertContext(context) { assert(context); },
    async positions({ all = false, selected = null, signal, onProgress = () => {} } = {}) {
      const state = accountState();
      if (discovery.context !== state.context) discovery = { context: state.context, issues: [] };
      if (!all && selected === null) {
        const positions = rows(state).filter((row) => symbol(row) && menuButton(row)).map((row) => position(row, state.table));
        return { complete: false, positions, issues: discovery.issues };
      }
      if (dialog()) fail('PANEL_ALREADY_OPEN', 'Close the existing lot panel before loading positions.', true);
      const inventory = () => rows(accountState()).map(symbol).filter(Boolean);
      const initial = inventory();
      if (new Set(initial).size !== initial.length) fail('AMBIGUOUS_POSITIONS', 'Duplicate security symbols need review.', true);
      const keys = selected === null ? null : new Set(selected);
      const names = initial.filter((name) => keys === null || keys.has(securityKey({ symbol: name })));
      if (keys && names.length !== keys.size) fail('POSITION_CHANGED', 'Selected positions changed. Clear and review the list.', true);
      if (names.length > maxPositions) fail('POSITION_LIMIT', `Position limit of ${maxPositions} exceeded. Choose a smaller selection.`, true);
      const positions = [];
      const findings = all ? [] : [...discovery.issues];
      for (const [index, name] of names.entries()) {
        onProgress({ kind: 'positions', index: index + 1, total: names.length, symbol: name });
        try {
          const row = await hydrate(name, signal, state.context);
          positions.push(position(row, accountState().table));
        } catch (error) {
          if (!(error instanceof CollectionError) || error.fatal || !all) throw error;
          findings.push(issue('POSITION_UNAVAILABLE', `${name}: position details could not be loaded; excluded from selection.`, `positions/${name}`, 'error'));
        }
      }
      assert(state.context);
      if (JSON.stringify(initial.slice().sort()) !== JSON.stringify(inventory().sort())) {
        fail('POSITION_CHANGED', 'Positions changed while loading. Clear and load the list again.', true);
      }
      if (all) {
        findings.push(issue('PARTIAL_ACCOUNT_COVERAGE', 'Loaded symbol rows in the current account view. Filters, cash, and unsupported non-symbol rows have not been reconciled to a full account export.', 'positions'));
        discovery = { context: state.context, issues: findings };
      }
      return { complete: false, positions, issues: findings };
    },
    async openLots(security, signal) {
      if (dialog()) fail('PANEL_ALREADY_OPEN', 'Close the existing lot panel before collecting.', true);
      const state = accountState();
      const row = await hydrate(security.symbol, signal, state.context);
      active = { security, context: state.context, menu: menuButton(row), ownsDialog: false };
      active.menu.click();
      const action = await wait(() => {
        const actions = [...doc.querySelectorAll('#sdps-menu [role="menuitem"]')].filter((item) => visible(item) && text(item) === 'Lot Details');
        if (actions.length > 1) fail('AMBIGUOUS_MENU', 'More than one Lot Details action is visible.', true);
        return actions[0];
      }, signal, state.context);
      assert(state.context);
      active.ownsDialog = true;
      action.click();
      let fingerprint = null; let stableSince = 0;
      const data = await wait(() => {
        const data = readTable(security);
        if (!data) return false;
        const next = JSON.stringify(data);
        if (next !== fingerprint) { fingerprint = next; stableSince = Date.now(); }
        return Date.now() - stableSince >= settle && data;
      }, signal, state.context);
      active.fingerprint = JSON.stringify(data);
      return { row_count: data.lots.length, reported_totals: data.reported, effective_at: null, effective_date: null,
        traversal: 'Read a stable rendered lot table through its Total row; positive lot quantities cover the displayed total.' };
    },
    async readPage(security) {
      const data = readTable(security);
      if (!data || JSON.stringify(data) !== active?.fingerprint) fail('TABLE_CHANGED', 'Lot rows changed during capture. Retry this security.');
      return { token: 'rendered-table', lots: data.lots, issues: data.findings, last: data.complete };
    },
    async nextPage() { fail('INCOMPLETE_TABLE', 'Rendered lot quantities do not cover the Total row. Pagination or scrolling needs a later adapter; this scope is partial.'); },
    async closeLots() {
      if (!active) return;
      assert(active.context);
      if (active.ownsDialog) {
        const node = dialog();
        if (node) {
          if (!text(node.querySelector('#open-lot-overlay-modal-title')).startsWith(`Lot Details: ${active.security.symbol} - `)) fail('WRONG_PANEL', 'The open panel changed; close it manually.', true);
          const close = node.querySelector('button[aria-label="Close"]');
          if (!close) fail('CLOSE_FAILED', 'Lot panel close control is missing.', true);
          close.click();
        }
        await wait(() => !dialog(), null, active.context);
      } else if (active.menu.isConnected && active.menu.getAttribute('aria-expanded') === 'true') active.menu.click();
      active = null;
    },
  };
}

import {ReviewError} from '../review-error.mjs';
import { csvRows } from './csv.mjs';
import {validateManual,parseManualCsv,manualEvidence} from './manual.mjs';
import { validateSnapshot } from '../../../browser-helper/src/contract.mjs';
import { parseSchwabLotReference } from '../../../browser-helper/src/verify-schwab-csv.mjs';
import { parseDecimal, sumDecimals, equalDecimals } from '../../../browser-helper/src/decimal.mjs';

export const hash = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
// Strict UTF-8, retaining a BOM so re-encoding preserves the original file bytes.
export const decodeSourceBytes = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const num = (value, unknown = false) => parseDecimal(value, { allowUnknown: unknown });
const issue = (code, message) => ({ code, message });

// Preserve Eastern Time as source text. A date is supported without inventing a UTC
// offset for ambiguous daylight-saving clock times.
function sourceDate(title) {
  const match = /\b(\d{4})[/-](\d{2})[/-](\d{2})\b/.exec(title);
  const us = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(title);
  if (!match && !us) return null;
  const iso = match ? `${match[1]}-${match[2]}-${match[3]}` : `${us[3]}-${us[1]}-${us[2]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== iso) throw new ReviewError('Invalid source calendar date.');
  return iso;
}

export function parsePositions(text) {
  const rows = csvRows(text);
  if (!/^Positions for account .+ as of .+$/.test(rows[0]?.[0] ?? '') || rows[0].length !== 1) throw new ReviewError('Unrecognized Schwab Positions title.');
  const headers = rows[1];
  if (!headers || new Set(headers).size !== headers.length) throw new ReviewError('Missing or duplicate Positions columns.');
  const required = ['Symbol', 'Description', 'Qty (Quantity)', 'Cost Basis', 'Mkt Val (Market Value)', 'Asset Type'];
  if (required.some(h => !headers.includes(h))) throw new ReviewError('Required Positions columns are missing.');
  const date = sourceDate(rows[0][0]);
  const positions = []; let cash = null; let totals = null;
  const issues = [];
  for (let i = 2; i < rows.length; i++) {
    if (rows[i].length !== headers.length || (headers.at(-1) === '' && rows[i].at(-1) !== '')) throw new ReviewError(`Positions row ${i + 1} has unexpected columns.`);
    const r = Object.fromEntries(headers.map((h, j) => [h, rows[i][j].trim()]));
    if (r.Symbol === 'Positions Total') {
      if (totals || i !== rows.length - 1) throw new ReviewError('Positions must end with exactly one Total row.');
      totals = { total_basis: num(r['Cost Basis'], true), market_value: num(r['Mkt Val (Market Value)'], true) }; continue;
    }
    if (r.Symbol === 'Cash & Cash Investments') {
      if (cash) throw new ReviewError('Duplicate cash row.');
      cash = { amount: num(r['Mkt Val (Market Value)'], true), currency: null, effective_date: date, source_ref: `row-${i + 1}` }; continue;
    }
    if (!r.Symbol) throw new ReviewError(`Missing security on Positions row ${i + 1}.`);
    positions.push({ security: { symbol: r.Symbol }, description: r.Description, asset_type: r['Asset Type'],
      quantity: num(r['Qty (Quantity)']), total_basis: num(r['Cost Basis'], true), currency: null,
      effective_at: null, effective_date: date, observed_at: null, source_ref: `row-${i + 1}` });
  }
  if (!totals) throw new ReviewError('Positions CSV has no final Total row.');
  if (new Set(positions.map(p => p.security.symbol)).size !== positions.length) throw new ReviewError('Duplicate Positions symbols require separate account files.');
  const basis = sumDecimals(positions.map(p => p.total_basis));
  if (basis !== null && totals.total_basis !== null && !equalDecimals(basis, totals.total_basis)) issues.push(issue('CSV_BASIS_TOTAL', 'Positions rows do not add up to the CSV total basis.'));
  return { label: rows[0][0], date, positions, cash, totals, issues };
}

export async function readSource(file) {
  if (!file.text.trim() || file.text.length > 25 * 1024 * 1024) throw new ReviewError('Choose a nonempty file below 25 MB.');
  const common = { id: await hash(file.text), name: file.name, text: file.text };
  const text = file.text.replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('{')) {
    let data;
    try { data = JSON.parse(text); } catch { throw new ReviewError('Invalid JSON.'); }
    if(data.format==='tlh-manual-evidence')return {...common,kind:'manual',data:validateManual(data)};
    const result = validateSnapshot(data);
    if (!result.valid) throw new ReviewError(`Snapshot validation failed: ${result.errors.slice(0, 4).join('; ')}`);
    if (data.broker !== 'schwab') throw new ReviewError('This import milestone supports Schwab source files.');
    return { ...common, kind: 'snapshot', data };
  }
  const title = csvRows(text)[0]?.[0] ?? '';
  if(title==='TLH Manual Evidence')return {...common,kind:'manual',data:parseManualCsv(text)};
  if (title.startsWith('Positions for account ')) return { ...common, kind: 'positions', data: parsePositions(text) };
  if (title.includes(' Lot Details for ')) {
    const data = parseSchwabLotReference(text);
    data.date = sourceDate(data.as_of_text);
    data.label = title;
    return { ...common, kind: 'lots', data };
  }
  throw new ReviewError('Unsupported file. Choose helper JSON, Schwab Positions CSV, Lot Details CSV, or the TLH manual evidence template.');
}

export function assemble(sources, sourceAccountRef) {
  if (!sources.length) throw new ReviewError('Choose at least one source file.');
  if(sources.some(s=>s.kind==='manual')){
    if(sources.length!==1)throw new ReviewError('Review one manual evidence file at a time, separately from brokerage exports.');
    return manualEvidence(validateManual(sources[0].data),sources[0].id);
  }
  const snapshots = sources.filter(s => s.kind === 'snapshot');
  const csvs = sources.filter(s => s.kind === 'positions');
  if (snapshots.length > 1 || csvs.length > 1) throw new ReviewError('Stage one snapshot and one Positions CSV at a time to make source precedence explicit.');
  const positions = new Map(); const scopes = new Map(); const issues = []; const labels = [];
  const put = (p, source) => {
    const symbol = p.security.symbol;
    const previous = positions.get(symbol);
    if (previous && JSON.stringify(previous.security) !== JSON.stringify(p.security)) throw new ReviewError(`${symbol}: ambiguous security identifiers across files.`);
    if (previous) {
      for (const field of ['quantity', 'total_basis']) if (previous[field] !== null && p[field] !== null && !equalDecimals(previous[field], p[field])) {
        issues.push({ ...issue('SOURCE_CONFLICT', `${symbol}: ${field.replace('_', ' ')} differs between source files.`), symbol });
      }
    }
    positions.set(symbol, { ...p, source_id: source.id });
  };
  if (snapshots.length) {
    const source = snapshots[0];
    const account = source.data.accounts.find(a => a.account_ref === sourceAccountRef);
    if (!account) throw new ReviewError('Select the source account from the snapshot.');
    labels.push(account.display_label); issues.push(...account.issues);
    account.positions.forEach(p => put(p, source));
    account.lot_scopes.forEach(scope => scopes.set(scope.security.symbol, { ...scope, source_id: source.id }));
    if ([...scopes.keys()].some(symbol => !positions.has(symbol))) throw new ReviewError('Snapshot contains lot scopes without a matching position observation.');
  }
  // Declared product rule: when supplied, the CSV is the position-total source;
  // the helper remains the lot source. Conflicts require explicit unresolved review.
  for (const source of csvs) {
    labels.push(source.data.label); issues.push(...source.data.issues);
    source.data.positions.forEach(p => put(p, source));
  }
  for (const source of sources.filter(s => s.kind === 'lots')) {
    const data = source.data;
    if (scopes.has(data.symbol)) {
      const previous = sources.find(s => s.id === scopes.get(data.symbol).source_id);
      throw new ReviewError(`${data.symbol}: lot details overlap between "${previous.name}" and "${source.name}". Remove one overlapping lot source from this batch, then build the preview again. A Positions CSV supplies position totals and can stay alongside your chosen lot source.`);
    }
    labels.push(data.label);
    const timing = { effective_at: null, effective_date: data.date, observed_at: null };
    const scope = { security: { symbol: data.symbol }, status: 'complete', ...timing, source_id: source.id,
      source_ref: 'lot-table', reported_totals: data.reported_totals,
      lots: data.lots.map((lot, i) => ({ ...lot, row_ref: `row-${i + 1}`, broker_lot_id: null, currency: null })),
      issues: data.issues.map(i => issue(i.code, `Lot source reports ${i.code.toLowerCase().replaceAll('_', ' ')}.`)) };
    scopes.set(data.symbol, scope);
    if (!positions.has(data.symbol)) put({ security: scope.security, ...timing, currency: null, ...data.reported_totals, source_ref: 'reported-lot-total' }, source);
  }
  return { positions: [...positions.values()], scopes: [...scopes.values()], issues, labels,
    cash: csvs[0]?.data.cash ? { ...csvs[0].data.cash, source_id: csvs[0].id } : null,
    csvSymbols: csvs[0]?.data.positions.map(p => p.security.symbol) ?? null,
    csvDate: csvs[0]?.data.date ?? null };
}

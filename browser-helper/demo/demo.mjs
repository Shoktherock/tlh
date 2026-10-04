import { mountHelper } from '../src/panel.mjs';
import { createDemoAdapter } from '../src/adapters/demo.mjs';

const datasets = {
  MSFT: { quantity: '10', basis: '1000.00', lots: [
    ['2025-01-10', '4', '100.00', '400.00', 'Long Term'], ['2026-05-04', '6', '100.00', '600.00', 'Short Term'],
  ] },
  VTI: { quantity: '3.5', basis: '350.00', lots: [
    ['2025-02-01', '1', '100.00', '100.00', 'Long Term'],
    ['2025-02-01', '1', '100.00', '100.00', 'Long Term'],
    ['2026-06-01', '1.5', '100.00', '150.00', 'Short Term'],
  ] },
  AAPL: { quantity: '2', basis: '180.00', lots: [['2026-07-01', '2', '90.00', '180.00', 'Short Term']] },
};
const root = document.querySelector('[data-tlh-demo]');
const panel = document.querySelector('[data-lot-panel]');
const scenario = document.querySelector('#scenario');
let current = null;
let page = 0;
let generation = 0;
function log(message) {
  const li = document.createElement('li'); li.textContent = message;
  document.querySelector('#activity').prepend(li);
}
function cell(field, value) {
  const td = document.createElement('td'); td.dataset.field = field; td.textContent = value; return td;
}
function renderPage() {
  const data = datasets[current];
  panel.dataset.ready = 'true'; panel.dataset.page = String(page);
  panel.dataset.last = String((page + 1) * 2 >= data.lots.length);
  panel.dataset.rowCount = String(data.lots.length);
  document.querySelector('#lot-title').textContent = `${current} · Lot details`;
  document.querySelector('#page-info').textContent = `Page ${page + 1} of ${Math.ceil(data.lots.length / 2)} · ${data.lots.length} total rows`;
  const body = document.querySelector('#lot-rows'); body.replaceChildren();
  data.lots.slice(page * 2, page * 2 + 2).forEach((values, i) => {
    const display = [...values];
    if (current === 'VTI' && scenario.value === 'unknown' && page === 0 && i === 0) { display[0] = '--'; display[3] = '--'; }
    if (current === 'VTI' && scenario.value === 'mismatch' && page === 0 && i === 0) display[1] = '0.5';
    const row = document.createElement('tr'); row.dataset.lot = ''; row.dataset.rowRef = `lots/${current}/row-${page * 2 + i + 1}`;
    ['date', 'quantity', 'cost', 'basis', 'term'].forEach((field, index) => row.append(cell(field, display[index])));
    body.append(row);
  });
  const totals = document.querySelector('[data-totals]'); totals.replaceChildren();
  for (const [field, value] of [['quantity', data.quantity], ['basis', data.basis]]) {
    const span = document.createElement('span'); span.dataset.field = field; span.dataset.label = field; span.textContent = value; totals.append(span);
  }
  panel.querySelector('[data-next]').disabled = panel.dataset.last === 'true';
  log(`${current}: lot page ${page + 1} displayed`);
}
function open(symbol) {
  current = symbol; page = 0; generation++; panel.hidden = false;
  panel.dataset.symbol = symbol; panel.dataset.ready = 'false';
  log(`${symbol}: Lot Details clicked`);
  if (scenario.value === 'failure' && symbol === 'VTI') { document.querySelector('#lot-rows').replaceChildren(); return; }
  renderPage();
}
for (const [symbol, data] of Object.entries(datasets)) {
  const row = document.createElement('tr'); row.dataset.position = ''; row.dataset.symbol = symbol;
  row.append(cell('symbol', symbol), cell('quantity', data.quantity), cell('basis', data.basis));
  const actions = document.createElement('td');
  const menu = document.createElement('button'); menu.dataset.openMenu = ''; menu.textContent = `${symbol} menu`;
  const lots = document.createElement('button'); lots.dataset.openLots = ''; lots.textContent = 'Lot Details'; lots.hidden = true;
  menu.onclick = () => { lots.hidden = !lots.hidden; log(`${symbol}: menu clicked`); };
  lots.onclick = () => { lots.hidden = true; open(symbol); };
  actions.append(menu, lots); row.append(actions); document.querySelector('#positions').append(row);
}
panel.querySelector('[data-close]').onclick = () => { log(`${current}: lot panel closed`); generation++; panel.hidden = true; };
panel.querySelector('[data-next]').onclick = () => {
  log(`${current}: Next page clicked`);
  if (scenario.value === 'pagination' && current === 'VTI') return;
  const token = generation; panel.dataset.ready = 'false';
  setTimeout(() => { if (token === generation) { page++; renderPage(); } }, 100);
};
scenario.onchange = () => { root.dataset.coverage = scenario.value === 'partial' ? 'partial' : 'complete'; log(`Scenario: ${scenario.selectedOptions[0].textContent}`); };
document.querySelector('#expire').onclick = () => { root.dataset.session = 'expired'; log('Session expired'); };
document.querySelector('#restore').onclick = () => { root.dataset.session = 'active'; log('Session restored'); };
document.querySelector('#switch').onclick = () => { root.dataset.account = root.dataset.account === 'demo-account-1' ? 'demo-account-2' : 'demo-account-1'; log(`Account switched to ${root.dataset.account}`); };
if (!new URLSearchParams(location.search).has('extension')) mountHelper(createDemoAdapter());

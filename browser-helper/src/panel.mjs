import { collect } from './collector.mjs';
import { securityKey, serializeSnapshot, validateSnapshot } from './contract.mjs';

export function mountHelper(adapter, { maxSecurities = Infinity, phase = '1', selectByDefault = true,
  guidance = 'Synthetic data only. Files stay local. Schwab support follows in Phase 2.' } = {}) {
  const existing = document.querySelector('#tlh-helper');
  if (existing) { existing.hidden = false; return; }
  const host = document.createElement('aside'); host.id = 'tlh-helper';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{position:fixed;right:22px;top:22px;width:374px;max-height:calc(100vh - 44px);z-index:2147483647;color:#21352e;font:14px/1.5 system-ui,sans-serif}
    *{box-sizing:border-box}.shell{border:1px solid #cbd7c6;border-radius:18px;background:#fffef9;box-shadow:0 14px 50px #203f2020;overflow:auto;max-height:calc(100vh - 44px);padding:24px}
    .eyebrow{font-size:10px;letter-spacing:.13em;color:#6b7b66;font-weight:750}h2{font-size:25px;line-height:1.15;letter-spacing:-.035em;margin:10px 0}p{font-size:12px;color:#657362;margin:8px 0 16px}button{font:inherit;font-weight:650;padding:10px 14px;border-radius:8px;border:1px solid #ced8c7;background:#f5f7f0;color:#264330;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid #7ba26d;outline-offset:2px}.primary{background:#294d37;color:white;border-color:#294d37;width:100%;margin-top:14px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}label{display:flex;align-items:center;gap:10px;border-bottom:1px solid #e7eadf;padding:10px 0;font-size:13px}input{accent-color:#345c3b}label span{margin-left:auto;color:#6b7967;font-size:11px}.status{border-radius:8px;background:#eef2e6;padding:12px;font-size:12px;white-space:pre-wrap;margin:14px 0}.result{padding:12px 0;border-bottom:1px solid #e3e8da;font-size:12px}.result strong{font-size:13px}.result small{display:block;color:#687660;margin-top:3px}.bad{color:#9b4b24}.footer{margin:16px 0 0;font-size:11px}details{margin-top:14px}summary{cursor:pointer;font-size:12px}pre{font-size:10px;max-height:160px;overflow:auto;background:#eef2e6;padding:10px}#export{width:100%;margin-top:14px}.heading{display:flex;justify-content:space-between;gap:10px}.heading button{padding:4px 8px;font-size:11px;height:30px}@media(max-width:760px){:host{top:auto;bottom:12px;left:12px;right:12px;width:auto;max-height:54vh}.shell{max-height:54vh}}
    :host([hidden]){display:none!important}
  </style><div class="shell"><div class="heading"><div class="eyebrow">BROWSER HELPER · PHASE 1</div><button id="discard">Clear</button><button id="close" aria-label="Close helper" title="Close helper; stop collection and keep results for reopening">×</button></div>
    <h2>Collect your lots.</h2><p id="account">Reading the selected account…</p><div id="selection" style="max-height:230px;overflow:auto"></div>
    <div class="actions"><button id="load-all" hidden>Load all positions</button><button id="select-all">Select all</button><button id="select-none">Select none</button></div><p id="coverage"></p>
    <button class="primary" id="collect" disabled>Collect lots</button><div class="actions"><button id="cancel" disabled>Cancel</button><button id="retry" disabled>Retry incomplete</button></div>
    <div class="status" id="status" role="status" aria-live="polite">Choose positions, then start collection.</div>
    <div id="results"></div><button id="export" disabled>Download snapshot JSON</button>
    <details><summary>Inspect snapshot</summary><pre id="preview">No snapshot collected yet.</pre></details>
    <p class="footer">Synthetic data only. Files stay local. Schwab support follows in Phase 2.</p></div>`;
  document.body.append(host);
  const $ = (selector) => shadow.querySelector(selector);
  $('.eyebrow').textContent = `BROWSER HELPER · PHASE ${phase}`;
  $('.footer').textContent = guidance;
  $('#load-all').hidden = !adapter.bulkPositions;
  let snapshot = null;
  let controller = null;
  let running = false;
  let selection = [];
  let reviewedContext;
  const setStatus = (message) => { $('#status').textContent = message; };
  const renderScope = (scope) => {
    const item = document.createElement('div'); item.className = 'result';
    const heading = document.createElement('strong'); heading.textContent = `${scope.security.symbol} · ${scope.status}`;
    if (scope.status !== 'complete') heading.className = 'bad';
    const details = document.createElement('small'); details.textContent = `${scope.lots.length} rows · ${scope.completeness_evidence.pages_visited ?? 0} pages`;
    item.append(heading, details);
    for (const finding of scope.issues) { const note = document.createElement('small'); note.textContent = finding.message; item.append(note); }
    $('#results').append(item);
  };
  const lock = (busy) => {
    const checked = shadow.querySelectorAll('input:checked').length;
    running = busy; $('#collect').disabled = busy || !selection.length || !checked || checked > maxSecurities; $('#cancel').disabled = !busy; $('#discard').disabled = busy;
    for (const id of ['load-all', 'select-all', 'select-none']) $(`#${id}`).disabled = busy;
    shadow.querySelectorAll('input').forEach((input) => { input.disabled = busy; });
    $('#export').disabled = busy || !snapshot || !validateSnapshot(snapshot).valid;
    $('#retry').disabled = busy || !snapshot || !snapshot.accounts[0].lot_scopes.some((scope) => scope.status !== 'complete');
  };
  async function refreshSelection(all = false) {
    controller = new AbortController(); lock(true);
    try {
      const account = await adapter.account();
      const { positions, issues = [] } = await adapter.positions({ all, signal: controller.signal, onProgress: progress });
      await adapter.assertContext(account.context);
      reviewedContext = account.context;
      selection = positions;
      $('#account').textContent = account.display_label;
      $('#selection').replaceChildren();
      $('#coverage').textContent = `${positions.length} positions available. ${issues.map((i) => i.message).join(' ')}`;
      positions.forEach((position) => {
        const label = document.createElement('label'); const input = document.createElement('input');
        input.type = 'checkbox'; input.checked = selectByDefault; input.value = securityKey(position.security); input.setAttribute('aria-label', position.security.symbol);
        input.onchange = () => { lock(false); if (Number.isFinite(maxSecurities)) setStatus(`Choose 1–${maxSecurities} securities, then start collection.`); };
        const name = document.createTextNode(position.security.symbol); const shares = document.createElement('span'); shares.textContent = `${position.quantity} shares`;
        label.append(input, name, shares); $('#selection').append(label);
      });
      if (Number.isFinite(maxSecurities)) setStatus(`Choose 1–${maxSecurities} loaded securities. The helper opens each lot panel automatically. Clear refreshes the list.`);
      else setStatus('Choose positions or Select all, then Collect lots. Account coverage remains partial until independently verified.');
    } catch (error) { selection = []; reviewedContext = undefined; $('#selection').replaceChildren(); setStatus(error.message); }
    controller = null;
    lock(false);
  }
  function progress(event) {
    if (event.kind === 'positions') setStatus(`Loading positions: ${event.index} of ${event.total} · ${event.symbol}…`);
    if (event.kind === 'opening') setStatus(`Opening ${event.security.symbol} lot details…`);
    if (event.kind === 'page') setStatus(`${event.security.symbol}: collected ${event.rows} rows across ${event.page} page(s)…`);
    if (event.kind === 'scope') renderScope(event.scope);
  }
  async function run(retry = false) {
    if (running) return;
    controller = new AbortController(); lock(true); $('#results').replaceChildren();
    const prior = retry ? snapshot : null;
    snapshot = null; $('#preview').textContent = 'Collecting…';
    try {
      const selected = prior ? prior.accounts[0].positions.map((p) => securityKey(p.security)) : [...shadow.querySelectorAll('input:checked')].map((input) => input.value);
      snapshot = await collect(adapter, { selected, previous: prior, signal: controller.signal,
        expectedContext: reviewedContext, maxSecurities, onProgress: progress });
      const check = validateSnapshot(snapshot);
      const account = snapshot.accounts[0]; const complete = account.lot_scopes.filter((s) => s.status === 'complete').length;
      setStatus(check.valid ? `${complete} of ${account.lot_scopes.length} securities complete.\nPositions coverage: ${account.positions_coverage}. Review issues before exporting.` : `Export blocked: ${check.errors.join('; ')}`);
      $('#preview').textContent = JSON.stringify(snapshot, null, 2);
    } catch (error) {
      snapshot = prior;
      $('#preview').textContent = prior ? JSON.stringify(prior, null, 2) : 'No snapshot collected.';
      if (prior) { $('#results').replaceChildren(); prior.accounts[0].lot_scopes.forEach(renderScope); }
      setStatus(error.message);
    } finally { controller = null; lock(false); }
  }
  $('#collect').onclick = () => run();
  $('#retry').onclick = () => run(true);
  $('#cancel').onclick = () => controller?.abort();
  $('#close').onclick = () => { controller?.abort(); host.hidden = true; };
  $('#load-all').onclick = () => { if (!running) refreshSelection(true); };
  for (const [id, checked] of [['select-all', true], ['select-none', false]]) {
    $(`#${id}`).onclick = () => { shadow.querySelectorAll('input').forEach((input) => { input.checked = checked; }); lock(false); };
  }
  $('#discard').onclick = () => { snapshot = null; $('#results').replaceChildren(); $('#preview').textContent = 'No snapshot collected yet.'; setStatus('Results cleared. Choose positions to collect.'); refreshSelection(); };
  $('#export').onclick = () => {
    try {
      const data = serializeSnapshot(snapshot);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `tlh-pilot-${snapshot.snapshot_id}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Results remain in memory for review/re-download; Clear or a page refresh discards them.
      setStatus('Snapshot download requested. Use Clear to discard the in-memory results.');
    } catch (error) { setStatus(error.message); }
  };
  refreshSelection();
}

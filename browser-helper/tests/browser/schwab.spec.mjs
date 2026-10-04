import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { validateSnapshot } from '../../src/contract.mjs';

// Synthetic values, observed structural selectors. Never saved brokerage HTML.
const fixture = `<!doctype html><html><body>
<button id="account-selector" aria-label="Account Selector: Test Account ending in 1 2 3 Selected">Synthetic account</button>
<input type="checkbox" id="grouped-by-security-type-checkbox-id"><input type="checkbox" id="condensed-table-view-checkbox-id">
<table id="positionsDetails"><thead><tr><th></th><th id="symbol">Symbol</th><th id="quantity">Qty</th><th id="costBasis">Basis</th></tr></thead>
<tbody id="holdingsAccount_11111123">
${['TESTA','TESTB','TESTC','TESTD'].map((s,i)=>`<tr class="parent-position-row"><th></th><th><a class="symbol-height">${s}</a><button id="menu-${i}" aria-label="Open Menu">Menu</button></th><td>${i===1?'0.75':'10'}</td><td>$100.00</td></tr>`).join('')}
<tr class="parent-position-row"><th></th><th><a class="symbol-height">UNLOADED</a></th></tr></tbody></table>
<div id="sdps-menu" hidden><div role="menuitem">Sell Shares</div><div role="menuitem">Buy Shares</div><div role="menuitem">Lot Details</div></div>
<div id="modal" role="dialog" hidden><div><h2 id="open-lot-overlay-modal-title"></h2><button aria-label="Close">Close</button></div><div id="lot-content"></div></div>
</body></html>`;
let bundle;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `import { createSchwabAdapter } from './browser-helper/src/adapters/schwab.mjs';
    import { mountHelper } from './browser-helper/src/panel.mjs';
    window.adapter = createSchwabAdapter(document, {timeout:800, settle:50, broker:'synthetic-schwab-fixture'});
    window.openTestHelper = () => mountHelper(window.adapter,{maxSecurities:window.scenario.startsWith('bulk')?Infinity:3,phase:'3',selectByDefault:false});
    window.openTestHelper();`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'iife', platform: 'browser' });
  bundle = result.outputFiles[0].text;
});
async function setup(page, scenario = 'normal') {
  await page.goto('/demo/');
  await page.setContent(fixture);
  await page.evaluate((scenario) => {
    window.activity = []; window.scenario = scenario;
    let current;
    const modal = document.querySelector('#modal');
    const menu = document.querySelector('#sdps-menu');
    const headerIds = ['openDate','quantity','price','costPerShare','marketValue','costBasis','gainLossDollar','gainLossPercent','holdingPeriod'];
    const values = (q,b,date='11/01/2022') => [date,q,'$10.00','$10.00','$100.00',b,'$0.00','0%','Long Term'];
    const row = (values) => `<tr>${values.map((v,i)=>`<${i?'td':'th'}>${v}</${i?'td':'th'}>`).join('')}</tr>`;
    const wireMenu = (button) => { button.onclick = () => {
      current = button.closest('tr').querySelector('a').textContent;
      window.activity.push(`${current}:menu`); menu.hidden = false; button.setAttribute('aria-expanded','true');
    }; };
    document.querySelectorAll('button[aria-label="Open Menu"]').forEach(wireMenu);
    if (scenario.startsWith('bulk')) {
      const table = document.querySelector('#positionsDetails');
      const viewport = document.createElement('div'); viewport.id = 'positions-scroll';
      viewport.style.cssText = 'height:320px;overflow:auto;width:600px';
      table.before(viewport); viewport.append(table);
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const row = entry.target; const name = row.querySelector('a').textContent;
          row.innerHTML = `<th></th><th><a class="symbol-height">${name}</a></th>`;
          if (entry.isIntersecting && !(window.scenario === 'bulk-stall' && name === 'UNLOADED')) {
            row.cells[1].insertAdjacentHTML('beforeend', '<button aria-label="Open Menu">Menu</button>');
            row.insertAdjacentHTML('beforeend', `<td>${name==='TESTB'?'0.75':'10'}</td><td>$100.00</td>`);
            wireMenu(row.querySelector('button'));
            if (window.scenario === 'bulk-switch' && name === 'UNLOADED') document.querySelector('#positionsDetails tbody').id = 'holdingsAccount_22222123';
          }
        }
      }, { root: viewport });
      table.querySelectorAll('.parent-position-row').forEach(row => { row.style.height='240px'; observer.observe(row); });
    }
    menu.querySelectorAll('[role="menuitem"]').forEach((item) => item.onclick = () => {
      window.activity.push(`${current}:${item.textContent}`); menu.hidden = true; modal.hidden = false;
      document.querySelector('#open-lot-overlay-modal-title').textContent = `Lot Details: ${current} - SYNTHETIC`;
      if (window.scenario === 'unavailable' && current === 'TESTA') {
        document.querySelector('#lot-content').textContent = 'Lot Details are currently unavailable. Please try again later.'; return;
      }
      let lots = current === 'TESTB' ? [values('0.25','$33.33'),values('0.25','$33.33'),values('0.25','$33.34')] : [values('10','$100.00')];
      if (window.scenario === 'partial') lots = [values('5','$50.00')];
      if (window.scenario === 'unknown') lots = [values('10','--','Unknown')];
      if (window.scenario === 'invalid') lots[0][1] = '-10';
      document.querySelector('#lot-content').innerHTML = `<table id="responsiveLotTable"><thead><tr>${headerIds.map(id=>`<th><button id="${id}">${id}</button></th>`).join('')}</tr></thead><tbody>${lots.map(row).join('')}${row(['Total',current==='TESTB'?'0.75':'10','','','$100.00','$100.00','$0.00','0%',''])}</tbody></table>`;
      if (window.scenario === 'switch') document.querySelector('#positionsDetails tbody').id = 'holdingsAccount_22222123';
      if (window.scenario === 'wrong') document.querySelector('#open-lot-overlay-modal-title').textContent = 'Lot Details: OTHER - SYNTHETIC';
    });
    modal.querySelector('button[aria-label="Close"]').onclick = () => { window.activity.push(`${current}:close`); modal.hidden = true; };
  }, scenario);
  await page.route('**/schwab-test-bundle.js', (route) => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.addScriptTag({ url: '/schwab-test-bundle.js' });
  await expect(page.locator('#tlh-helper').getByRole('checkbox', {name:'TESTA',exact:true})).toBeVisible();
}
const helper = (page) => page.locator('#tlh-helper');
async function run(page, names=['TESTA','TESTB','TESTC']) {
  for (const name of names) await helper(page).getByRole('checkbox',{name,exact:true}).check();
  await helper(page).getByRole('button',{name:'Collect lots',exact:true}).click();
  await expect(helper(page).getByRole('button',{name:'Download snapshot JSON'})).toBeEnabled();
  const result = JSON.parse(await helper(page).locator('#preview').textContent());
  expect(validateSnapshot(result).valid).toBe(true);
  return result;
}
test('Schwab structure: automatic menu/lot/close sequence, duplicate fractional lots, partial coverage and private references', async ({page}) => {
  await setup(page);
  const result = await run(page);
  expect(result.accounts[0].positions_coverage).toBe('partial');
  expect(result.accounts[0].lot_scopes.map(s=>s.lots.length)).toEqual([1,3,1]);
  expect(result.accounts[0].lot_scopes.every(s=>s.status==='complete')).toBe(true);
  expect(result.accounts[0].lot_scopes[1].lots.map(l=>l.quantity)).toEqual(['0.25','0.25','0.25']);
  expect(result.accounts[0].lot_scopes[0].lots[0].acquisition_date).toBe('2022-11-01');
  expect(JSON.stringify(result)).not.toContain('11111123');
  expect(await page.evaluate(()=>window.activity)).toEqual(['TESTA:menu','TESTA:Lot Details','TESTA:close','TESTB:menu','TESTB:Lot Details','TESTB:close','TESTC:menu','TESTC:Lot Details','TESTC:close']);
});
test('unavailable lots fail explicitly, close, continue and retry only the failed scope', async ({page}) => {
  await setup(page,'unavailable');
  const result=await run(page);
  expect(result.accounts[0].lot_scopes.map(s=>s.status)).toEqual(['failed','complete','complete']);
  expect(result.accounts[0].lot_scopes[0].issues[0].code).toBe('LOTS_UNAVAILABLE');
  await page.evaluate(()=>{window.scenario='normal';});
  await helper(page).getByRole('button',{name:'Retry incomplete'}).click();
  await expect(helper(page).locator('#status')).toContainText('3 of 3 securities complete');
  expect((await page.evaluate(()=>window.activity)).filter(a=>a==='TESTB:Lot Details')).toHaveLength(1);
});
test('partial rendered lots never become a complete scope merely because a Total footer exists',async({page})=>{
  await setup(page,'partial'); const result=await run(page,['TESTA']);
  expect(result.accounts[0].lot_scopes[0].status).toBe('partial');
  expect(result.accounts[0].lot_scopes[0].issues.map(i=>i.code)).toContain('INCOMPLETE_TABLE');
});
test('unknown date/basis/currency stay unknown and malformed quantities fail',async({page})=>{
  await setup(page,'unknown'); const result=await run(page,['TESTA']);
  expect(result.accounts[0].lot_scopes[0].lots[0]).toMatchObject({acquisition_date:null,total_basis:null,currency:null});
  await setup(page,'invalid'); const invalid=await run(page,['TESTA']);
  expect(invalid.accounts[0].lot_scopes[0].status).toBe('failed');
});
test('account change with same masked suffix stops later clicks and discards in-flight rows',async({page})=>{
  await setup(page,'switch'); const result=await run(page);
  expect(result.accounts[0].lot_scopes.map(s=>s.status)).toEqual(['failed','skipped','skipped']);
  expect(result.accounts[0].lot_scopes.every(s=>s.lots.length===0)).toBe(true);
  expect(await page.evaluate(()=>window.activity)).toEqual(['TESTA:menu','TESTA:Lot Details']);
});
test('selection limit and existing-panel guard prevent unintended navigation',async({page})=>{
  await setup(page);
  for(const name of ['TESTA','TESTB','TESTC','TESTD'])await helper(page).getByRole('checkbox',{name,exact:true}).check();
  await expect(helper(page).getByRole('button',{name:'Collect lots',exact:true})).toBeDisabled();
  await helper(page).getByRole('checkbox',{name:'TESTD',exact:true}).uncheck();
  await page.evaluate(()=>{document.querySelector('#modal').hidden=false;document.querySelector('#open-lot-overlay-modal-title').textContent='Lot Details: TESTA - SYNTHETIC';});
  await helper(page).getByRole('button',{name:'Collect lots',exact:true}).click();
  await expect(helper(page).locator('#status')).toContainText('Close the existing lot panel');
  expect(await page.evaluate(()=>window.activity)).toEqual([]);
  await expect(page.locator('#modal')).toBeVisible();
});

test('bulk loading scrolls real virtualized rows and rehydrates every selected row before clicking lots', async ({page}) => {
  await setup(page, 'bulk');
  await helper(page).getByRole('button',{name:'Load all positions'}).click();
  await expect(helper(page).locator('#coverage')).toContainText('5 positions available');
  await helper(page).getByRole('button',{name:'Select all',exact:true}).click();
  await helper(page).getByRole('button',{name:'Collect lots',exact:true}).click();
  await expect(helper(page).locator('#status')).toContainText('5 of 5 securities complete');
  const result = JSON.parse(await helper(page).locator('#preview').textContent());
  expect(validateSnapshot(result).valid).toBe(true);
  expect(result.accounts[0].positions).toHaveLength(5);
  expect(result.accounts[0].positions_coverage).toBe('partial');
  expect((await page.evaluate(()=>window.activity)).filter(s=>s.endsWith(':Lot Details'))).toEqual(['TESTA:Lot Details','TESTB:Lot Details','TESTC:Lot Details','TESTD:Lot Details','UNLOADED:Lot Details']);
  await helper(page).getByRole('button',{name:'Close helper'}).click();
  await expect(helper(page)).toBeHidden();
  await page.evaluate(()=>window.openTestHelper());
  await expect(helper(page).locator('#status')).toContainText('5 of 5 securities complete');
  expect(JSON.parse(await helper(page).locator('#preview').textContent())).toEqual(result);
});

test('a stalled position is reported in selection and export without inventing a zero quantity', async ({page}) => {
  await setup(page,'bulk-stall');
  await helper(page).getByRole('button',{name:'Load all positions'}).click();
  await expect(helper(page).locator('#coverage')).toContainText('UNLOADED: position details could not be loaded');
  const result = await run(page,['TESTA']);
  expect(result.accounts[0].issues.map(i=>i.code)).toContain('POSITION_UNAVAILABLE');
  expect(result.accounts[0].positions.map(p=>p.security.symbol)).toEqual(['TESTA']);
});

test('account switch during bulk discovery stops scanning before lot navigation',async({page})=>{
  await setup(page,'bulk-switch');
  await helper(page).getByRole('button',{name:'Load all positions'}).click();
  await expect(helper(page).locator('#status')).toContainText('Account changed');
  await expect(helper(page).getByRole('button',{name:'Collect lots',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.activity)).toEqual([]);
});

test('closing during collection cancels, cleans up the lot panel and permits reopening and retry',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{window.scenario='normal';});
  for (const name of ['TESTA','TESTB','TESTC']) await helper(page).getByRole('checkbox',{name,exact:true}).check();
  // Delay the panel response so Close exercises cancellation while a lot request is pending.
  await page.evaluate(()=>{
    const action=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='Lot Details');
    const original=action.onclick;
    action.onclick=()=>{ original(); document.querySelector('#lot-content').replaceChildren(); };
  });
  await helper(page).getByRole('button',{name:'Collect lots',exact:true}).click();
  await expect(page.locator('#modal')).toBeVisible();
  await helper(page).getByRole('button',{name:'Close helper'}).click();
  await expect(helper(page)).toBeHidden();
  await expect(page.locator('#modal')).toBeHidden();
  await page.evaluate(()=>window.openTestHelper());
  await expect(helper(page).getByRole('button',{name:'Retry incomplete'})).toBeEnabled();
  const result=JSON.parse(await helper(page).locator('#preview').textContent());
  expect(result.accounts[0].lot_scopes.map(s=>s.status)).toEqual(['skipped','skipped','skipped']);
  expect(await page.evaluate(()=>window.activity)).toEqual(['TESTA:menu','TESTA:Lot Details','TESTA:close']);
});

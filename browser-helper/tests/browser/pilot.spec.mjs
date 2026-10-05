import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { validateSnapshot } from '../../src/contract.mjs';

const helper = (page) => page.locator('#tlh-helper');
async function snapshot(page) { return JSON.parse(await helper(page).locator('#preview').textContent()); }
async function collectAll(page) {
  await helper(page).getByRole('button', { name: 'Collect lots', exact: true }).click();
  await expect(helper(page).getByRole('button', { name: 'Download snapshot JSON' })).toBeEnabled();
}

test('one click opens all lot panels, paginates, preserves duplicate lots, and exports valid JSON', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/demo/'); await collectAll(page);
  await expect(helper(page).locator('#status')).toContainText('3 of 3 securities complete');
  const result = await snapshot(page);
  expect(result.accounts[0].lot_scopes.map((s) => s.lots.length)).toEqual([2, 3, 1]);
  expect(result.accounts[0].lot_scopes[1].completeness_evidence.pages_visited).toBe(2);
  await expect(page.locator('#activity')).toContainText('MSFT: menu clicked');
  await expect(page.locator('#activity')).toContainText('VTI: Next page clicked');
  await expect(page.locator('#activity')).toContainText('AAPL: lot panel closed');
  await expect(page.locator('[data-lot-panel]')).toBeHidden();
  const downloadPromise = page.waitForEvent('download');
  await helper(page).getByRole('button', { name: 'Download snapshot JSON' }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(validateSnapshot(exported)).toEqual({ valid: true, errors: [] });
  expect(exported).toEqual(result); expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('pilot-collected.png'), fullPage: true });
});

test('failed security can be retried without recollecting successful securities', async ({ page }) => {
  await page.goto('/demo/'); await page.locator('#scenario').selectOption('failure'); await collectAll(page);
  expect((await snapshot(page)).accounts[0].lot_scopes.map((s) => s.status)).toEqual(['complete', 'failed', 'complete']);
  await page.locator('#scenario').selectOption('normal');
  await helper(page).getByRole('button', { name: 'Retry incomplete' }).click();
  await expect(helper(page).locator('#status')).toContainText('3 of 3 securities complete');
  expect((await snapshot(page)).accounts[0].lot_scopes.map((s) => s.lots.length)).toEqual([2, 3, 1]);
  expect(await page.locator('#activity li').filter({ hasText: 'MSFT: Lot Details clicked' }).count()).toBe(1);
});

// Observe the precise transition in-page so CI polling cannot miss a brief state.
async function interruptAtVti(page, action) {
  await helper(page).locator('#status').evaluate((status, action) => {
    const observer = new MutationObserver(() => {
      if (!status.textContent.includes('Opening VTI')) return;
      observer.disconnect();
      const root = action === 'Cancel' ? status.getRootNode() : document;
      const buttons = [...root.querySelectorAll('button')];
      buttons.find(b => b.textContent.trim() === action).click();
    });
    observer.observe(status, {childList:true,subtree:true,characterData:true});
  }, action);
}

test('cancel retains finished scopes and permits partial export', async ({ page }) => {
  await page.goto('/demo/');
  await interruptAtVti(page, 'Cancel');
  await helper(page).getByRole('button', { name: 'Collect lots', exact: true }).click();
  await expect(helper(page).getByRole('button', { name: 'Download snapshot JSON' })).toBeEnabled();
  const result = await snapshot(page);
  expect(result.accounts[0].lot_scopes[0].status).toBe('complete');
  expect(result.accounts[0].lot_scopes[2].status).toBe('skipped');
  expect(validateSnapshot(result).valid).toBe(true);
});

test('filtered positions and selected subsets are explicit partial coverage', async ({ page }) => {
  await page.goto('/demo/'); await page.locator('#scenario').selectOption('partial'); await collectAll(page);
  expect((await snapshot(page)).accounts[0].positions_coverage).toBe('partial');
  await page.locator('#scenario').selectOption('normal');
  await helper(page).getByRole('checkbox', { name: 'VTI', exact: true }).uncheck(); await collectAll(page);
  const result = await snapshot(page);
  expect(result.accounts[0].positions_coverage).toBe('partial');
  expect(result.accounts[0].positions.map((p) => p.security.symbol)).toEqual(['MSFT', 'AAPL']);
});

test('unknown fields and totals mismatches remain visible in export', async ({ page }) => {
  await page.goto('/demo/'); await page.locator('#scenario').selectOption('unknown'); await collectAll(page);
  let scope = (await snapshot(page)).accounts[0].lot_scopes[1];
  expect(scope.lots[0].total_basis).toBeNull(); expect(scope.lots[0].acquisition_date).toBeNull();
  expect(scope.issues.some((i) => i.code === 'MISSING_LOT_FIELDS')).toBe(true);
  await page.locator('#scenario').selectOption('mismatch'); await collectAll(page);
  scope = (await snapshot(page)).accounts[0].lot_scopes[1];
  expect(scope.issues.some((i) => i.code === 'QUANTITY_MISMATCH')).toBe(true);
});

test('stalled pagination is partial with captured rows, followed by next security', async ({ page }) => {
  await page.goto('/demo/'); await page.locator('#scenario').selectOption('pagination'); await collectAll(page);
  const scopes = (await snapshot(page)).accounts[0].lot_scopes;
  expect(scopes.map((s) => s.status)).toEqual(['complete', 'partial', 'complete']);
  expect(scopes[1].lots.length).toBe(2); expect(scopes[1].issues.some((i) => i.code === 'TIMEOUT')).toBe(true);
});

test('account switch stops collection without retaining uncertain in-flight lots', async ({ page }) => {
  await page.goto('/demo/');
  await interruptAtVti(page, 'Switch account');
  await helper(page).getByRole('button', { name: 'Collect lots', exact: true }).click();
  await expect(helper(page).getByRole('button', { name: 'Download snapshot JSON' })).toBeEnabled();
  const result = await snapshot(page); expect(result.accounts[0].account_ref).toBe('demo-account-1');
  expect(result.accounts[0].lot_scopes[1].lots.length).toBe(0);
  expect(result.accounts[0].lot_scopes[2].status).toBe('skipped');
});

test('built extension content script mounts once and uses the same collector', async ({ page }) => {
  await page.goto('/demo/?extension'); await expect(helper(page)).toHaveCount(0);
  await page.addScriptTag({ url: '/dist/content.js' });
  await page.addScriptTag({ url: '/dist/content.js' });
  await expect(helper(page)).toHaveCount(1); await collectAll(page);
  expect(validateSnapshot(await snapshot(page)).valid).toBe(true);
  const saved = await snapshot(page);
  await helper(page).getByRole('button', { name: 'Close helper' }).click();
  await expect(helper(page)).toBeHidden();
  await page.addScriptTag({ url: '/dist/content.js' });
  await expect(helper(page)).toBeVisible();
  await expect(helper(page)).toHaveCount(1);
  expect(await snapshot(page)).toEqual(saved);
});

test('server never serves the repository, dependencies, or personal exports', async ({ request }) => {
  for (const path of ['/Export-CSV/Lot-Details.csv', '/.git/config', '/package.json', '/node_modules/ajv/package.json']) {
    expect((await request.get(path)).status()).toBe(404);
  }
});

test('expired session blocks collection and restored session permits a new run', async ({ page }) => {
  await page.goto('/demo/'); await page.getByRole('button', { name: 'Expire session', exact: true }).click();
  await helper(page).getByRole('button', { name: 'Collect lots', exact: true }).click();
  await expect(helper(page).locator('#status')).toContainText('Session expired');
  await expect(helper(page).getByRole('button', { name: 'Download snapshot JSON' })).toBeDisabled();
  await page.getByRole('button', { name: 'Restore session' }).click(); await collectAll(page);
  await expect(helper(page).locator('#status')).toContainText('3 of 3 securities complete');
});

test('account changed after selection is displayed requires a fresh review before clicking lots', async ({ page }) => {
  await page.goto('/demo/');
  await expect(helper(page).getByRole('button', { name: 'Collect lots', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Switch account' }).click();
  await helper(page).getByRole('button', { name: 'Collect lots', exact: true }).click();
  await expect(helper(page).locator('#status')).toContainText('Account changed since the selection');
  await expect(page.locator('#activity')).not.toContainText('Lot Details clicked');
  await helper(page).getByRole('button', { name: 'Clear', exact: true }).click();
  await collectAll(page); expect((await snapshot(page)).accounts[0].account_ref).toBe('demo-account-2');
});

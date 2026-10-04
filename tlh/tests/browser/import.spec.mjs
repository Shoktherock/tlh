import { test, expect } from '@playwright/test';
import { samplePositions } from '../../src/sample.mjs';

async function stage(page) {
  await page.goto('/?workspace=pilot');
  await page.getByRole('button', {name:'Try synthetic sample files'}).click();
  await page.getByLabel('Account label', {exact:true}).fill('Sample account');
  await page.getByRole('button',{name:'Build preview'}).click();
  await expect(page.getByRole('heading',{name:'Review & accept'})).toBeVisible();
}
async function review(page) {
  await page.getByRole('checkbox',{name:/I reviewed all source account labels/}).check();
  await page.getByRole('checkbox',{name:/I reviewed source times/}).check();
}
async function state(page) {
  return page.evaluate(() => new Promise((resolve,reject)=>{
    const request=indexedDB.open('tlh-import-pilot-v1',1);
    request.onsuccess=()=>{const db=request.result;const tx=db.transaction('portfolio');const read=tx.objectStore('portfolio').get('current');tx.oncomplete=()=>{resolve(read.result??null);db.close();};tx.onerror=reject;};request.onerror=reject;
  }));
}
test('preview does not write; accept persists one account, lots, position-only rights and cash; reload and reimport are safe',async({page},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await stage(page);
  expect(await state(page)).toBeNull();
  await expect(page.getByRole('button',{name:'Accept selected scopes'})).toBeDisabled();
  await page.getByRole('row').filter({has:page.getByRole('cell',{name:/EXAMPLE/})}).getByRole('button',{name:'1 notes'}).click();
  await expect(page.getByRole('dialog').getByRole('cell',{name:'2025-01-10',exact:true})).toHaveCount(2);
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await review(page);
  await page.screenshot({path:info.outputPath('import-preview.png'),fullPage:true});
  await page.getByRole('button',{name:'Accept selected scopes'}).click();
  await expect(page.getByText('Import accepted.',{exact:false})).toBeVisible();
  const saved=await state(page);expect(saved.accounts).toHaveLength(1);expect(saved.imports).toHaveLength(1);
  const holdings=saved.holdings[saved.accounts[0].id];expect(Object.keys(holdings)).toHaveLength(3);
  expect(holdings.EXAMPLE.lotScope.lots).toHaveLength(2);expect(holdings['000CVR000'].lotScope).toBeNull();
  expect(saved.cash[saved.accounts[0].id].amount).toBe('12.34');
  await page.getByRole('button',{name:'Upload files',exact:true}).click();
  await page.getByRole('button',{name:'Build preview'}).click();await review(page);
  await page.getByRole('button',{name:'Accept selected scopes'}).click();
  await expect(page.getByText('Already imported.',{exact:false})).toBeVisible();
  expect((await state(page)).imports).toHaveLength(1);
  await page.reload(); await page.getByRole('button',{name:'Holdings',exact:true}).click();
  await expect(page.getByRole('cell',{name:/000CVR000/})).toBeVisible();
  expect(errors).toEqual([]);
});
test('selection applies only chosen scopes and excludes unselected cash',async({page})=>{
  await stage(page);await page.getByRole('button',{name:'Select none',exact:true}).click();
  await page.getByRole('checkbox',{name:'Include FUND',exact:true}).check();
  await page.getByRole('checkbox',{name:/Include cash observation/}).uncheck();await review(page);
  await page.getByRole('button',{name:'Accept selected scopes'}).click();
  await expect(page.getByText('Import accepted.',{exact:false})).toBeVisible();
  const saved=await state(page);expect(Object.keys(saved.holdings[saved.accounts[0].id])).toEqual(['FUND']);expect(saved.cash).toEqual({});
});
test('two tabs cannot accept against the same stale portfolio revision',async({page,context})=>{
  await stage(page); const other=await context.newPage(); await stage(other);await review(page);await review(other);
  await page.getByRole('button',{name:'Accept selected scopes'}).click();
  await expect(page.getByText('Import accepted.',{exact:false})).toBeVisible();
  await other.getByRole('button',{name:'Accept selected scopes'}).click();
  await expect(other.getByRole('alert')).toContainText('stale');expect((await state(other)).imports).toHaveLength(1);
});
test('a failed IndexedDB write rolls back acceptance without creating an account or import',async({page})=>{
  await stage(page);await review(page);
  await page.evaluate(()=>{IDBObjectStore.prototype.put=function(){throw new DOMException('Simulated quota failure','QuotaExceededError');};});
  await page.getByRole('button',{name:'Accept selected scopes'}).click();
  await expect(page.getByRole('alert')).toContainText('Simulated quota failure');expect(await state(page)).toBeNull();
});

test('an asynchronous storage abort after a queued write leaves no partial state',async({page})=>{
  await stage(page);await review(page);
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);request.addEventListener('success',()=>this.transaction.abort());return request;};});
  await page.getByRole('button',{name:'Accept selected scopes'}).click();
  await expect(page.getByRole('alert')).toContainText('not changed');expect(await state(page)).toBeNull();
});
test('manual CSV upload works and a malformed file is not silently partially imported',async({page})=>{
  await page.goto('/?workspace=pilot');
  await page.getByLabel('Source files').setInputFiles({name:'positions.csv',mimeType:'text/csv',buffer:Buffer.from(samplePositions)});
  await page.getByLabel('Account label',{exact:true}).fill('Manual account');
  await page.getByRole('button',{name:'Build preview'}).click();await review(page);
  await page.getByRole('button',{name:'Accept selected scopes'}).click();
  await expect(page.getByText('Import accepted.',{exact:false})).toBeVisible();
  const before=await state(page);expect(Object.values(before.holdings[before.accounts[0].id]).every(h=>h.lotScope===null)).toBe(true);
  await page.getByRole('button',{name:'Upload files',exact:true}).click();
  await page.getByLabel('Source files').setInputFiles({name:'bad.csv',mimeType:'text/csv',buffer:Buffer.from(samplePositions.replace('"0.5"','"not a quantity"'))});
  await expect(page.getByRole('alert')).toContainText('not added');expect(await state(page)).toEqual(before);
});
test('private source paths are never served as application assets',async({request})=>{
  for(const path of ['/Export-CSV/Positions-2026-09-08-175156.csv','/@fs/C:/Users/minal/Project/tlh2/Export-CSV/Positions-2026-09-08-175156.csv','/../Export-CSV/Positions-2026-09-08-175156.csv']){
    const response=await request.get(path);expect(await response.text()).not.toContain('Positions for account');
  }
});

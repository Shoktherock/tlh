import {test,expect} from '@playwright/test';
import {sampleFiles} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../../src/import/engine.mjs';

async function fixture(){
  let state=emptyState();const sources=await Promise.all(sampleFiles().map(readSource));
  for(const accountLabel of ['Review account A','Review account B']){
    const plan=await previewImport(state,sources,{accountId:null,accountLabel,accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});
    state=acceptPreview(state,plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Saved review note.'}).state;
  }
  return state;
}
async function seed(page,state){
  await page.goto('/?workspace=pilot');await page.evaluate(state=>new Promise((resolve,reject)=>{const request=indexedDB.open('tlh-import-pilot-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('portfolio');request.onsuccess=()=>{const db=request.result;const tx=db.transaction('portfolio','readwrite');tx.objectStore('portfolio').put(state,'current');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};request.onerror=reject;}),state);await page.reload();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:/^Reconciliation/}).click();
}
test('inbox filters accounts and gaps, opens exact original evidence, and stays read-only after refresh',async({page},info)=>{
  const state=await fixture();await seed(page,state);
  await expect(page.getByRole('heading',{name:'Reconciliation inbox'})).toBeVisible();
  await page.getByRole('combobox',{name:'Filter account'}).click();await page.getByRole('option',{name:'Review account A',exact:true}).click();
  await page.getByRole('combobox',{name:'Issue category'}).click();await page.getByRole('option',{name:'Lot coverage',exact:true}).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);await expect(page.locator('tbody')).toContainText('000CVR000');await expect(page.locator('tbody')).not.toContainText('Review account B');
  await page.screenshot({path:info.outputPath('reconciliation-inbox.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Review 000CVR000: No complete lot snapshot'}).click();
  await expect(page.getByRole('dialog')).toContainText('Saved review note.');await page.getByRole('button',{name:'View original position',exact:true}).click();await expect(page.getByRole('dialog').locator('pre')).toHaveText(sampleFiles()[1].text);
  await page.getByRole('button',{name:'Back to issue'}).click();await page.screenshot({path:info.outputPath('reconciliation-evidence.png'),fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'Close evidence'}).click();
  await page.getByRole('button',{name:'Refresh accepted evidence'}).click();await expect(page.locator('tbody tr')).toHaveCount(1);
  const saved=await page.evaluate(()=>new Promise(resolve=>{const request=indexedDB.open('tlh-import-pilot-v1',1);request.onsuccess=()=>{const db=request.result;const read=db.transaction('portfolio').objectStore('portfolio').get('current');read.onsuccess=()=>{resolve(read.result);db.close();};};}));
  expect(saved).toEqual(state);
});
test('timing issues show separate totals and exact duplicate rows; closed holdings require explicit inclusion',async({page})=>{
  const state=await fixture();state.holdings[state.accounts[0].id].EXAMPLE.active=false;
  await seed(page,state);await page.getByLabel('Find reconciliation issue').fill('EXAMPLE');
  await expect(page.locator('tbody tr')).toHaveCount(1);await page.getByLabel('Include closed holdings').check();await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('combobox',{name:'Filter account'}).click();await page.getByRole('option',{name:'Review account A',exact:true}).click();
  await page.getByRole('button',{name:'Review EXAMPLE: Lot effective date is unknown'}).click();const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('Closed holding');await expect(dialog).toContainText('Effective timing is unverified');await expect(dialog.getByRole('cell',{name:'2025-01-10',exact:true})).toHaveCount(2);
  await expect(dialog.getByRole('button',{name:'View original accepted lots'})).toBeVisible();
});

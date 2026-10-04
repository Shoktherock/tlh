import {csv as activityCsv} from '../fixtures/schwab-activity.mjs';
import {realizedFixture} from './realized-fixture.mjs';
import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {sampleSnapshot,samplePositions} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};
test('dashboard partitions P/L, filters portfolios, degrades on optional read failures and preserves saved evidence',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`,raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),user=(await good(admin.auth.admin.createUser({email:`dashboard-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;
  const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));const store=supabaseStore(client);
  try{
    const accounts=[],portfolios=[],snapshot=structuredClone(sampleSnapshot);
    for(const record of [...snapshot.accounts[0].positions,...snapshot.accounts[0].lot_scopes])record.effective_date='2026-09-18';
    snapshot.accounts[0].lot_scopes[0].lots[0].acquisition_date='2026-09-01';snapshot.accounts[0].lot_scopes[0].lots[0].broker_holding_period='Short Term';
    const files=[{name:'synthetic.json',text:JSON.stringify(snapshot)},{name:'synthetic-positions.csv',text:samplePositions.replace('2026/09/08','2026/09/18')}];
    for(let n=0;n<2;n++){
      const p=await good(client.from('portfolios').insert({user_id:user.id,name:`Dashboard portfolio ${n+1}`}).select().single());portfolios.push(p);
      const a=await good(client.from('accounts').insert({user_id:user.id,portfolio_id:p.id,label:'Same account name',broker:'schwab',account_type:n?'roth_ira':'taxable'}).select().single());accounts.push(a);
      const plan=await store.buildPreview(await store.readState(),await Promise.all(files.map(readSource)),{accountId:a.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await store.commitImport(plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic dashboard setup'});
    }
    const before={holdings:await store.readState(),inputs:await store.analysis({action:'read'}),activity:await store.activity({action:'read'})},actions=[];
    const emptyQuotes=route=>route.fulfill({contentType:'application/json',body:JSON.stringify({provider:'Massive',items:[]})});
    await page.route('**/functions/v1/get-quotes',emptyQuotes);
    page.on('request',req=>{if(req.url().includes('/functions/v1/')&&req.method()==='POST')actions.push(req.postDataJSON()?.action);});
    await page.goto('/?workspace=imports&view=dashboard');await page.getByRole('textbox',{name:'Email',exact:true}).fill(user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Portfolio overview'})).toBeVisible();
    await page.getByText('Portfolio breakdown',{exact:true}).click();
    const totals=page.getByRole('table',{name:'Dashboard currency summaries'});await expect(totals).toContainText('0 / 6 positions');await expect(page.getByRole('table',{name:'Dashboard cash'})).toContainText('12.34');
    await page.getByRole('button',{name:'Update prices',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('button',{name:'Fetch closing prices',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByRole('button',{name:'Prices',exact:true}).click();await page.getByLabel('Valuation time (local)',{exact:true}).fill('2026-09-18T12:00');await page.getByRole('button',{name:'Set price Same account name EXAMPLE',exact:true}).first().click();await page.getByLabel('Scenario price',{exact:true}).fill('90');await page.getByLabel('Price currency',{exact:true}).fill('USD');await page.getByLabel('Price reference',{exact:true}).fill('Synthetic dashboard price');await page.getByLabel('Price time (local)',{exact:true}).fill('2026-09-18T12:00');await page.getByRole('button',{name:'Apply scenario price',exact:true}).click();
    await page.getByRole('button',{name:'Results',exact:true}).click();await page.getByText('Portfolio breakdown',{exact:true}).click();await expect(totals).toContainText('180');await expect(totals).toContainText('-20');await expect(totals).toContainText('1 / 6 positions');
    await page.getByText('Valuation assumptions & source details',{exact:true}).click();await page.getByLabel('Dashboard holding-period date').fill('2026-09-18');await page.getByLabel('Use ordinary-purchase holding periods for this dashboard scenario.').check();await expect(totals.locator('tbody tr').getByRole('cell').nth(4)).toHaveText('-10');await expect(totals.locator('tbody tr').getByRole('cell').nth(5)).toHaveText('-10');await expect(totals.locator('tbody tr').getByRole('cell').nth(6)).toHaveText('0');
    await page.getByLabel('Dashboard portfolio',{exact:true}).click();await page.getByRole('option',{name:`Dashboard portfolio 1 · ${portfolios[0].id}`,exact:true}).click();await expect(page.getByRole('table',{name:'Dashboard account totals'}).locator('tbody tr')).toHaveCount(1);await expect(totals).toContainText('1 / 3 positions');
    await page.getByText('Holdings & source evidence',{exact:true}).click();await page.getByText('Explain Same account name EXAMPLE',{exact:true}).click();await expect(page.getByRole('table',{name:'Dashboard holdings'})).toContainText('row-1 · 2026-09-01 · short');
    await page.screenshot({path:'test-results/dashboard-signed-in.png',fullPage:true,animations:'disabled'});
    await page.route('**/functions/v1/get-quotes',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic offline quote service'})}));await page.route('**/functions/v1/activity',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic offline activity service'})}));
    await page.getByRole('button',{name:'Reload saved data',exact:true}).click();await expect(page.getByText('Cached quotes could not be loaded.',{exact:false})).toBeVisible();await expect(page.getByText('Activity coverage is unavailable.',{exact:false})).toBeVisible();await page.getByText('Portfolio breakdown',{exact:true}).click();await expect(totals).toContainText('-20');
    await page.unrouteAll();await page.route('**/functions/v1/get-quotes',emptyQuotes);await page.getByRole('button',{name:'Reload saved data',exact:true}).click();await page.getByText('Portfolio breakdown',{exact:true}).click();await expect(page.getByRole('table',{name:'Dashboard history coverage'})).toBeVisible();expect(await store.readState()).toEqual(before.holdings);expect(await store.analysis({action:'read'})).toEqual(before.inputs);expect(await store.activity({action:'read'})).toEqual(before.activity);expect(actions.every(a=>['read','realized-read','tracking-read','drafts'].includes(a))).toBe(true);
    await page.reload();await expect(page.getByRole('heading',{name:'Portfolio overview'})).toBeVisible();await page.getByText('Portfolio breakdown',{exact:true}).click();await expect(totals).toContainText('0 / 6 positions');await page.getByText('Valuation assumptions & source details',{exact:true}).click();await expect(page.getByLabel('Use ordinary-purchase holding periods for this dashboard scenario.')).not.toBeChecked();
    await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'Portfolio overview'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.setViewportSize({width:1440,height:1100});
    await expect(page.getByRole('table',{name:'Tracked sales',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Data & accounts',exact:true}).click();
    await page.getByLabel('Brokerage files',{exact:true}).setInputFiles({name:'transactions.csv',mimeType:'text/csv',buffer:Buffer.from(activityCsv)});
    await expect(page.getByRole('table',{name:'Draft activity rows'})).toContainText('1234');
    await expect(page.getByRole('button',{name:'Preview activity',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Data & accounts',exact:true}).click();
    await page.getByLabel('Brokerage files',{exact:true}).setInputFiles({name:'realized.csv',mimeType:'text/csv',buffer:Buffer.from(realizedFixture())});
    await expect(page.getByText('realized.csv',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Preview realized report',exact:true})).toBeDisabled();
    await page.screenshot({path:'test-results/unified-upload.png',fullPage:true});
    expect(await store.readState()).toEqual(before.holdings);expect(await store.activity({action:'read'})).toEqual(before.activity);
  }finally{await client.auth.signOut();}
});

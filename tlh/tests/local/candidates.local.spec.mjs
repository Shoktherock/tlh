import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {sampleFiles} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
import {defaultInputs} from '../../src/analysis/inputs.mjs';
import {activityTemplate} from '../../src/activity/engine.mjs';
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};
test('loss candidates read saved evidence, share scenario prices, flag omitted IRA acquisitions and never mutate records',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`,raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),user=(await good(admin.auth.admin.createUser({email:`candidates-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;
  const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));const store=supabaseStore(client);
  try{
    const useSaved=async()=>{await page.getByText('Settings and evidence',{exact:true}).click();await page.getByLabel('Use my saved analysis settings',{exact:true}).check();};
    const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:'Synthetic candidates'}).select().single()),accounts=[];
    for(const [label,type] of [['Taxable test','taxable'],['IRA test','roth_ira']])accounts.push(await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label,broker:'schwab',account_type:type}).select().single()));
    const plan=await store.buildPreview(await store.readState(),await Promise.all(sampleFiles().map(readSource)),{accountId:accounts[0].id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await store.commitImport(plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic candidate validation'});
    const initial=await store.analysis({action:'read'}),input=defaultInputs(initial.accounts);input.analysisDate='2026-09-18';input.minLoss.amount='5';input.rates={federalShort:'30',federalLong:'15',state:'5'};input.household='all_known_listed';input.accounts[0].scope='include';for(const a of input.accounts){a.scope=a.accountId===accounts[0].id?'include':'omit';if(a.scope==='omit')a.reason='Not a harvesting account';}
    const ip=(await store.analysis({action:'prepare',input,baseRevision:0,reason:'Synthetic assumptions'})).preview;await store.analysis({action:'accept',preparedId:ip.preparedId,reviewed:true});
    const doc=activityTemplate();doc.rows[0].date='2026-09-01';doc.rows[0].quantity='0.125';doc.rows[0].symbol='EXAMPLE';const ap=(await store.activity({action:'prepare',baseRevision:0,accountId:accounts[1].id,source:{name:'synthetic-ira.json',text:JSON.stringify(doc)}})).preview;await store.activity({action:'accept',preparedId:ap.preparedId,reviewed:true});
    const before={holdings:await store.readState(),inputs:await store.analysis({action:'read'}),activity:await store.activity({action:'read'})},actions=[];
    page.on('request',req=>{if(req.url().includes('/functions/v1/')&&req.method()==='POST')actions.push(req.postDataJSON()?.action);});
    await page.route('**/functions/v1/get-quotes',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({provider:'Massive',items:[]})}));
    await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:/^Opportunities/}).click();await useSaved();
    await expect(page.getByText(/0 candidate lot rows/)).toBeVisible();await page.getByLabel('Show excluded rows').check();await expect(page.getByRole('table',{name:'Loss candidates'})).toContainText('Excluded');
    await page.getByRole('button',{name:'Set valuation prices'}).click();await page.getByLabel('Valuation time (local)',{exact:true}).fill('2026-09-18T12:00');await page.getByRole('button',{name:'Set price Taxable test EXAMPLE',exact:true}).click();await page.getByLabel('Scenario price',{exact:true}).fill('90');await page.getByLabel('Price currency',{exact:true}).fill('USD');await page.getByLabel('Price reference',{exact:true}).fill('Synthetic analysis price');await page.getByLabel('Price time (local)',{exact:true}).fill('2026-09-18T12:00');await page.getByRole('button',{name:'Apply scenario price',exact:true}).click();
    await page.getByRole('button',{name:/^Opportunities/}).click();await useSaved();await expect(page.getByText(/2 candidate lot rows/)).toBeVisible();const table=page.getByRole('table',{name:'Loss candidates'});await expect(table.getByRole('row')).toHaveCount(3);await expect(table).toContainText('Possible acquisition — review');
    await page.getByLabel('For this scenario, treat dated lots as ordinary purchased securities with no special holding-period adjustments.').check();await expect(table).toContainText('Long-term scenario');await page.getByText('Explain EXAMPLE row 1',{exact:true}).click();await expect(table).toContainText('IRA test (roth_ira)');await expect(table).toContainText('quantity 0.125');await expect(table).toContainText('No allocation, matched quantity, disallowed loss or basis adjustment');await expect(table).toContainText('2026-08-19 through 2026-10-18');
    await page.getByRole('button',{name:'Reload saved data'}).click();await expect(page.getByText(/2 candidate lot rows/)).toBeVisible();await page.screenshot({path:'test-results/candidates-signed-in.png',fullPage:true,animations:'disabled'});
    expect(await store.readState()).toEqual(before.holdings);expect(await store.analysis({action:'read'})).toEqual(before.inputs);expect(await store.activity({action:'read'})).toEqual(before.activity);expect(actions.length).toBeGreaterThan(0);expect(actions.every(a=>['read','compare','benchmark-status'].includes(a))).toBe(true);
    await page.reload();await page.getByRole('button',{name:/^Opportunities/}).click();await useSaved();await expect(page.getByText(/0 candidate lot rows/)).toBeVisible();await expect(page.getByLabel('For this scenario, treat dated lots as ordinary purchased securities with no special holding-period adjustments.')).not.toBeChecked();
  }finally{await client.auth.signOut();}
});


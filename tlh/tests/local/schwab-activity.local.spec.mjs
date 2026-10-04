import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {activityView} from '../../src/activity/engine.mjs';
import {csv} from '../fixtures/schwab-activity.mjs';
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};
test('Schwab CSV browser review accepts original evidence, handles reimport and restores independently of holdings',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`,raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const user=(await good(admin.auth.admin.createUser({email:`csv-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;
  const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});
  try{
    await good(client.auth.signInWithPassword({email:user.email,password}));const store=supabaseStore(client);
    const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:'CSV validation'}).select().single()),accounts=[];
    for(const label of ['CSV source','Restore target'])accounts.push(await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label,broker:'schwab',account_type:'taxable'}).select().single()));
    const before=await store.readState();
    await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Transactions',exact:true}).click();
    await page.getByLabel('Schwab transactions CSV',{exact:true}).setInputFiles({name:'synthetic.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await expect(page.getByRole('heading',{name:'CSV activity rows'})).toBeVisible();await expect(page.getByRole('table',{name:'Draft activity rows'}).getByRole('row')).toHaveCount(4);await expect(page.getByRole('button',{name:'Remove activity row 1'})).toBeDisabled();
    await page.getByLabel('Activity account',{exact:true}).click();await page.getByRole('option',{name:'CSV validation / CSV source',exact:true}).click();await page.getByLabel('Source account label',{exact:true}).fill('Synthetic Schwab account');
    await expect(page.getByRole('button',{name:'Preview activity',exact:true})).toBeDisabled();await page.getByLabel('CSV amount currency').click();await page.getByRole('option',{name:'USD — confirmed from my source',exact:true}).click();await page.getByLabel('I verified that the CSV Date column reports trade dates.').check();
    await page.getByRole('button',{name:'Preview activity',exact:true}).click();await expect(page.getByText('3 new records; 0 duplicate rows excluded.',{exact:false})).toBeVisible();await expect(page.getByRole('table',{name:'Activity review'})).toContainText('Cash: -206.26 USD');expect((await store.activity({action:'read'})).revision).toBe(0);
    await page.screenshot({path:'test-results/schwab-activity-review.png',fullPage:true,animations:'disabled'});
    await page.getByLabel('I reviewed the account, original source, overlap choices and collection coverage.').check();await page.getByRole('button',{name:'Accept activity review'}).click();await expect(page.getByText('Activity saved at revision 1. Holdings and lot evidence are unchanged.')).toBeVisible();
    const saved=await store.activity({action:'read'}),batch=saved.state.events[0];expect(batch.source.text).toBe(csv);expect(batch.source.review.sourceAccount).toBe('Synthetic Schwab account');expect(batch.document.format).toBe('tlh-schwab-activity');expect(activityView(saved.state).transactions).toHaveLength(3);
    await page.getByRole('button',{name:'Preview activity',exact:true}).click();await expect(page.getByText('This normalized source is already accepted in this account. Nothing was duplicated.')).toBeVisible();
    await page.getByLabel('Source range start').fill('2026-09-01');await page.getByRole('button',{name:'Preview activity',exact:true}).click();await expect(page.getByRole('button',{name:'Accept activity review'})).toBeDisabled();await expect(page.getByLabel('Overlap csv-row-2')).toBeVisible();
    const backup=(await store.activity({action:'export'})).backup;
    // Use another synthetic user's account for a restore: same-ledger ID collisions are forbidden.
    const restoredUser=(await good(admin.auth.admin.createUser({email:`csv-restore-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;
    const restoreClient=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});
    try{
      await good(restoreClient.auth.signInWithPassword({email:restoredUser.email,password}));const p=await good(restoreClient.from('portfolios').insert({user_id:restoredUser.id,name:'CSV restore'}).select().single()),a=await good(restoreClient.from('accounts').insert({user_id:restoredUser.id,portfolio_id:p.id,label:'Restore',broker:'schwab',account_type:'taxable'}).select().single()),rs=supabaseStore(restoreClient);
      const plan=await rs.activity({action:'prepare-restore',baseRevision:0,backup,mapping:{[accounts[0].id]:a.id},reason:'Validate CSV recovery'});const result=await rs.activity({action:'accept',preparedId:plan.preview.preparedId,reviewed:true});expect(result.saved.state.events[0].source.text).toBe(csv);expect(activityView(result.saved.state).transactions).toHaveLength(3);
    }finally{await restoreClient.auth.signOut();}
    await page.reload();await page.getByRole('button',{name:'Transactions',exact:true}).click();await expect(page.getByText(/3 active records/)).toBeVisible();expect(await store.readState()).toEqual(before);
  }finally{await client.auth.signOut();}
});

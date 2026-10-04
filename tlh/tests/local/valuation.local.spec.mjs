import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {sampleFiles} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};
test('signed-in valuation handles future and stale prices, isolates account prices, and sends no portfolio mutations',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`;
  const raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),user=(await good(admin.auth.admin.createUser({email:`valuation-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;
  const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));const store=supabaseStore(client);
  try{
    const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:'Synthetic valuation validation'}).select().single());
    const accounts=[];for(const label of ['Scenario A','Scenario B']){const target=await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label,broker:'schwab',account_type:'taxable'}).select().single());accounts.push(target);const plan=await store.buildPreview(await store.readState(),await Promise.all(sampleFiles().map(readSource)),{accountId:target.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await store.commitImport(plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic setup.'});}
    const before=await store.readState(),actions=[];page.on('request',req=>{if(req.url().includes('/functions/v1/imports')&&req.method()==='POST')actions.push(req.postDataJSON().action);});
    await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Prices',exact:true}).click();
    await page.getByLabel('Valuation time (local)',{exact:true}).fill('2026-09-13T12:00');await page.getByRole('button',{name:'Set price Scenario A EXAMPLE',exact:true}).click();await page.getByLabel('Scenario price',{exact:true}).fill('90');await page.getByLabel('Price currency',{exact:true}).fill('USD');await page.getByLabel('Price reference',{exact:true}).fill('Synthetic time-bound price');await page.getByLabel('Price time (local)',{exact:true}).fill('2026-09-13T12:01');await page.getByRole('button',{name:'Apply scenario price',exact:true}).click();
    const a=page.getByRole('table',{name:'Position valuations'}).getByRole('row').filter({has:page.getByRole('button',{name:'Set price Scenario A EXAMPLE',exact:true})}),b=page.getByRole('table',{name:'Position valuations'}).getByRole('row').filter({has:page.getByRole('button',{name:'Set price Scenario B EXAMPLE',exact:true})});
    await expect(a).toContainText('After valuation time');await expect(a).not.toContainText('-20');await expect(b).toContainText('Missing');
    await page.getByLabel('Price time (local)',{exact:true}).fill('2026-09-13T11:40');await page.getByRole('button',{name:'Apply scenario price',exact:true}).click();await expect(a).toContainText('Older than 15 min');await expect(a).toContainText('-20');
    await page.getByRole('button',{name:'Refresh holding evidence'}).click();expect(await store.readState()).toEqual(before);expect(actions.length).toBeGreaterThan(0);expect(actions.every(action=>action==='read')).toBe(true);
    await page.getByRole('button',{name:'Clear all scenario prices'}).click();await expect(a).toContainText('Missing');await expect(a).not.toContainText('-20');
    await page.screenshot({path:'test-results/valuation-signed-in.png',fullPage:true,animations:'disabled'});
  }finally{await client.auth.signOut();}
});

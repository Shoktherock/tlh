import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {sampleFiles} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
import {previousWeekday} from '../../server/massive-service.mjs';
const good=async p=>{const r=await p;if(r.error)throw Error(r.error.message);return r.data;};
test('Massive defaults to daily prices, renders dated valuation, retains exceptions and offers Twelve Data',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`,raw=JSON.parse(execFileSync('supabase.exe',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),user=(await good(admin.auth.admin.createUser({email:`massive-${randomUUID()}@example.test`,password,email_confirm:true}))).user;
  const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));const store=supabaseStore(client);
  try{
    const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:'Synthetic daily prices'}).select().single());
    const account=await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label:'Daily test',broker:'schwab',account_type:'taxable'}).select().single());
    const plan=await store.buildPreview(await store.readState(),await Promise.all(sampleFiles().map(readSource)),{accountId:account.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await store.commitImport(plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic Massive setup'});
    const before=await store.readState(),liveRead=await store.quotes({action:'read'});expect(liveRead.provider).toBe('Massive');expect(liveRead.items.every(i=>i.accountId===account.id)).toBe(true);
    const date=previousWeekday(new Date().toISOString()),requests=[];
    const quote={accountId:account.id,symbol:'EXAMPLE',security:before.holdings[account.id].EXAMPLE.position.security,kind:'provider',provider:'massive',providerSymbol:'EXAMPLE',price:'90',currency:'USD',priceType:'daily-close',priceDate:date,observedAt:null,fetchedAt:new Date().toISOString(),reference:`Massive daily close ${date}`};
    await page.route('**/functions/v1/get-quotes',async route=>{const b=route.request().postDataJSON();requests.push(b);await route.fulfill({contentType:'application/json',body:JSON.stringify(b.provider==='twelve-data'?{provider:'Twelve Data',configured:true,items:[]}:{provider:'Massive',configured:true,priceDate:date,suggestedDate:date,items:[{accountId:account.id,symbol:'EXAMPLE',valid:true,cacheStatus:'daily',quote},{accountId:account.id,symbol:'FUND',valid:true,error:{code:'missing',message:'No exact symbol in daily summary.'},quote:null}]})});});
    await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Prices',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Daily portfolio prices'})).toBeVisible();
    await page.getByRole('button',{name:'Fetch closing prices',exact:true}).click();
    await expect(page.getByRole('status')).toContainText(date);
    const table=page.getByRole('table',{name:'Position valuations'});await expect(table).toContainText('Massive daily close');await expect(table).toContainText('-20');
    expect(requests.filter(r=>r.action==='daily-refresh')).toHaveLength(1);
    await page.getByRole('combobox',{name:'Market data provider',exact:true}).click();await page.getByRole('option',{name:'Twelve Data — individual quotes'}).click();await expect(page.getByRole('button',{name:'Set up and refresh all quotes'})).toBeVisible();
    expect(await store.readState()).toEqual(before);
    await page.getByRole('combobox',{name:'Market data provider',exact:true}).click();await page.getByRole('option',{name:'Massive — daily closing prices'}).click();
    await page.screenshot({path:'test-results/massive-daily.png',fullPage:true});
  }finally{await client.auth.signOut();}
});

import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {sampleFiles} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
const good=async p=>{const r=await p;if(r.error)throw Error(r.error.message);return r.data;};
test('bulk quote controls preserve existing matches, report exceptions and stop/resume',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`,raw=JSON.parse(execFileSync('supabase.exe',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const user=(await good(admin.auth.admin.createUser({email:`bulk-${randomUUID()}@example.test`,password,email_confirm:true}))).user;
  const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));
  const store=supabaseStore(client);
  try{
    const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:'Synthetic bulk quotes'}).select().single());
    const account=await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label:'Bulk test',broker:'schwab',account_type:'taxable'}).select().single());
    const plan=await store.buildPreview(await store.readState(),await Promise.all(sampleFiles().map(readSource)),{accountId:account.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});
    await store.commitImport(plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic bulk setup'});
    const before=await store.readState(),actions=[],items=[];
    await store.quotes({action:'map',accountId:account.id,symbol:'EXAMPLE',providerSymbol:'EXAMPLE',mic:'XNGS',reviewed:true});
    const preserved=await store.quotes({action:'automap',accountId:account.id,symbol:'EXAMPLE'});
    expect(preserved.automatic.code).toBe('preserved');
    await store.quotes({action:'unmap',accountId:account.id,symbol:'EXAMPLE'});
    await page.route('**/functions/v1/get-quotes',async route=>{
      const b=route.request().postDataJSON();actions.push(b);let automatic=null;
      if(b.action==='automap'){
        if(b.symbol==='EXAMPLE'){items.push({accountId:account.id,symbol:b.symbol,mapping:{providerSymbol:b.symbol,mic:'XNGS'},valid:true,quote:null,cacheStatus:'missing'});automatic={code:'matched'};}
        else automatic={code:'review',message:'No exact supported listing; review manually.'};
      }
      if(b.action==='refresh'){const item=items.find(i=>i.symbol===b.holdings[0].symbol);item.error={code:'not_found',message:'Synthetic quote unavailable.'};}
      await route.fulfill({contentType:'application/json',body:JSON.stringify({configured:true,items,automatic})});
    });
    await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Prices',exact:true}).click();
    await page.getByLabel('Market data provider',{exact:true}).click();await page.getByRole('option',{name:'Twelve Data — individual quotes'}).click();
    const start=page.getByRole('button',{name:'Set up and refresh all quotes'});
    await start.click();await expect.poll(()=>actions.filter(a=>a.action==='automap').length).toBe(1);
    await page.getByRole('button',{name:'Stop bulk refresh'}).click();await expect(start).toBeEnabled();
    await start.click();await expect(page.getByText('Finished. Review any exceptions below.',{exact:true})).toBeVisible({timeout:40000});
    expect(actions.filter(a=>a.action==='automap'&&a.symbol==='EXAMPLE')).toHaveLength(1);
    await expect(page.getByText('exceptions needing review',{exact:false})).toBeVisible();
    await page.getByRole('button',{name:'Review mapping',exact:true}).first().click();await expect(page.getByLabel('Provider symbol',{exact:true})).not.toHaveValue('');
    expect(await store.readState()).toEqual(before);
    await page.screenshot({path:'test-results/quotes-bulk.png',fullPage:true});
  }finally{await client.auth.signOut();}
});

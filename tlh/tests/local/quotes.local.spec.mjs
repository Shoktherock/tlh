import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {sampleFiles} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {quoteService,quoteRepository} from '../../server/quote-service.mjs';
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};

test('quote mapping, cache persistence, provider valuation and fallback work without changing imported evidence',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`;
  const raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const clients=[],users=[];for(let i=0;i<2;i++){const user=(await good(admin.auth.admin.createUser({email:`quotes-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;users.push(user);const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));clients.push(client);}
  const [client,other]=clients,store=supabaseStore(client),providerSymbol=`TST${randomUUID().replaceAll('-','').slice(0,12).toUpperCase()}`,key=`twelve-data:${providerSymbol}:XNAS:USD`;
  try{
    const portfolio=await good(client.from('portfolios').insert({user_id:users[0].id,name:'Synthetic quote validation'}).select().single());
    const account=await good(client.from('accounts').insert({user_id:users[0].id,portfolio_id:portfolio.id,label:'Quote test',broker:'schwab',account_type:'taxable'}).select().single());
    const plan=await store.buildPreview(await store.readState(),await Promise.all(sampleFiles().map(readSource)),{accountId:account.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await store.commitImport(plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic quote setup.'});
    const before=await store.readState(),accountId=account.id;
    const unauth=await fetch(`${config.url}/functions/v1/get-quotes`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"read"}'});expect(unauth.status).toBe(401);
    await page.route('**/functions/v1/get-quotes',async route=>route.fulfill({contentType:'application/json',body:JSON.stringify(await quoteService(quoteRepository(admin),users[0].id,route.request().postDataJSON(),{}))}));
    await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(users[0].email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Prices',exact:true}).click();await page.getByLabel('Market data provider',{exact:true}).click();await page.getByRole('option',{name:'Twelve Data — individual quotes',exact:true}).click();
    await expect(page.getByText('Live quotes are not configured.',{exact:false})).toBeVisible();
    await page.getByLabel('Quote holding',{exact:true}).click();await page.getByRole('option',{name:'Quote test / EXAMPLE',exact:true}).click();await page.getByLabel('Provider symbol',{exact:true}).fill(providerSymbol);await page.getByLabel('Quote exchange',{exact:true}).click();await page.getByRole('option',{name:'NASDAQ (XNAS)',exact:true}).click();
    await expect(page.getByRole('button',{name:'Save quote mapping'})).toBeDisabled();await page.getByLabel('I checked that this symbol and exchange identify my holding in USD.').check();await page.getByRole('button',{name:'Save quote mapping'}).click();await expect(page.getByText(`Saved mapping: ${providerSymbol} / XNAS. Cache: missing.`)).toBeVisible();
    await expect(page.getByRole('button',{name:'Refresh selected quote'})).toBeDisabled();
    expect((await good(other.from('quote_mappings').select('*'))).length).toBe(0);
    await expect(supabaseStore(other).quotes({action:'map',accountId,symbol:'EXAMPLE',providerSymbol,mic:'XNAS',reviewed:true})).rejects.toThrow(/active holding/);
    expect((await other.from('price_cache').insert({key})).error).toBeTruthy();expect((await other.rpc('claim_quote_request',{p_key:key})).error).toBeTruthy();
    const missing=await quoteService(quoteRepository(admin),users[0].id,{action:'refresh',holdings:[{accountId,symbol:'EXAMPLE'}]},{});expect(missing.items[0].error.code).toBe('unconfigured');

    // The provider transport is synthetic; the normalization, cache RPC and PostgreSQL
    // are real. This fixture can never call an external provider or price real holdings.
    const fixtureTime=new Date(Date.now()-20*60000).toISOString();
    const result=await quoteService(quoteRepository(admin),users[0].id,{action:'refresh',holdings:[{accountId,symbol:'EXAMPLE'}]},{apiKey:'synthetic-test-only',now:()=>fixtureTime,fetchImpl:async()=>new Response(JSON.stringify({symbol:providerSymbol,mic_code:'XNAS',currency:'USD',close:'90',last_quote_at:Math.floor(Date.parse(fixtureTime)/1000)}))});
    expect(result.items[0].quote.price).toBe('90');expect((await good(other.from('price_cache').select('price').eq('key',key))).at(0).price).toBe('90');
    await page.getByRole('button',{name:'Reload cached quotes'}).click();
    const row=page.getByRole('table',{name:'Position valuations'}).getByRole('row').filter({has:page.getByRole('button',{name:'Set price Quote test EXAMPLE',exact:true})});await expect(row).toContainText('Twelve Data');await expect(row).toContainText('-20');await expect(row).toContainText('Older than 15 min');
    await page.getByRole('button',{name:'Inspect valuation Quote test EXAMPLE'}).click();await expect(page.getByText(/Retrieved:/)).toBeVisible();await expect(page.getByRole('table',{name:'Lot valuations'}).getByRole('row')).toHaveCount(3);await page.getByRole('button',{name:'Close valuation'}).click();
    await page.getByRole('button',{name:'Set price Quote test EXAMPLE',exact:true}).click();await page.getByLabel('Scenario price',{exact:true}).fill('80');await page.getByLabel('Price currency',{exact:true}).fill('USD');await page.getByLabel('Price reference',{exact:true}).fill('Synthetic fallback');await page.getByRole('button',{name:'Apply scenario price'}).click();await expect(row).toContainText('Scenario fallback');await expect(row).toContainText('-40');
    await page.screenshot({path:'test-results/quotes-signed-in.png',fullPage:true,animations:'disabled'});
    await page.reload();await page.getByRole('button',{name:'Prices',exact:true}).click();await page.getByLabel('Market data provider',{exact:true}).click();await page.getByRole('option',{name:'Twelve Data — individual quotes',exact:true}).click();await expect(row).toContainText('Twelve Data');await expect(row).toContainText('-20');
    // Browser transport contract: enabled refresh and a failed sibling. Actual
    // provider transport and quota behavior are covered separately above/core/SQL.
    const mocked=await store.quotes({action:'read',provider:'twelve-data'});mocked.configured=true;mocked.items.push({accountId,symbol:'FUND',mapping:{providerSymbol:'SYNTHETICFUND',mic:'ARCX'},valid:true,quote:null,cacheStatus:'missing',error:null});
    const requests=[];
    await page.route('**/functions/v1/get-quotes',async route=>{
      const body=route.request().postDataJSON();requests.push(body);
      if(body.action==='refresh')for(const requested of body.holdings){const item=mocked.items.find(i=>i.symbol===requested.symbol);if(item.symbol==='EXAMPLE'){item.quote={...item.quote,price:'95',observedAt:new Date().toISOString(),fetchedAt:new Date().toISOString()};item.cacheStatus='fresh';item.error=null;}else item.error={code:'not_found',message:'Provider has no quote for this mapping.'};}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(mocked)});
    });
    await page.getByRole('button',{name:'Reload cached quotes'}).click();await page.getByLabel('Quote holding',{exact:true}).click();await page.getByRole('option',{name:'Quote test / EXAMPLE',exact:true}).click();
    await page.getByRole('button',{name:'Refresh selected quote'}).click();await expect(row).toContainText('-10');await expect(row).toContainText('Within 15 min');
    await page.getByRole('button',{name:'Refresh next 1 missing or stale quotes'}).click();await expect(page.getByText('Quote test / FUND: Provider has no quote for this mapping.')).toBeVisible();await expect(row).toContainText('-10');
    expect(requests.filter(r=>r.action==='refresh').map(r=>r.holdings[0].symbol)).toEqual(['EXAMPLE','FUND']);
    await page.unroute('**/functions/v1/get-quotes');
    expect(await store.readState()).toEqual(before);
    await store.quotes({action:'unmap',accountId,symbol:'EXAMPLE'});expect((await store.quotes({action:'read',provider:'twelve-data'})).items.length).toBe(0);
  }finally{await admin.from('price_cache').delete().eq('key',key);for(const c of clients)await c.auth.signOut();}
});

import {temporaryDailyBatch} from './temporary-market-cache.mjs';
import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {sampleFiles} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
import {universeTemplate} from '../../src/analysis/replacements.mjs';
const good=async p=>{const r=await p;if(r.error)throw Error(r.error.message);return r.data;};
test('review universe, save strategy, compare and reload without changing holdings or activity',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`,raw=JSON.parse(execFileSync('supabase.exe',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),user=(await good(admin.auth.admin.createUser({email:`replacement-${randomUUID()}@example.test`,password,email_confirm:true}))).user;
  const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));const store=supabaseStore(client);
  let restoreMarket=async()=>{};
  try{
    const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:'Synthetic replacements'}).select().single());
    const account=await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label:'Replacement test',broker:'schwab',account_type:'taxable'}).select().single());
    const plan=await store.buildPreview(await store.readState(),await Promise.all(sampleFiles().map(readSource)),{accountId:account.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await store.commitImport(plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic replacement setup'});
    const before=await store.readState(),activity=await store.activity({action:'read'}),document=universeTemplate();document.members.forEach(m=>m.benchmarkWeight=.5);
    const date='2026-09-10';
    restoreMarket=await temporaryDailyBatch(admin,date,{EXAMPLE:{price:'100',barAt:date+'T20:00:00Z'}});
    const bars=Array.from({length:151},(_,i)=>({date:new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10),close:100*Math.exp(i*.001+Math.sin(i)*.01)}));
    for(const symbol of ['EXAMPLE','EXAMPLEB'])for(const kind of ['profile','history'])await good(admin.from('replacement_metric_cache').upsert({symbol,as_of:date,kind,payload:kind==='profile'?{identityVersion:1,industry:'1000',marketCap:1000000}:{bars}}));
    await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:/^Opportunities/}).click();await page.getByRole('button',{name:'Compare a holding',exact:true}).click();
    await page.getByText(/Benchmark setup & portfolio exclusions/).click();await page.getByLabel('Universe JSON',{exact:true}).setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});
    await expect(page.getByRole('button',{name:'Accept universe version'})).toBeDisabled();await page.getByLabel('I reviewed the source, provenance, dates and member data.').check();await page.getByRole('button',{name:'Accept universe version'}).click();await expect(page.getByText('Immutable universe version saved. Select it below.')).toBeVisible();
    await page.getByRole('combobox',{name:'Replacement portfolio',exact:true}).click();await page.getByRole('option',{name:'Synthetic replacements',exact:true}).click();
    await page.getByRole('combobox',{name:'Membership universe version',exact:true}).click();await page.getByRole('option',{name:/Synthetic Russell 3000/}).click();await page.getByLabel('I reviewed this portfolio universe and exclusions.').check();await page.getByRole('button',{name:'Save replacement strategy',exact:true}).click();await expect(page.getByText('Portfolio strategy saved with an audit revision.')).toBeVisible();
    await page.getByRole('combobox',{name:'Source holding',exact:true}).click();await page.getByRole('option',{name:'Replacement test / EXAMPLE',exact:true}).click();await page.getByLabel('Replacement analysis date',{exact:true}).fill(date);await page.getByLabel('Proposed replacement amount (USD)',{exact:true}).fill('20');await page.getByRole('button',{name:'Compare replacements',exact:true}).click();
    const table=page.getByRole('table',{name:'Replacement candidates'});await expect(table).toContainText('EXAMPLEB');await page.getByText('Explain EXAMPLEB',{exact:true}).click();await expect(table).toContainText('returns: 100.00% match');await expect(table).toContainText('99.000 / 100');
    await page.getByRole('combobox',{name:'Scoring strategy',exact:true}).click();await page.getByRole('option',{name:'Stay close to index — IWV equity proxy',exact:true}).click();await expect(table).not.toBeVisible();await page.getByRole('button',{name:'Compare replacements',exact:true}).click();await expect(table).toContainText('EXAMPLEB');await page.getByText('Explain EXAMPLEB',{exact:true}).click();await expect(table).toContainText('Change in squared weight deviation');
    await page.getByRole('button',{name:'Refresh ranking evidence',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'4 / 4'})).toContainText('4 / 4');await expect(table).toContainText('EXAMPLEB');
    const saved=await store.replacements({action:'read'}),source={text:JSON.stringify(document),name:'same.json'};const preview=(await store.replacements({action:'preview',...source})).preview;
    expect((await store.replacements({action:'accept',...source,hash:preview.hash,reviewed:true})).duplicate).toBe(true);
    await expect(store.replacements({action:'select',portfolioId:portfolio.id,universeId:saved.universes[0].id,baseRevision:0,exclusions:[],reviewed:true})).rejects.toThrow(/changed|stale/i);
    expect(await store.readState()).toEqual(before);expect(await store.activity({action:'read'})).toEqual(activity);
    await page.screenshot({path:'test-results/replacements-signed-in.png',fullPage:true});
    await expect(page.getByRole('list',{name:'Top replacement shortlist'})).toContainText('alignment of covered holdings');
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:'test-results/ux-review-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1100});
    await page.reload();await page.getByRole('button',{name:/^Opportunities/}).click();await page.getByRole('button',{name:'Compare a holding',exact:true}).click();await page.getByText(/Benchmark setup & portfolio exclusions/).click();await page.getByRole('combobox',{name:'Replacement portfolio',exact:true}).click();await page.getByRole('option',{name:'Synthetic replacements',exact:true}).click();await expect(page.getByText(/Saved strategy revision: 1/)).toBeVisible();
    // Exercise the edge runtime with an index-sized universe, not only two symbols.
    const large={...document,name:'Synthetic 3000-member CPU regression',members:[...document.members,...Array.from({length:2998},(_,i)=>({...document.members[1],symbol:`TEST${i}`}))].map(m=>({...m,benchmarkWeight:1/3000}))};
    const largeSource={name:'large.json',text:JSON.stringify(large)},lp=(await store.replacements({action:'preview',...largeSource})).preview;
    const lu=(await store.replacements({action:'accept',...largeSource,hash:lp.hash,reviewed:true})).universe;
    await store.replacements({action:'select',portfolioId:portfolio.id,universeId:lu.id,baseRevision:1,exclusions:[],reviewed:true});
    for(const mode of ['stock','index']){const result=await store.replacements({action:'compare',portfolioId:portfolio.id,accountId:account.id,symbol:'EXAMPLE',date,mode,amount:'20',poolLimit:150});expect(result.rows).toHaveLength(2999);expect(result.scoring.mode).toBe(mode);}
  }finally{try{await restoreMarket();}finally{await client.auth.signOut();}}
});



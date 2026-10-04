import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {sampleFiles} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
import {defaultInputs} from '../../src/analysis/inputs.mjs';
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};

test('analysis assumptions preview/save/reload and reviewed backup restore remain isolated from holdings and other users',async({page})=>{
  const config=localSupabase(),password=`Synthetic-${randomUUID()}-Aa7!`;
  const raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),people=[];
  for(let n=0;n<2;n++){
    const user=(await good(admin.auth.admin.createUser({email:`inputs-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;
    const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));
    const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:`Synthetic inputs ${n+1}`}).select().single()),accounts=[];
    for(const [label,type] of [['Taxable test','taxable'],['IRA test','traditional_ira']])accounts.push(await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label,broker:'schwab',account_type:type}).select().single()));
    people.push({user,client,accounts,portfolio,store:supabaseStore(client)});
  }
  const [a,b]=people;
  try{
    const plan=await a.store.buildPreview(await a.store.readState(),await Promise.all(sampleFiles().map(readSource)),{accountId:a.accounts[0].id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await a.store.commitImport(plan,{symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic analysis inputs baseline.'});
    const holdingsBefore=await a.store.readState(),initial=await a.store.analysis({action:'read'});expect(initial.revision).toBe(0);expect(initial.input).toBeNull();
    const invalid=defaultInputs(initial.accounts);invalid.rates.federalShort='101';await expect(a.store.analysis({action:'prepare',input:invalid,baseRevision:0,reason:'Invalid rate'})).rejects.toThrow(/between 0 and 100/);
    await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(a.user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Analysis inputs',exact:true}).click();
    await expect(page.getByLabel('Assumed federal short-term rate (%)',{exact:true})).toHaveValue('');
    await page.getByLabel('Proposed analysis date').fill('2026-09-15');await page.getByLabel('Assumed federal short-term rate (%)',{exact:true}).fill('20.0000');await page.getByLabel('Assumed federal long-term rate (%)',{exact:true}).fill('15');await page.getByLabel('Assumed state rate (%)',{exact:true}).fill('0');await page.getByLabel('Minimum loss amount',{exact:true}).fill('100');
    await page.getByLabel('Include Taxable test',{exact:true}).click();await page.getByRole('option',{name:'Include',exact:true}).click();await page.getByLabel('Include IRA test',{exact:true}).click();await page.getByRole('option',{name:'Omit',exact:true}).click();await page.getByLabel('Account reason IRA test').fill('Records are not available');
    await page.getByLabel('History availability Taxable test').click();await page.getByRole('option',{name:'Some records available — not imported',exact:true}).click();await page.getByLabel('History start Taxable test').fill('2026-01-01');await page.getByLabel('History end Taxable test').fill('2026-09-15');await page.getByLabel('History source Taxable test').fill('Synthetic activity statement');
    await page.getByLabel('Reason for saving inputs').fill('Synthetic planning validation');await page.getByRole('button',{name:'Preview input changes'}).click();
    await expect(page.getByRole('table',{name:'Analysis input changes'})).toContainText('20%');expect((await a.store.analysis({action:'read'})).revision).toBe(0);await expect(page.getByRole('button',{name:'Confirm input changes'})).toBeDisabled();
    await page.getByLabel('I reviewed these assumptions and account declarations; history is still unverified.').check();await page.getByRole('button',{name:'Confirm input changes'}).click();await expect(page.getByText('Analysis inputs saved at revision 1. Imported holdings are unchanged.')).toBeVisible();
    const saved=await a.store.analysis({action:'read'});expect(saved.input.rates).toEqual({federalShort:'20',federalLong:'15',state:'0'});expect(saved.history[0].user_id).toBe(a.user.id);expect(saved.input.accounts.find(r=>r.accountId===a.accounts[0].id).history.status).toBe('partial_available');
    await page.reload();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Analysis inputs',exact:true}).click();await expect(page.getByLabel('Assumed federal short-term rate (%)',{exact:true})).toHaveValue('20');await expect(page.getByLabel('Include IRA test')).toContainText('Omit');
    await page.screenshot({path:'test-results/analysis-inputs-saved.png',fullPage:true,animations:'disabled'});
    expect((await b.store.analysis({action:'read'})).input).toBeNull();expect(await good(b.client.from('analysis_inputs').select('*'))).toEqual([]);expect(await good(b.client.from('analysis_input_events').select('*'))).toEqual([]);expect((await a.client.from('analysis_inputs').update({revision:99}).eq('user_id',a.user.id)).error).toBeTruthy();expect((await a.client.from('analysis_input_events').delete().eq('user_id',a.user.id)).error).toBeTruthy();
    expect((await a.client.rpc('commit_analysis_inputs',{p_user:a.user.id,p_prepared:randomUUID()})).error).toBeTruthy();
    const next=structuredClone(saved.input);next.minLoss.amount='200';const request={action:'prepare',input:next,baseRevision:1,reason:'Synthetic concurrent update'};
    const p1=(await a.store.analysis(request)).preview,p2=(await a.store.analysis(request)).preview;
    await expect(b.store.analysis({action:'accept',preparedId:p1.preparedId,reviewed:true})).rejects.toThrow();await expect(a.store.analysis({action:'accept',preparedId:p1.preparedId,reviewed:false})).rejects.toThrow(/Review/);
    const receipt=await a.store.analysis({action:'accept',preparedId:p1.preparedId,reviewed:true});expect((await a.store.analysis({action:'accept',preparedId:p1.preparedId,reviewed:true})).receipt).toEqual(receipt.receipt);await expect(a.store.analysis({action:'accept',preparedId:p2.preparedId,reviewed:true})).rejects.toThrow(/stale/);
    // Export uses the saved server state, not stale form edits.
    const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Export analysis inputs'}).click();const download=await downloadPromise,backup=JSON.parse(await readFile(await download.path(),'utf8'));expect(backup.input.minLoss.amount).toBe('200');
    const dest=await b.store.analysis({action:'read'}),mapping=Object.fromEntries(a.accounts.map(source=>[source.id,b.accounts.find(t=>t.account_type===source.account_type).id]));
    const restored=(await b.store.analysis({action:'prepare-restore',backup,mapping,baseRevision:0,reason:'Restore synthetic planning declarations'})).preview;expect(restored.kind).toBe('restore');expect((await b.store.analysis({action:'read'})).input).toBeNull();await b.store.analysis({action:'accept',preparedId:restored.preparedId,reviewed:true});expect((await b.store.analysis({action:'read'})).input.minLoss.amount).toBe('200');
    expect((await b.store.analysis({action:'read'})).history[0].provenance.mapping).toEqual(mapping);
    await expect(b.store.analysis({action:'prepare-restore',backup,mapping:{},baseRevision:1,reason:'Missing mappings'})).rejects.toThrow(/Map every/);
    // File restore UI back to revision 1 assumptions, after the revision 2 change.
    const original={...backup,input:saved.input};await page.getByLabel('Analysis inputs backup').setInputFiles({name:'analysis-inputs.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(original))});await page.getByRole('button',{name:'Reload saved inputs (clear edits)'}).click();
    for(const source of backup.accounts){await page.getByLabel(`Input destination ${source.label}`).click();await page.getByRole('option',{name:`Synthetic inputs 1 / ${source.label}`,exact:true}).click();}
    await page.getByLabel('Reason for saving inputs').fill('Restore original synthetic assumptions');await page.getByRole('button',{name:'Preview restored inputs'}).click();await expect(page.getByRole('heading',{name:'Review restored inputs'})).toBeVisible();await expect(page.getByRole('table',{name:'Analysis input changes'})).toContainText('100 USD');
    await page.getByLabel('I reviewed these assumptions and account declarations; history is still unverified.').check();await page.getByRole('button',{name:'Confirm input changes'}).click();await expect(page.getByText('Analysis inputs saved at revision 3. Imported holdings are unchanged.')).toBeVisible();expect((await a.store.analysis({action:'read'})).input.minLoss.amount).toBe('100');
    expect(await a.store.readState()).toEqual(holdingsBefore);expect((await b.store.readState()).imports).toHaveLength(0);
  }finally{for(const person of people)await person.client.auth.signOut();}
});

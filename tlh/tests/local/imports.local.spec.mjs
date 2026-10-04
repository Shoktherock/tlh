import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { localSupabase } from '../../scripts/configure-local-supabase.mjs';
import { sampleFiles, sampleSnapshot } from '../../src/sample.mjs';
import { readSource } from '../../src/import/sources.mjs';

let a,b,identityA,identityB,password,config,portfolio;
const suffix=randomUUID().slice(0,8);
async function good(request){const {data,error}=await request;if(error)throw new Error(`Synthetic request failed: ${error.code ?? error.name}`);return data;}
async function call(client,body){const {data,error}=await client.functions.invoke('imports',{body});if(error){let message='Import request failed';try{const result=await error.context.json();message=result.error ?? result.message ?? message;}catch{}throw new Error(message);}return data;}
const decisions=plan=>({symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:''});
async function account(){return good(a.from('accounts').insert({user_id:identityA.id,portfolio_id:portfolio.id,label:`Import test ${randomUUID().slice(0,8)}`,broker:'schwab',account_type:'taxable'}).select().single());}
async function stage(client,acct,files=sampleFiles()){
  const sources=await Promise.all(files.map(readSource));
  const reserved=await call(client,{action:'reserve',files:sources.map(s=>({name:s.name,hash:s.id,bytes:Buffer.byteLength(s.text)}))});
  for(let i=0;i<sources.length;i++)await good(client.storage.from('import-sources').upload(reserved.sources[i].path,new Blob([sources[i].text],{type:'application/octet-stream'}),{contentType:'application/octet-stream',upsert:false}));
  const {preview}=await call(client,{action:'prepare',sourceIds:reserved.sources.map(s=>s.id),options:{accountId:acct.id,accountLabel:acct.label,accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false}});
  return {preview,uploads:reserved.sources};
}
test.beforeAll(async()=>{
  config=localSupabase();password=`Synthetic-${randomUUID()}-Aa7!`;
  const raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  identityA=(await good(admin.auth.admin.createUser({email:`imports-a-${suffix}@example.test`,password,email_confirm:true}))).user;
  identityB=(await good(admin.auth.admin.createUser({email:`imports-b-${suffix}@example.test`,password,email_confirm:true}))).user;
  a=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});b=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});
  await good(a.auth.signInWithPassword({email:identityA.email,password}));await good(b.auth.signInWithPassword({email:identityB.email,password}));
  portfolio=await good(a.from('portfolios').insert({user_id:identityA.id,name:`Import tests ${suffix}`}).select().single());
});
test.afterAll(async()=>{await Promise.all([a?.auth.signOut(),b?.auth.signOut()]);});

test('server preview, explicit acceptance, original retention and normalized reimport',async()=>{
  const acct=await account();const {preview,uploads}=await stage(a,acct);
  expect(preview.rows.length).toBe(3);expect((await call(a,{action:'read'})).state.holdings[acct.id]).toBeUndefined();
  const accepted=await call(a,{action:'accept',preparedId:preview.preparedId,decision:decisions(preview),preview:{rows:[],options:{accountId:identityB.id}}});
  expect(Object.keys(accepted.state.holdings[acct.id])).toHaveLength(3);expect(accepted.state.holdings[acct.id].EXAMPLE.lotScope.lots).toHaveLength(2);
  expect(accepted.state.cash[acct.id].amount).toBe('12.34');
  const retry=await call(a,{action:'accept',preparedId:preview.preparedId,decision:decisions(preview)});expect(retry.importId).toBe(accepted.importId);
  expect(await (await good(a.storage.from('import-sources').download(uploads[0].path))).text()).toBe(sampleFiles()[0].text);
  const repeat=await stage(a,acct,sampleFiles().map(f=>({...f,name:`renamed-${f.name}`})));
  const duplicate=await call(a,{action:'accept',preparedId:repeat.preview.preparedId,decision:decisions(repeat.preview)});expect(duplicate.duplicate).toBe(true);
  expect(duplicate.state.imports.filter(i=>i.accountId===acct.id)).toHaveLength(1);
});
test('private originals, plans, mutation tables and acceptance RPC reject other users and direct client writes',async()=>{
  const acct=await account();const {preview,uploads}=await stage(a,acct);
  expect((await b.storage.from('import-sources').download(uploads[0].path)).error).not.toBeNull();
  await expect(call(b,{action:'accept',preparedId:preview.preparedId,decision:decisions(preview)})).rejects.toThrow('Preview unavailable');
  expect((await a.rpc('commit_import',{p_user:identityA.id,p_prepared:preview.preparedId,p_revision:0,p_record:null,p_holdings:{},p_cash:null,p_result:{}})).error).not.toBeNull();
  expect((await a.from('current_holdings').insert({user_id:identityA.id,account_id:acct.id,symbol:'FORGED',holding:{}})).error).not.toBeNull();
  await call(a,{action:'accept',preparedId:preview.preparedId,decision:decisions(preview)});
  expect((await a.storage.from('import-sources').update(uploads[0].path,new Blob(['changed'],{type:'application/octet-stream'}),{contentType:'application/octet-stream'})).error).not.toBeNull();
  await a.storage.from('import-sources').remove([uploads[0].path]);
  expect(await (await good(a.storage.from('import-sources').download(uploads[0].path))).text()).toBe(sampleFiles()[0].text);
  expect((await call(b,{action:'read'})).state.imports).toEqual([]);
  expect(await good(b.from('current_holdings').select('symbol').eq('account_id',acct.id))).toEqual([]);
  expect(await good(b.from('import_batches').select('id').eq('account_id',acct.id))).toEqual([]);
  expect((await a.from('import_batches').delete().eq('account_id',acct.id)).error).not.toBeNull();
  expect((await a.from('prepared_imports').update({plan:{}}).eq('id',preview.preparedId)).error).not.toBeNull();
});
test('two previews cannot commit against the same stale revision; partial scopes retain lots',async()=>{
  const acct=await account();const first=await stage(a,acct),second=await stage(a,acct);
  await call(a,{action:'accept',preparedId:first.preview.preparedId,decision:decisions(first.preview)});
  await expect(call(a,{action:'accept',preparedId:second.preview.preparedId,decision:decisions(second.preview)})).rejects.toThrow('stale');
  const json=structuredClone(sampleSnapshot);for(const scope of json.accounts[0].lot_scopes){scope.status='failed';scope.lots=[];scope.issues.push({code:'INCOMPLETE',severity:'error',message:'Synthetic unavailable panel',source_ref:'lots'});}
  const partial=await stage(a,acct,[{name:'partial.json',text:JSON.stringify(json)}]);
  const result=await call(a,{action:'accept',preparedId:partial.preview.preparedId,decision:decisions(partial.preview)});
  expect(result.state.holdings[acct.id].EXAMPLE.lotScope.lots).toHaveLength(2);expect(result.state.holdings[acct.id].EXAMPLE.lotCoverage).toBe('retained');
});
test('discard removes unaccepted uploads and invalidates previews without deleting accepted evidence',async()=>{
  const acct=await account();const kept=await stage(a,acct);await call(a,{action:'accept',preparedId:kept.preview.preparedId,decision:decisions(kept.preview)});
  const discarded=await stage(a,acct);await call(a,{action:'discard'});
  expect((await a.storage.from('import-sources').download(discarded.uploads[0].path)).error).not.toBeNull();
  expect((await a.storage.from('import-sources').download(kept.uploads[0].path)).error).toBeNull();
  await expect(call(a,{action:'accept',preparedId:discarded.preview.preparedId,decision:decisions(discarded.preview)})).rejects.toThrow();
});
test('checksum mismatch blocks preparation, and selection accepts only requested scopes',async()=>{
  const acct=await account();const source=await readSource(sampleFiles()[0]);
  const reserved=await call(a,{action:'reserve',files:[{name:source.name,hash:source.id,bytes:Buffer.byteLength(source.text)}]});
  await good(a.storage.from('import-sources').upload(reserved.sources[0].path,new Blob([source.text.replace('2025-01-10','2024-01-10')],{type:'application/octet-stream'}),{contentType:'application/octet-stream'}));
  await expect(call(a,{action:'prepare',sourceIds:[reserved.sources[0].id],options:{accountId:acct.id,sourceAccountRef:'synthetic-account',completeAccount:false,currency:'USD'}})).rejects.toThrow('checksum');
  expect((await call(a,{action:'read'})).state.holdings[acct.id]).toBeUndefined();
  const {preview}=await stage(a,acct,sampleFiles().map(f=>({...f,text:'\uFEFF'+f.text})));
  const result=await call(a,{action:'accept',preparedId:preview.preparedId,decision:{...decisions(preview),symbols:['FUND'],includeCash:false}});
  expect(Object.keys(result.state.holdings[acct.id])).toEqual(['FUND']);expect(result.state.cash[acct.id]).toBeUndefined();
});
test('full-size synthetic snapshot persists 408 holdings and 787 lots without duplication',async()=>{
  const acct=await account();const snapshot=structuredClone(sampleSnapshot);const sourceAccount=snapshot.accounts[0];
  const basePosition=structuredClone(sourceAccount.positions[0]),baseScope=structuredClone(sourceAccount.lot_scopes[0]);
  sourceAccount.positions=[];sourceAccount.lot_scopes=[];const csvRows=[];
  for(let i=0;i<406;i++){
    const symbol=`SYN${String(i).padStart(4,'0')}`;const security={symbol};
    sourceAccount.positions.push({...basePosition,security,source_ref:`positions/${symbol}`});
    const scope=structuredClone(baseScope);scope.security=security;scope.source_ref=`lots/${symbol}`;
    if(i<25){scope.lots=[{...scope.lots[0],quantity:'2',total_basis:'200.00'}];scope.completeness_evidence.displayed_row_count=1;}
    sourceAccount.lot_scopes.push(scope);csvRows.push(`"${symbol}","Synthetic security","2","$200.00","$200.00","Equity",`);
  }
  const csv=`"Positions for account Synthetic ...123 as of 05:51 PM ET, 2026/09/08"\n\n"Symbol","Description","Qty (Quantity)","Cost Basis","Mkt Val (Market Value)","Asset Type",\n${csvRows.join('\n')}\n"CVRONE","Synthetic right","3","$0.00","N/A","Equity",\n"CVRTWO","Synthetic right","22","$0.00","N/A","Equity",\n"Cash & Cash Investments","--","--","--","$12.34","Cash and Money Market",\n"Positions Total","","--","$81200.00","$81212.34","--",\n`;
  const {preview}=await stage(a,acct,[{name:'large-synthetic.json',text:JSON.stringify(snapshot)},{name:'large-synthetic.csv',text:csv}]);
  expect(preview.rows).toHaveLength(408);
  const result=await call(a,{action:'accept',preparedId:preview.preparedId,decision:decisions(preview)});
  const holdings=Object.values(result.state.holdings[acct.id]);expect(holdings).toHaveLength(408);expect(holdings.reduce((n,h)=>n+(h.lotScope?.lots.length ?? 0),0)).toBe(787);
});
test('database failure after audit insertion rolls back the whole acceptance transaction',async()=>{
  const acct=await account();const {preview,uploads}=await stage(a,acct);
  const run=sql=>execFileSync(process.platform==='win32'?'docker.exe':'docker',['exec','-i','supabase_db_tlh2','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']});
  run(`create function public.tlh_test_failure() returns trigger language plpgsql as $$ begin if new.account_id='${acct.id}'::uuid then raise exception 'Synthetic write failure'; end if; return new; end $$; create trigger tlh_test_failure before insert on public.current_holdings for each row execute function public.tlh_test_failure();`);
  try{await expect(call(a,{action:'accept',preparedId:preview.preparedId,decision:decisions(preview)})).rejects.toThrow();}
  finally{run('drop trigger tlh_test_failure on public.current_holdings; drop function public.tlh_test_failure();');}
  const state=(await call(a,{action:'read'})).state;expect(state.holdings[acct.id]).toBeUndefined();expect(state.imports.some(i=>i.accountId===acct.id)).toBe(false);
  const rows=await good(a.from('import_sources').select('status').in('id',uploads.map(s=>s.id)));expect(rows.every(r=>r.status==='prepared')).toBe(true);
  const retry=await call(a,{action:'accept',preparedId:preview.preparedId,decision:decisions(preview)});expect(retry.state.holdings[acct.id].EXAMPLE.lotScope.lots).toHaveLength(2);
});
test('persistent browser import accepts, reloads, and reviews the private original',async({page},info)=>{
  const acct=await account();
  await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(identityA.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByText('Holdings import review & manual file selection',{exact:true}).click();await page.getByRole('button',{name:'Try synthetic sample files'}).click();
  await page.getByRole('combobox',{name:'Target account'}).click();await page.getByRole('option',{name:acct.label,exact:false}).click();
  await page.getByRole('button',{name:'Build preview',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review & accept'})).toBeVisible();
  await page.getByLabel('I reviewed all source account labels',{exact:false}).check();await page.getByLabel('I reviewed source times',{exact:false}).check();
  await page.getByRole('button',{name:'Accept selected scopes',exact:true}).click();await expect(page.getByText('Import accepted.',{exact:false})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'History',exact:true}).click();
  await page.getByRole('button',{name:'Review import'}).first().click();await page.getByRole('button',{name:'View original source'}).first().click();await expect(page.locator('pre')).toContainText('schema_version');
  await page.screenshot({path:info.outputPath('persistent-original.png'),fullPage:true});
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Reconciliation',exact:true}).click();
  await page.getByRole('combobox',{name:'Filter account'}).click();await page.getByRole('option',{name:acct.label,exact:false}).click();
  await page.getByRole('button',{name:'Review 000CVR000: No complete lot snapshot'}).click();
  await page.getByRole('button',{name:'View original position',exact:true}).click();await expect(page.getByRole('dialog').locator('pre')).toContainText('Positions for account Synthetic');
});

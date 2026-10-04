import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {sampleFiles,sampleSnapshot} from '../../src/sample.mjs';
import {readSource,hash} from '../../src/import/sources.mjs';
import {emptyState,previewImport,acceptPreview} from '../../src/import/engine.mjs';
import {exportBackup,validateBackup} from '../../src/import/recovery.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';

let a,b,identity,password,portfolio,local,backup,store;
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};
const call=async(client,body)=>{const {data,error}=await client.functions.invoke('imports',{body});if(error){let message='Request failed';try{message=(await error.context.json()).error??message;}catch{}throw new Error(message);}return data;};
const decide=plan=>({symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic saved review.'});
async function account(label='Recovery destination'){return good(a.from('accounts').insert({user_id:identity.id,portfolio_id:portfolio.id,label:`${label} ${randomUUID().slice(0,8)}`,broker:'schwab',account_type:'taxable'}).select().single());}
async function upload(text){
  const {sources}=await call(a,{action:'reserve',files:[{name:'backup.json',hash:await hash(text),bytes:Buffer.byteLength(text)}]});
  await good(a.storage.from('import-sources').upload(sources[0].path,new Blob([text],{type:'application/octet-stream'}),{contentType:'application/octet-stream'}));return sources[0];
}
test.beforeAll(async()=>{
  const config=localSupabase();password=`Synthetic-${randomUUID()}-Aa7!`;
  const raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const make=async name=>{const user=(await good(admin.auth.admin.createUser({email:`recovery-${name}-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));return {user,client};};
  const alice=await make('a'),bob=await make('b');a=alice.client;b=bob.client;identity=alice.user;store=supabaseStore(a);
  portfolio=await good(a.from('portfolios').insert({user_id:identity.id,name:'Recovery synthetic portfolio'}).select().single());
  const sources=await Promise.all(sampleFiles().map(f=>readSource({...f,text:'\uFEFF'+f.text})));
  const options={accountId:null,accountLabel:'Pilot account',accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false};
  const plan=await previewImport(emptyState(),sources,options);local=acceptPreview(emptyState(),plan,{...decide(plan),symbols:['EXAMPLE'],includeCash:false}).state;
  const next=await previewImport(local,sources,{...options,accountId:local.accounts[0].id});local=acceptPreview(local,next,decide(next)).state;
  backup=await exportBackup(local);
});
test.afterAll(async()=>{await a?.auth.signOut();await b?.auth.signOut();});

test('restore preserves two historical selections, original BOM bytes, cash, and repeats without duplication',async()=>{
  const target=await account();const mapping={[local.accounts[0].id]:target.id};
  const {preview}=await store.prepareRestore(backup,mapping);
  expect((await store.readState()).holdings[target.id]).toBeUndefined();expect(preview.summary[0].imports).toBe(2);
  const accepted=await store.acceptRestore(preview.preparedId,true);expect(accepted.restoredImports).toBe(2);
  const history=accepted.state.imports.filter(i=>i.accountId===target.id);expect(history).toHaveLength(2);expect(history[0].decisions.symbols).toEqual(['EXAMPLE']);expect(history[0].acceptedAt).toBe(local.imports[0].acceptedAt);
  expect(Object.keys(accepted.state.holdings[target.id])).toHaveLength(3);expect(accepted.state.cash[target.id].amount).toBe('12.34');
  expect(await store.readSource(history[0].sources[0])).toBe(local.imports[0].sources[0].text);
  expect((await store.acceptRestore(preview.preparedId,true)).restoredImports).toBe(2);
  expect((await store.prepareRestore(backup,mapping)).duplicate).toBe(true);
  expect((await validateBackup(JSON.parse(await store.exportBackup()))).summary.find(s=>s.id===target.id).imports).toBe(2);
});

test('server rejects forged backups, cross-user restores, occupied destinations and unreviewed acceptance',async()=>{
  const target=await account();const mapping={[local.accounts[0].id]:target.id};
  const forged=JSON.parse(backup);forged.state.cash[local.accounts[0].id].amount='900000';const bad=await upload(JSON.stringify(forged));
  await expect(call(a,{action:'prepare-restore',sourceId:bad.id,mapping})).rejects.toThrow('do not match');
  const {preview}=await store.prepareRestore(backup,mapping);
  await expect(call(b,{action:'resume',kind:'restore',preparedId:preview.preparedId})).rejects.toThrow();
  await expect(call(b,{action:'accept-restore',preparedId:preview.preparedId,reviewed:true})).rejects.toThrow();
  await expect(store.acceptRestore(preview.preparedId,false)).rejects.toThrow('Review');
  expect((await a.from('prepared_restores').select('*')).error).not.toBeNull();expect((await a.rpc('commit_restore',{p_user:identity.id,p_prepared:preview.preparedId})).error).not.toBeNull();
  await store.acceptRestore(preview.preparedId,true);
  const different=JSON.parse(backup);different.state.imports[0].decisions.reason='A distinct saved note';const changed=await upload(JSON.stringify(different));
  await expect(call(a,{action:'prepare-restore',sourceId:changed.id,mapping})).rejects.toThrow('empty');
});

test('stale and discarded restore plans cannot change holdings',async()=>{
  const first=await account(),second=await account();
  const one=await store.prepareRestore(backup,{[local.accounts[0].id]:first.id});
  const two=await store.prepareRestore(backup,{[local.accounts[0].id]:second.id});
  await store.acceptRestore(one.preview.preparedId,true);
  await expect(store.acceptRestore(two.preview.preparedId,true)).rejects.toThrow('stale');
  expect((await store.readState()).holdings[second.id]).toBeUndefined();
  const fresh=await store.prepareRestore(backup,{[local.accounts[0].id]:second.id});
  await store.discard();await expect(store.resume(fresh.preview.preparedId,'restore')).rejects.toThrow();
  await expect(store.acceptRestore(fresh.preview.preparedId,true)).rejects.toThrow();expect((await store.readState()).holdings[second.id]).toBeUndefined();
});

test('multi-account restore rolls back all history and holdings after a forced database failure',async()=>{
  const sources=await Promise.all(sampleFiles().map(readSource));
  const plan=await previewImport(local,sources,{accountId:null,accountLabel:'Second pilot',accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});
  const two=acceptPreview(local,plan,decide(plan)).state;const text=await exportBackup(two);const targets=[await account(),await account()];
  const mapping=Object.fromEntries(two.accounts.map((acct,i)=>[acct.id,targets[i].id]));
  const {preview}=await store.prepareRestore(text,mapping);
  const run=sql=>execFileSync(process.platform==='win32'?'docker.exe':'docker',['exec','-i','supabase_db_tlh2','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']});
  run(`create function public.tlh_restore_test_failure() returns trigger language plpgsql as $$ begin if new.account_id='${targets[1].id}'::uuid then raise exception 'Synthetic restore failure'; end if; return new; end $$; create trigger tlh_restore_test_failure before insert on public.current_holdings for each row execute function public.tlh_restore_test_failure();`);
  try{await expect(store.acceptRestore(preview.preparedId,true)).rejects.toThrow();}finally{run('drop trigger tlh_restore_test_failure on public.current_holdings; drop function public.tlh_restore_test_failure();');}
  const state=await store.readState();for(const t of targets){expect(state.holdings[t.id]).toBeUndefined();expect(state.imports.some(i=>i.accountId===t.id)).toBe(false);}
  expect((await store.acceptRestore(preview.preparedId,true)).restoredImports).toBe(3);
});

test('interrupted upload reuses verified files and a saved preview resumes after reload',async({page})=>{
  const target=await account('Resume');const source=await readSource(sampleFiles()[0]);
  const reserved=await call(a,{action:'reserve',reuse:true,files:[{name:source.name,hash:source.id,bytes:Buffer.byteLength(source.text)}]});
  await good(a.storage.from('import-sources').upload(reserved.sources[0].path,new Blob([source.text],{type:'application/octet-stream'}),{contentType:'application/octet-stream'}));
  const sources=await Promise.all(sampleFiles().map(readSource));
  const preview=await store.buildPreview(await store.readState(),sources,{accountId:target.id,currency:'USD',completeAccount:false,sourceAccountRef:'synthetic-account'});
  expect(preview.sources.some(s=>s.objectId===reserved.sources[0].id)).toBe(true);
  await expect(supabaseStore(b).resume(preview.preparedId)).rejects.toThrow();
  await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(identity.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Recovery',exact:true}).click();await page.getByText(`Import preview · ${target.label}`,{exact:false}).locator('..').getByRole('button',{name:'Resume import preview'}).click();
  await expect(page.getByRole('heading',{name:'Review & accept'})).toBeVisible();await expect(page.getByRole('button',{name:'Accept selected scopes'})).toBeDisabled();
  await page.reload();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Recovery',exact:true}).click();await page.getByText(`Import preview · ${target.label}`,{exact:false}).locator('..').getByRole('button',{name:'Resume import preview'}).click();
  await page.getByLabel('I reviewed all source account labels',{exact:false}).check();await page.getByLabel('I reviewed source times',{exact:false}).check();await page.getByRole('button',{name:'Accept selected scopes'}).click();await expect(page.getByText('Import accepted.',{exact:false})).toBeVisible();
});

test('browser-local inspection, reviewed migration, and backup download work end to end',async({page},info)=>{
  const target=await account('Browser restore');
  await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(identity.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.evaluate(state=>new Promise((resolve,reject)=>{const request=indexedDB.open('tlh-import-pilot-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('portfolio');request.onsuccess=()=>{const db=request.result;const tx=db.transaction('portfolio','readwrite');tx.objectStore('portfolio').put(state,'current');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};request.onerror=reject;}),local);
  await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Recovery',exact:true}).click();await page.getByRole('button',{name:'Inspect browser-local imports'}).click();
  await page.getByRole('combobox',{name:'Destination for Pilot account'}).click();await page.getByRole('option',{name:target.label,exact:false}).click();await page.getByRole('button',{name:'Build restore preview'}).click();
  await expect(page.getByRole('heading',{name:'Review restore'})).toBeVisible();await expect(page.getByRole('button',{name:'Accept restore'})).toBeDisabled();
  await page.screenshot({path:info.outputPath('restore-preview.png'),fullPage:true});
  await page.getByLabel('I reviewed the backup, saved decisions',{exact:false}).check();await page.getByRole('button',{name:'Accept restore'}).click();await expect(page.getByText('Restore complete.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Reconciliation',exact:true}).click();await page.getByRole('combobox',{name:'Filter account'}).click();await page.getByRole('option',{name:target.label,exact:false}).click();
  await page.getByRole('button',{name:'Review EXAMPLE: Lot effective date is unknown'}).click();await expect(page.getByRole('dialog')).toContainText('Restored from a backup');
  await page.getByRole('button',{name:'View original accepted lots'}).click();await expect(page.getByRole('dialog').locator('pre')).toContainText('schema_version');
  await page.getByRole('button',{name:'Close evidence'}).click();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Recovery',exact:true}).click();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export imports backup'}).click();const file=await download;expect(file.suggestedFilename()).toBe('tlh-portfolio-backup.json');
  const stream=await file.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);expect((await validateBackup(JSON.parse(Buffer.concat(chunks).toString()))).summary.some(s=>s.id===target.id)).toBe(true);
  await page.reload();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Recovery',exact:true}).click();await page.getByLabel('Portfolio backup').setInputFiles({name:'local-backup.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  await page.getByRole('combobox',{name:'Destination for Pilot account'}).click();await page.getByRole('option',{name:target.label,exact:false}).click();await page.getByRole('button',{name:'Build restore preview'}).click();await expect(page.getByText('This backup was already restored',{exact:false})).toBeVisible();
});

test('full-size backup restores 408 holdings and 787 lots and can be exported again',async()=>{
  const snapshot=structuredClone(sampleSnapshot);const acct=snapshot.accounts[0];const position=structuredClone(acct.positions[0]),scope=structuredClone(acct.lot_scopes[0]);
  acct.positions=[];acct.lot_scopes=[];const rows=[];
  for(let i=0;i<406;i++){
    const symbol=`REC${String(i).padStart(4,'0')}`,security={symbol};acct.positions.push({...position,security,source_ref:`positions/${symbol}`});
    const lots=structuredClone(scope);lots.security=security;lots.source_ref=`lots/${symbol}`;
    if(i<25){lots.lots=[{...lots.lots[0],quantity:'2',total_basis:'200.00'}];lots.completeness_evidence.displayed_row_count=1;}
    acct.lot_scopes.push(lots);rows.push(`"${symbol}","Synthetic security","2","$200.00","$200.00","Equity",`);
  }
  const csv=`"Positions for account Synthetic ...123 as of 05:51 PM ET, 2026/09/08"\n\n"Symbol","Description","Qty (Quantity)","Cost Basis","Mkt Val (Market Value)","Asset Type",\n${rows.join('\n')}\n"CVRONE","Synthetic right","3","$0.00","N/A","Equity",\n"CVRTWO","Synthetic right","22","$0.00","N/A","Equity",\n"Cash & Cash Investments","--","--","--","$12.34","Cash and Money Market",\n"Positions Total","","--","$81200.00","$81212.34","--",\n`;
  const sources=await Promise.all([{name:'large-helper.json',text:JSON.stringify(snapshot)},{name:'large-positions.csv',text:csv}].map(readSource));
  const plan=await previewImport(emptyState(),sources,{accountId:null,accountLabel:'Full-size pilot',accountType:'taxable',currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});
  const state=acceptPreview(emptyState(),plan,decide(plan)).state,text=await exportBackup(state),target=await account('Full-size restore');
  const {preview}=await store.prepareRestore(text,{[state.accounts[0].id]:target.id});expect(preview.summary[0].holdings).toBe(408);expect(preview.summary[0].lots).toBe(787);
  const result=await store.acceptRestore(preview.preparedId,true);expect(Object.keys(result.state.holdings[target.id])).toHaveLength(408);
  const verified=await validateBackup(JSON.parse(await store.exportBackup()));expect(verified.summary.find(s=>s.id===target.id).lots).toBe(787);
});

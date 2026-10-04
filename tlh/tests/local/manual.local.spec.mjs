import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {manualTemplate,parseManualCsv} from '../../src/import/manual.mjs';
import {readSource,hash} from '../../src/import/sources.mjs';
import {validateBackup} from '../../src/import/recovery.mjs';
import {correctionView} from '../../src/import/corrections.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';

let a,b,identity,password,portfolio,store;
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};
const call=async(client,body)=>{const {data,error}=await client.functions.invoke('imports',{body});if(error){let message='Request failed';try{message=(await error.context.json()).error??message;}catch{}throw new Error(message);}return data;};
const decide=plan=>({symbols:plan.rows.filter(r=>r.positionAction!=='retain').map(r=>r.symbol),includeCash:false,mappingReviewed:true,timingReviewed:true,reason:'Reviewed synthetic manual entry.'});
const options=id=>({accountId:id,currency:null,sourceAccountRef:'',completeAccount:false});
async function account(label='Manual'){return good(a.from('accounts').insert({user_id:identity.id,portfolio_id:portfolio.id,label:`${label} ${randomUUID().slice(0,8)}`,broker:'schwab',account_type:'taxable'}).select().single());}
async function preview(target,data){return store.buildPreview(await store.readState(),[await readSource(data?{name:'manual.json',text:JSON.stringify(data)}:{name:'manual.csv',text:manualTemplate()})],options(target.id));}
test.beforeAll(async()=>{
  const config=localSupabase();password=`Synthetic-${randomUUID()}-Aa7!`;
  const raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const make=async name=>{const user=(await good(admin.auth.admin.createUser({email:`manual-${name}-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));return {user,client};};
  const alice=await make('a'),bob=await make('b');a=alice.client;b=bob.client;identity=alice.user;store=supabaseStore(a);
  portfolio=await good(a.from('portfolios').insert({user_id:identity.id,name:'Synthetic manual validation'}).select().single());
});
test.afterAll(async()=>{await a?.auth.signOut();await b?.auth.signOut();});

test('manual form requires completeness review, stages without writes, accepts and retains duplicate lots and actor after reload',async({page})=>{
  const target=await account('Form');
  await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(identity.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Manual entry',exact:true}).click();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download manual CSV template'}).click();const file=await download;await file.saveAs('test-results/manual-template-download.csv');expect(parseManualCsv(await readFile('test-results/manual-template-download.csv','utf8')).positions).toHaveLength(2);
  await page.getByLabel('Manual target account',{exact:true}).click();await page.getByRole('option',{name:new RegExp(target.label)}).click();
  for(const [label,value] of [['Account label on source','Synthetic statement account'],['Evidence reference','Synthetic statement page 4'],['Entry reason','Transcribed synthetic broker lot evidence.'],['Manual security symbol','EXAMPLE'],['Security description','Synthetic example'],['Position quantity','2'],['Position total basis','200'],['Source currency','USD'],['Position effective date','2026-09-08']])await page.getByLabel(label,{exact:true}).fill(value);
  await page.getByLabel('Manual lot coverage',{exact:true}).click();await page.getByRole('option',{name:'Complete — every row for this security',exact:true}).click();
  await page.getByLabel('Reported lot quantity',{exact:true}).fill('2');await page.getByLabel('Reported lot basis',{exact:true}).fill('200');
  await page.getByRole('button',{name:'Add lot row',exact:true}).click();
  for(const n of [1,2])for(const [field,value] of [['acquisition date','2025-01-10'],['quantity','1'],['total basis','100'],['cost per share','100']])await page.getByLabel(`Lot ${n} ${field}`,{exact:true}).fill(value);
  await page.getByRole('button',{name:'Review as import',exact:true}).click();await expect(page.getByText('Confirm that every lot row',{exact:false})).toBeVisible();expect((await store.readState()).holdings[target.id]).toBeUndefined();
  await page.getByLabel('I checked all pages and included every lot row for this security.').check();
  await page.screenshot({path:'test-results/manual-entry-form.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Review as import',exact:true}).click();await expect(page.getByText('Manual evidence staged.',{exact:false})).toBeVisible();expect((await store.readState()).holdings[target.id]).toBeUndefined();
  await page.getByRole('button',{name:'Build preview',exact:true}).click();await expect(page.getByRole('heading',{name:'Review & accept'})).toBeVisible();await expect(page.getByRole('button',{name:'Accept selected scopes',exact:true})).toBeDisabled();
  await page.getByLabel('I reviewed all source account labels',{exact:false}).check();await page.getByLabel('I reviewed source times',{exact:false}).check();await page.getByRole('button',{name:'Accept selected scopes',exact:true}).click();await expect(page.getByText('Import accepted.',{exact:false})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'History',exact:true}).click();await page.getByRole('button',{name:'Review import',exact:true}).click();await expect(page.getByText(`Accepted by signed-in user: ${identity.id}`,{exact:true})).toBeVisible();await page.getByRole('button',{name:'View original source',exact:true}).click();await expect(page.locator('pre')).toContainText('Synthetic statement page 4');
  const state=await store.readState(),holding=state.holdings[target.id].EXAMPLE;expect(holding.lotScope.lots).toHaveLength(2);expect(holding.lotScope.lots[0].quantity).toBe('1');expect(holding.lotScope.effective_date).toBeNull();expect(holding.position.effective_date).toBe('2026-09-08');
});

test('manual CSV originals stay private, equivalent reimport is idempotent, partial lots retain accepted rows, and backup restores actor/evidence',async()=>{
  const target=await account('CSV'),plan=await preview(target),result=await store.commitImport(plan,{...decide(plan),acceptedBy:'forged-client-actor'});
  expect(result.state.imports.find(i=>i.id===result.importId).acceptedBy).toBe(identity.id);
  const original=result.state.imports.find(i=>i.id===result.importId).sources[0];expect(await store.readSource(original)).toBe(manualTemplate());await expect(supabaseStore(b).readSource(original)).rejects.toThrow();
  const repeat=await preview(target);expect((await store.commitImport(repeat,decide(repeat))).duplicate).toBe(true);
  const partial=parseManualCsv(manualTemplate());partial.positions=partial.positions.slice(0,1);partial.positions[0].lots.coverage='partial';partial.positions[0].lots.rows.pop();
  const prior=(await store.readState()).holdings[target.id];const nextPlan=await preview(target,partial);const next=(await store.commitImport(nextPlan,decide(nextPlan))).state;
  expect(next.holdings[target.id].EXAMPLE.lotScope).toEqual(prior.EXAMPLE.lotScope);expect(next.holdings[target.id].EXAMPLE.supplementalScope.lots).toHaveLength(1);expect(next.holdings[target.id].POSITION_ONLY).toEqual(prior.POSITION_ONLY);
  const backup=await store.exportBackup(),verified=await validateBackup(JSON.parse(backup)),mapping={};for(const source of verified.summary)mapping[source.id]=(await account('Restored')).id;
  const prepared=await store.prepareRestore(backup,mapping),restored=await store.acceptRestore(prepared.preview.preparedId,true);expect(restored.state.imports.filter(i=>i.accountId===mapping[target.id]).every(i=>i.acceptedBy===identity.id)).toBe(true);
  const history=restored.state.imports.find(i=>i.accountId===mapping[target.id]);expect(await store.readSource(history.sources[0])).toBe(manualTemplate());await validateBackup(JSON.parse(await store.exportBackup()));
});

test('manual server rejects malformed evidence and another user account, and later manual replacement suspends a correction',async()=>{
  const target=await account('Conflict'),plan=await preview(target);await store.commitImport(plan,decide(plan));
  const state=await store.readState();const correction=await store.prepareCorrection({baseRevision:state.revision,accountId:target.id,symbol:'EXAMPLE',target:{section:'lot',field:'total_basis',row:0},kind:'set',value:'99',reason:'Synthetic verified basis.'});await store.acceptCorrection(correction.preparedId,true);
  const changed=parseManualCsv(manualTemplate());changed.positions[0].lots.rows[0].acquisition_date='2024-01-01';const updated=await preview(target,changed);expect(updated.correctionConflicts.some(c=>c.symbol==='EXAMPLE')).toBe(true);const accepted=await store.commitImport(updated,decide(updated));expect(correctionView(accepted.state).correctionStates.find(c=>c.accountId===target.id).status).toBe('conflict');
  await expect(supabaseStore(b).buildPreview(await supabaseStore(b).readState(),[await readSource({name:'manual.csv',text:manualTemplate()})],options(target.id))).rejects.toThrow('existing accounts');
  changed.positions[0].lots.rows[0].quantity='-1';const text=JSON.stringify(changed),reserved=await call(a,{action:'reserve',files:[{name:'invalid-manual.json',hash:await hash(text),bytes:Buffer.byteLength(text)}]});await good(a.storage.from('import-sources').upload(reserved.sources[0].path,new Blob([text],{type:'application/octet-stream'}),{contentType:'application/octet-stream'}));
  await expect(call(a,{action:'prepare',sourceIds:[reserved.sources[0].id],options:options(target.id)})).rejects.toThrow('nonnegative');
});

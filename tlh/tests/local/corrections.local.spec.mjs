import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {sampleFiles,sampleSnapshot} from '../../src/sample.mjs';
import {readSource} from '../../src/import/sources.mjs';
import {correctionView} from '../../src/import/corrections.mjs';
import {validateBackup} from '../../src/import/recovery.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';

let a,b,identity,password,portfolio,store;
const good=async request=>{const {data,error}=await request;if(error)throw new Error(error.message);return data;};
const decide=plan=>({symbols:plan.rows.map(r=>r.symbol),includeCash:true,mappingReviewed:true,timingReviewed:true,reason:'Synthetic correction validation.'});
const sql=statement=>execFileSync(process.platform==='win32'?'docker.exe':'docker',['exec','-i','supabase_db_tlh2','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],{input:statement,encoding:'utf8',stdio:['pipe','pipe','pipe']});
async function account(label='Corrections'){return good(a.from('accounts').insert({user_id:identity.id,portfolio_id:portfolio.id,label:`${label} ${randomUUID().slice(0,8)}`,broker:'schwab',account_type:'taxable'}).select().single());}
async function imported(label){const target=await account(label);const plan=await store.buildPreview(await store.readState(),await Promise.all(sampleFiles().map(readSource)),{accountId:target.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await store.commitImport(plan,decide(plan));return target;}
async function prepare(target,extra={}){return store.prepareCorrection({baseRevision:(await store.readState()).revision,accountId:target.id,symbol:'EXAMPLE',target:{section:'lots',field:'effective_date'},value:'2026-09-08',kind:'set',reason:'Verified synthetic date.',...extra});}
test.beforeAll(async()=>{
  const config=localSupabase();password=`Synthetic-${randomUUID()}-Aa7!`;
  const raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const make=async name=>{const user=(await good(admin.auth.admin.createUser({email:`correction-${name}-${randomUUID().slice(0,8)}@example.test`,password,email_confirm:true}))).user;const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));return {user,client};};
  const alice=await make('a'),bob=await make('b');a=alice.client;b=bob.client;identity=alice.user;store=supabaseStore(a);
  portfolio=await good(a.from('portfolios').insert({user_id:identity.id,name:'Synthetic corrections validation'}).select().single());
});
test.afterAll(async()=>{await a?.auth.signOut();await b?.auth.signOut();});

test('correction acceptance is immutable, idempotent, revision checked and isolated across signed-in users',async()=>{
  const target=await imported('Audit');const before=await store.readState(),plan=await prepare(target),stale=await prepare(target,{target:{section:'position',field:'total_basis'},value:'199'});
  await expect(store.acceptCorrection(plan.preparedId,false)).rejects.toThrow('Review');
  await expect(supabaseStore(b).acceptCorrection(plan.preparedId,true)).rejects.toThrow();
  const accepted=await store.acceptCorrection(plan.preparedId,true);expect(accepted.state.revision).toBe(before.revision+1);
  expect(accepted.state.holdings).toEqual(before.holdings);expect(accepted.state.imports).toEqual(before.imports);
  expect(accepted.state.corrections.at(-1).actor).toBe(identity.id);
  expect((await store.acceptCorrection(plan.preparedId,true)).correctionId).toBe(accepted.correctionId);
  await expect(store.acceptCorrection(stale.preparedId,true)).rejects.toThrow('stale');
  expect((await good(b.from('correction_events').select('*')))).toEqual([]);
  expect((await a.from('correction_events').update({record:{}}).eq('id',accepted.correctionId)).error).not.toBeNull();
  expect((await a.rpc('commit_correction',{p_user:identity.id,p_prepared:plan.preparedId})).error).not.toBeNull();
  expect((await a.from('prepared_corrections').select('*')).error).not.toBeNull();
  expect(correctionView(accepted.state).holdings[target.id].EXAMPLE.lotScope.effective_date).toBe('2026-09-08');
});

test('failed correction commit rolls back its audit and revision, and the same preview can retry',async()=>{
  const target=await imported('Rollback'),plan=await prepare(target),before=await store.readState();
  sql(`create function public.tlh_correction_test_failure() returns trigger language plpgsql as $$ begin if new.user_id='${identity.id}'::uuid then raise exception 'Synthetic revision failure'; end if; return new; end $$; create trigger tlh_correction_test_failure before update on public.import_revisions for each row execute function public.tlh_correction_test_failure();`);
  try{await expect(store.acceptCorrection(plan.preparedId,true)).rejects.toThrow();}finally{sql('drop trigger tlh_correction_test_failure on public.import_revisions; drop function public.tlh_correction_test_failure();');}
  expect(await store.readState()).toEqual(before);await store.acceptCorrection(plan.preparedId,true);
});

test('changed imports suspend corrections; backup restores their audit and conflict into empty mapped accounts',async()=>{
  const target=await imported('Conflict');await store.acceptCorrection((await prepare(target)).preparedId,true);
  const changed=structuredClone(sampleSnapshot);changed.snapshot_id='changed-correction-evidence';changed.accounts[0].lot_scopes[0].lots[0].acquisition_date='2024-01-10';
  const plan=await store.buildPreview(await store.readState(),[await readSource({name:'changed.json',text:JSON.stringify(changed)})],{accountId:target.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});
  expect(plan.correctionConflicts.some(c=>c.symbol==='EXAMPLE')).toBe(true);await expect(store.commitImport(plan,{...decide(plan),reason:''})).rejects.toThrow();
  const result=await store.commitImport(plan,decide(plan));expect(correctionView(result.state).correctionStates.find(c=>c.accountId===target.id).status).toBe('conflict');
  const backup=await store.exportBackup(),verified=await validateBackup(JSON.parse(backup)),mapping={};
  for(const source of verified.summary)mapping[source.id]=(await account('Restore')).id;
  const prepared=await store.prepareRestore(backup,mapping);expect(prepared.preview.corrections.length).toBeGreaterThan(0);
  const restored=await store.acceptRestore(prepared.preview.preparedId,true);expect(restored.restoredCorrections).toBe(verified.state.corrections.length);
  const copied=correctionView(restored.state).correctionStates.find(c=>c.accountId===mapping[target.id]);expect(copied.status).toBe('conflict');expect(copied.actor).toBe(identity.id);expect(copied.restoration).toBeTruthy();
  expect((await validateBackup(JSON.parse(await store.exportBackup()))).state.corrections.length).toBe(2*verified.state.corrections.length);
  const withdraw=await prepare({id:mapping[target.id]},{kind:'revoke',previousId:copied.id,reason:'Use the latest synthetic import.'});await store.acceptCorrection(withdraw.preparedId,true);
  expect(correctionView(await store.readState()).correctionStates.some(c=>c.id===copied.id)).toBe(false);
});

test('signed-in UI previews, accepts, persists and withdraws a correction with a visible audit trail',async({page})=>{
  const target=await imported('Browser');
  await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(identity.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Corrections',exact:true}).click();
  await page.getByLabel('Correction account',{exact:true}).click();await page.getByRole('option',{name:new RegExp(target.label)}).click();
  await page.getByLabel('Correction security',{exact:true}).click();await page.getByRole('option',{name:'EXAMPLE',exact:true}).click();
  await page.getByLabel('Evidence section',{exact:true}).click();await page.getByRole('option',{name:'Lot scope',exact:true}).click();
  await page.getByLabel('Reviewed value',{exact:true}).fill('2026-09-08');await page.getByLabel('Correction reason',{exact:true}).fill('Browser test: date verified in synthetic broker evidence.');
  await page.getByRole('button',{name:'Preview correction',exact:true}).click();await expect(page.getByRole('heading',{name:'Confirm reviewed change'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Accept correction',exact:true})).toBeDisabled();
  await page.screenshot({path:'test-results/corrections-preview.png',fullPage:true,animations:'disabled'});
  await page.getByLabel('I reviewed the original value, replacement, and reason.').check();await page.getByRole('button',{name:'Accept correction',exact:true}).click();
  await expect(page.getByText('Correction recorded.',{exact:false})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Corrections',exact:true}).click();
  await page.getByLabel('Correction account',{exact:true}).click();await page.getByRole('option',{name:new RegExp(target.label)}).click();
  const card=page.locator('.history').filter({has:page.getByRole('button',{name:'Withdraw',exact:true})});await expect(card).toHaveCount(1);await expect(card).toContainText('Applied');
  const changed=structuredClone(sampleSnapshot);changed.snapshot_id='browser-later-evidence';changed.accounts[0].lot_scopes[0].lots[0].acquisition_date='2024-02-01';
  const later=await store.buildPreview(await store.readState(),[await readSource({name:'browser-later.json',text:JSON.stringify(changed)})],{accountId:target.id,currency:'USD',sourceAccountRef:'synthetic-account',completeAccount:false});await store.commitImport(later,decide(later));
  await page.getByRole('button',{name:'Refresh correction evidence',exact:true}).click();await expect(card).toContainText('Needs review — suspended');
  await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Reconciliation',exact:true}).click();await page.getByLabel('Filter account',{exact:true}).click();await page.getByRole('option',{name:new RegExp(target.label)}).click();
  await page.getByRole('button',{name:'Review EXAMPLE: Manual correction needs review',exact:true}).click();await page.getByRole('button',{name:'Correct this holding',exact:true}).click();await expect(page.getByLabel('Correction security',{exact:true})).toContainText('EXAMPLE');
  await card.getByRole('button',{name:'Withdraw',exact:true}).click();await page.getByLabel('Correction reason',{exact:true}).fill('Browser test: withdraw reviewed date.');
  await page.getByRole('button',{name:'Preview correction',exact:true}).click();await page.getByLabel('I reviewed the original value, replacement, and reason.').check();await page.getByRole('button',{name:'Accept correction',exact:true}).click();
  await expect(page.getByText('Correction recorded.',{exact:false})).toBeVisible();await expect(page.getByText('Withdrawn',{exact:false})).toBeVisible();
  const state=await store.readState();expect(state.corrections.filter(c=>c.accountId===target.id)).toHaveLength(2);expect(correctionView(state).correctionStates.some(c=>c.accountId===target.id)).toBe(false);
});

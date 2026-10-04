import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {localSupabase} from '../../scripts/configure-local-supabase.mjs';
import {supabaseStore} from '../../src/import/supabase-store.ts';
import {universeTemplate} from '../../src/analysis/replacements.mjs';
import {inspectPlanning,planningEnvelope} from '../../src/analysis/planning-backup.mjs';
const good=async p=>{const r=await p;if(r.error)throw Error(r.error.message);return r.data;};
test('planning recovery round trip, review, isolation, duplicate and conflict protection without shared cache writes',async({page})=>{
 const config=localSupabase(),raw=JSON.parse(execFileSync('supabase.exe',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 const admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),password=`Synthetic-${randomUUID()}-Aa7!`;
 async function owner(label){const user=(await good(admin.auth.admin.createUser({email:`planning-${randomUUID()}@example.test`,password,email_confirm:true}))).user;const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:label}).select().single());const account=await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label:label+' account',broker:'schwab',account_type:'taxable'}).select().single());return {user,client,portfolio,account,store:supabaseStore(client)};}
 const source=await owner('Source planning'),target=await owner('Restored planning');
 try{
  const document=universeTemplate(),file={name:'source.json',text:JSON.stringify(document)},p=(await source.store.replacements({action:'preview',...file})).preview;
  const u=(await source.store.replacements({action:'accept',...file,hash:p.hash,reviewed:true})).universe;
  await source.store.replacements({action:'select',portfolioId:source.portfolio.id,universeId:u.id,baseRevision:0,exclusions:[],reviewed:true});
  const evidence={version:1,kind:'unexecuted-draft',comparison:{accountId:source.account.id,portfolioId:source.portfolio.id,symbol:'EXAMPLE'},account:{label:'Source planning account'},selected:{quantity:'1',amount:'90',lots:[{index:0,quantity:'1'}]},replacement:{symbol:'EXAMPLEB'},price:{date:'2026-09-22'},holdingsRevision:1};
  await good(admin.from('trade_drafts').insert({user_id:source.user.id,evidence_hash:'a'.repeat(64),evidence}));
  const backup=(await source.store.replacements({action:'planning-export'})).backup;expect((await inspectPlanning(backup)).drafts).toHaveLength(1);
  const mapping={portfolios:{[source.portfolio.id]:target.portfolio.id},accounts:{[source.account.id]:target.account.id}};
  const baseline=await target.store.readState();
  await expect(target.store.replacements({action:'planning-preview',backup,mapping:{portfolios:{[source.portfolio.id]:source.portfolio.id},accounts:{[source.account.id]:source.account.id}}})).rejects.toThrow(/owned/);
  const bad=structuredClone(backup);bad.data.universes[0].name='tamper';await expect(target.store.replacements({action:'planning-preview',backup:bad,mapping})).rejects.toThrow(/checksum/);
  const preview=(await target.store.replacements({action:'planning-preview',backup,mapping})).preview;
  await expect(target.store.replacements({action:'planning-restore',backup,mapping,hash:preview.hash,reviewed:false})).rejects.toThrow(/review/);
  await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(target.user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  // Manage data starts open on Import.
  await page.getByRole('button',{name:'Data & accounts',exact:true}).click();await page.getByText('Advanced tools',{exact:true}).click();await page.getByRole('button',{name:'Recovery',exact:true}).click();await page.getByLabel('Planning backup',{exact:true}).setInputFiles({name:'planning.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await page.getByRole('combobox',{name:'Portfolio destination for Source planning',exact:true}).click();await page.getByRole('option',{name:'Restored planning',exact:true}).click();
  await page.getByRole('combobox',{name:'Planning account destination for Source planning account',exact:true}).click();await page.getByRole('option',{name:'Restored planning account',exact:true}).click();
  await page.getByRole('button',{name:'Preview planning restore',exact:true}).click();await expect(page.getByRole('button',{name:'Restore planning records',exact:true})).toBeDisabled();
  await page.getByLabel('I reviewed the planning backup and destinations; restored drafts need fresh review.').check();await page.getByRole('button',{name:'Restore planning records',exact:true}).click();await expect(page.getByText('Planning records restored. Review dated strategies before comparing; historical drafts are in Tracking.')).toBeVisible();
  const restored=(await target.store.replacements({action:'planning-export'})).backup;await inspectPlanning(restored);expect(restored.data.universes[0].source_text).toBe(file.text);expect(restored.data.drafts[0].evidence).toEqual(evidence);expect(restored.data.drafts[0].account_id).toBe(target.account.id);expect(restored.data.restores).toHaveLength(1);expect(restored.data.restores[0].source_audit.strategyEvents).toHaveLength(1);
  const p2=(await target.store.replacements({action:'planning-preview',backup,mapping})).preview;expect((await target.store.replacements({action:'planning-restore',backup,mapping,hash:p2.hash,reviewed:true})).restore.duplicate).toBe(true);
  expect(await target.store.readState()).toEqual(baseline);expect((await source.store.replacements({action:'planning-export'})).backup.data.drafts).toHaveLength(1);
  expect(await good(source.client.from('planning_restores').select('id'))).toEqual([]);expect((await target.client.rpc('export_planning',{p_user:source.user.id})).error).toBeTruthy();expect((await target.client.from('planning_restores').delete().eq('id',restored.data.restores[0].id)).error).toBeTruthy();
  await page.getByRole('button',{name:'Results',exact:true}).click();await page.getByRole('button',{name:'Sales & follow-up',exact:true}).click();await page.getByText('Optional saved trade drafts',{exact:true}).click();await expect(page.getByText(/Restored historical draft/)).toBeVisible();
  await page.screenshot({path:'test-results/planning-restored-draft.png',fullPage:true});
  const stale=(await target.store.replacements({action:'planning-preview',backup,mapping})).preview;
  await target.store.replacements({action:'select',portfolioId:target.portfolio.id,universeId:restored.data.universes[0].id,baseRevision:1,exclusions:[],reviewed:true});
  await expect(target.store.replacements({action:'planning-restore',backup,mapping,hash:stale.hash,reviewed:true})).rejects.toThrow(/changed/);
  await target.store.replacements({action:'select',portfolioId:target.portfolio.id,universeId:restored.data.universes[0].id,baseRevision:2,exclusions:['EXAMPLEB'],reviewed:true});
  await expect(target.store.replacements({action:'planning-preview',backup,mapping})).rejects.toThrow(/different active strategy/);
  // SQL rollback check: a late invalid draft must roll back earlier universe inserts.
  const fresh=await owner('Rollback planning'),broken=structuredClone(backup.data);broken.drafts[0].saved_at='invalid';
  const fm={portfolios:{[source.portfolio.id]:fresh.portfolio.id},accounts:{[source.account.id]:fresh.account.id}};
  const attempt=await admin.rpc('restore_planning',{p_user:fresh.user.id,p_checksum:'b'.repeat(64),p_data:broken,p_mapping:fm,p_expected:[]});expect(attempt.error).toBeTruthy();expect((await fresh.store.replacements({action:'planning-export'})).backup.data.universes).toEqual([]);await fresh.client.auth.signOut();
 }finally{await source.client.auth.signOut();await target.client.auth.signOut();}
});

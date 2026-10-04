import {test,expect} from '@playwright/test';import {createClient} from '@supabase/supabase-js';import {execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';import {localSupabase} from '../../scripts/configure-local-supabase.mjs';import {supabaseStore} from '../../src/import/supabase-store.ts';import {realizedFixture} from './realized-fixture.mjs';
const good=async p=>{const r=await p;if(r.error)throw Error(r.error.message);return r.data;};
test('realized report acceptance, duplicates, range replacement, isolation, original recovery and dashboard',async({page})=>{
 const config=localSupabase(),raw=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})),password=randomUUID()+'Aa1!',admin=createClient(config.url,raw.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 async function person(){const {user}=await good(admin.auth.admin.createUser({email:`realized-${randomUUID()}@example.test`,password,email_confirm:true})),client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});await good(client.auth.signInWithPassword({email:user.email,password}));const portfolio=await good(client.from('portfolios').insert({user_id:user.id,name:'Realized synthetic'}).select().single()),account=await good(client.from('accounts').insert({user_id:user.id,portfolio_id:portfolio.id,label:'Realized taxable',broker:'schwab',account_type:'taxable'}).select().single());return {user,client,account,store:supabaseStore(client)};}
 const a=await person(),b=await person(),file={accountId:a.account.id,name:'synthetic.csv',text:realizedFixture()};
 const preview=async f=>(await a.store.replacements({action:'realized-preview',...f})).preview;
 try{
 const p=await preview(file);expect(p.document.summary.loss).toBe('20');expect((await a.store.replacements({action:'realized-read'})).reports).toHaveLength(0);
 await a.store.replacements({action:'realized-accept',...file,hash:p.hash,reviewed:true});const dup=await preview(file);expect(dup.duplicate).toBe(true);await a.store.replacements({action:'realized-accept',...file,hash:dup.hash,reviewed:true});expect((await a.store.replacements({action:'realized-read'})).reports).toHaveLength(1);
 expect(await good(b.client.from('realized_reports').select('*'))).toEqual([]);expect((await a.client.from('realized_reports').delete().eq('account_id',a.account.id)).error).toBeTruthy();
 const replacement={...file,text:realizedFixture({basis:'130',loss:'-30'})},next=await preview(replacement);expect(next.replaces).toHaveLength(1);await a.store.replacements({action:'realized-accept',...replacement,hash:next.hash,reviewed:true});await expect(a.store.replacements({action:'realized-accept',...file,hash:dup.hash,reviewed:true})).rejects.toThrow(/changed/);
 await expect(preview({...file,text:realizedFixture({end:'09/24/2026'})})).rejects.toThrow(/entire date ranges/);
 const active=(await a.store.replacements({action:'realized-read'})).reports.find(r=>r.active);const original=await a.store.replacements({action:'realized-original',id:active.id});expect(original.source_text).toBe(replacement.text);await expect(b.store.replacements({action:'realized-original',id:active.id})).rejects.toThrow();
 const uiDestination=await good(a.client.from('accounts').insert({user_id:a.user.id,portfolio_id:a.account.portfolio_id,label:'UI recovery',broker:'schwab',account_type:'taxable'}).select().single());
 await page.goto('/?workspace=imports');await page.getByRole('textbox',{name:'Email',exact:true}).fill(a.user.email);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Results',exact:true}).click();await expect(page.getByRole('region',{name:'Loss harvested so far'}).getByText('$30.00',{exact:true}).first()).toBeVisible();
 await expect(page.getByRole('region',{name:'Cumulative realized losses chart'})).toBeVisible();await page.getByText('Chart data & coverage',{exact:true}).click();await expect(page.getByRole('table',{name:'Realized time series data'})).toContainText('$30.00');
 await page.getByText('Reconcile realized reports with sales',{exact:true}).click();await expect(page.getByRole('table',{name:'Realized sale reconciliation'})).toContainText('Activity coverage needed');
 const restoreFile={...file,accountId:b.account.id,text:original.source_text},restore=(await b.store.replacements({action:'realized-preview',...restoreFile})).preview;await b.store.replacements({action:'realized-accept',...restoreFile,hash:restore.hash,reviewed:true});expect((await b.store.replacements({action:'realized-read'})).reports[0].document.summary.loss).toBe('30');
 await a.store.replacements({action:'realized-withdraw',id:active.id,reason:'Synthetic withdrawal'});expect((await a.store.replacements({action:'realized-read'})).reports.filter(r=>r.active)).toHaveLength(0);

 // Preserve replacements and withdrawal plus a currently active report in full recovery.
 const latest={...file,text:realizedFixture({basis:'140',loss:'-40'})},lp=await preview(latest);
 await a.store.replacements({action:'realized-accept',...latest,hash:lp.hash,reviewed:true});
 const {backup}=await a.store.replacements({action:'realized-backup'});expect(backup.reports).toHaveLength(3);
 const destination=await good(b.client.from('accounts').insert({user_id:b.user.id,portfolio_id:b.account.portfolio_id,label:'Recovered history',broker:'schwab',account_type:'taxable'}).select().single());
 const mapping={[a.account.id]:destination.id},request={backup,mapping};
 const rp=(await b.store.replacements({action:'realized-restore-preview',...request})).preview;expect(rp.active).toBe(1);
 const corrupt=structuredClone(backup);corrupt.reports[0].source_text+='broken';
 await expect(b.store.replacements({action:'realized-restore-preview',backup:corrupt,mapping})).rejects.toThrow(/checksum/);
 await expect(a.store.replacements({action:'realized-restore-preview',...request})).rejects.toThrow(/owned/);
 await expect(b.store.replacements({action:'realized-restore-preview',backup,mapping:{[a.account.id]:b.account.id}})).rejects.toThrow(/no realized/);
 await expect(b.store.replacements({action:'realized-restore',...request,hash:rp.hash,reviewed:false})).rejects.toThrow(/Review/);
 expect((await b.client.rpc('restore_realized_history',{p_user:b.user.id,p_key:'bad',p_records:[]})).error).toBeTruthy();
 await b.store.replacements({action:'realized-restore',...request,hash:rp.hash,reviewed:true});
 const restored=(await b.store.replacements({action:'realized-read'})).reports.filter(r=>r.account_id===destination.id);expect(restored).toHaveLength(3);expect(restored.filter(r=>r.active)).toHaveLength(1);
 for(const row of restored){const old=backup.reports.find(r=>r.id===row.provenance.restoredFromReport);for(const field of ['accepted_at','retired_at','retirement_reason','active','document','source_hash'])expect(row[field]).toEqual(old[field]);}
 expect((await b.store.replacements({action:'realized-restore',...request,hash:rp.hash,reviewed:true})).restore.duplicate).toBe(true);
 const staleTarget=await good(b.client.from('accounts').insert({user_id:b.user.id,portfolio_id:b.account.portfolio_id,label:'Stale target',broker:'schwab',account_type:'taxable'}).select().single());
 const staleRequest={backup,mapping:{[a.account.id]:staleTarget.id}},stalePreview=(await b.store.replacements({action:'realized-restore-preview',...staleRequest})).preview;
 const competing={...file,accountId:staleTarget.id},cp=(await b.store.replacements({action:'realized-preview',...competing})).preview;
 await b.store.replacements({action:'realized-accept',...competing,hash:cp.hash,reviewed:true});
 await expect(b.store.replacements({action:'realized-restore',...staleRequest,hash:stalePreview.hash,reviewed:true})).rejects.toThrow(/no realized/);
 expect((await b.store.replacements({action:'realized-read'})).reports.filter(r=>r.account_id===staleTarget.id)).toHaveLength(1);
 const exported=(await b.store.replacements({action:'realized-backup'})).backup;expect(exported.reports.filter(r=>r.provenance)).toHaveLength(3);
 await page.getByRole('button',{name:'Refresh realized reports'}).click();await page.getByText('Import or manage realized gain/loss reports',{exact:true}).click();await page.getByText('Back up or restore full realized history',{exact:true}).click();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download full realized backup'}).click();expect((await download).suggestedFilename()).toBe('tlh-realized-history.json');
 await page.getByLabel('Realized history backup',{exact:true}).setInputFiles({name:'history.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
 await page.getByLabel('Restore realized account Realized taxable',{exact:true}).click();await page.getByRole('option',{name:'UI recovery',exact:true}).click();await page.getByRole('button',{name:'Preview history restore'}).click();await expect(page.getByRole('button',{name:'Restore realized history',exact:true})).toBeDisabled();await page.getByLabel('I reviewed the backup history and destination accounts.').check();await page.getByRole('button',{name:'Restore realized history',exact:true}).click();await expect(page.getByText('Realized history restored. Original timestamps are retained with separate restore provenance.')).toBeVisible();expect((await a.store.replacements({action:'realized-read'})).reports.filter(r=>r.account_id===uiDestination.id)).toHaveLength(3);
 }finally{await a.client.auth.signOut();await b.client.auth.signOut();}
});

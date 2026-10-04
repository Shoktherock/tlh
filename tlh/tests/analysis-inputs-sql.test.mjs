import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
async function role(name,user=a){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec(`set role ${name}`);}
const rpc=async(sql,args)=>(await db.query(sql,args)).rows[0].value;
const read=()=>rpc('select read_analysis_inputs($1) as value',[a]);
let first,receipt;
async function prepare(input={test:'fixture'}){const s=await read();return rpc('select prepare_analysis_inputs($1,$2) as value',[a,JSON.stringify({baseRevision:s.revision,accounts:s.accounts,after:input,kind:'save',reason:'Synthetic'})]);}
const commit=id=>rpc('select commit_analysis_inputs($1,$2) as value',[a,id]);
before(async()=>{
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema public,auth to anon,authenticated,service_role;`);
  await db.query('insert into auth.users values($1),($2)',[a,b]);await db.exec(`create table public.portfolios(id uuid primary key,name text);create table public.accounts(id uuid primary key,user_id uuid,label text,account_type text,portfolio_id uuid);grant all on portfolios,accounts to service_role;`);
  await db.query("insert into portfolios values($1,'Test')",[a]);await db.query("insert into accounts values($1,$1,'First','taxable',$1)",[a]);
  await db.exec(await readFile(new URL('../../supabase/migrations/202609150002_analysis_inputs.sql',import.meta.url),'utf8'));await role('service_role');
});
after(()=>db.close());
test('prepare does not save; acceptance is atomic, stamped and idempotent',async()=>{
  first=await prepare();assert.equal((await read()).input,null);receipt=await commit(first);assert.equal(receipt.revision,1);assert.deepEqual(await commit(first),receipt);const s=await read();assert.equal(s.history.length,1);assert.equal(s.history[0].user_id,a);assert(s.history[0].saved_at);assert.equal(s.history[0].accounts[0].label,'First');
});
test('clients cannot read other users, change assumptions or audits, or call privileged functions',async()=>{
  await role('authenticated',b);assert.equal((await db.query('select * from analysis_inputs')).rows.length,0);assert.equal((await db.query('select * from analysis_input_events')).rows.length,0);
  await assert.rejects(db.query('select * from prepared_analysis_inputs'),/permission denied/);await assert.rejects(db.query('select read_analysis_inputs($1)',[a]),/permission denied/);await assert.rejects(db.query('select commit_analysis_inputs($1,$2)',[a,first]),/permission denied/);
  await role('authenticated',a);assert.equal((await db.query('select * from analysis_inputs')).rows.length,1);for(const sql of ["update analysis_inputs set revision=99",'delete from analysis_input_events',"update analysis_input_events set reason='forged'"])await assert.rejects(db.query(sql),/permission denied/);
  await role('anon');await assert.rejects(db.query('select * from analysis_inputs'),/permission denied/);
});
test('cross-user acceptance, stale revisions and changed account inventory fail without partial changes',async()=>{
  await role('service_role');const old=await prepare(),next=await prepare({test:'next'});await assert.rejects(rpc('select commit_analysis_inputs($1,$2) as value',[b,next]),/unavailable/);await commit(next);await assert.rejects(commit(old),/stale/);
  const changed=await prepare();await db.query("update accounts set account_type='roth_ira' where id=$1",[a]);await assert.rejects(commit(changed),/inventory/);assert.equal((await read()).revision,2);assert.equal((await read()).history[1].accounts[0].type,'taxable');
});
test('expired previews and a failure during commit roll back state and audit, then permit retry',async()=>{
  await role('service_role');const expired=await prepare();await db.query("update prepared_analysis_inputs set created_at=now()-interval '25 hours' where id=$1",[expired]);await assert.rejects(commit(expired),/expired/);
  const plan=await prepare({test:'retry'}),before=await read();await db.exec('reset role');await db.exec(`create function fail_analysis_test() returns trigger language plpgsql as $$begin raise exception 'synthetic rollback';end$$;create trigger fail_analysis_test before update on public.analysis_inputs for each row execute function fail_analysis_test();`);
  await role('service_role');await assert.rejects(commit(plan),/synthetic rollback/);assert.deepEqual(await read(),before);
  await db.exec('reset role');await db.exec('drop trigger fail_analysis_test on public.analysis_inputs;drop function fail_analysis_test();');await role('service_role');assert.equal((await commit(plan)).revision,3);
});

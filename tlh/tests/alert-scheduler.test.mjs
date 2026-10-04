import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {runScheduledAlert} from '../server/alert-worker.mjs';
test('scheduled checks lease once, retry failures, catch up after downtime and reject stale changes',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as 'select null::uuid';`);
 await db.exec(await readFile(new URL('../../supabase/migrations/202609270003_alert_schedules.sql',import.meta.url),'utf8'));
 const user='10000000-0000-0000-0000-000000000001';await db.query('insert into auth.users values ($1)',[user]);
 const query=async(sql,args=[]) => (await db.query(sql,args)).rows;
 assert.equal((await query('select * from claim_alert_schedule()')).length,0);
 await query('select save_alert_schedule($1,0,true)',[user]);
 await assert.rejects(query('select save_alert_schedule($1,0,false)',[user]),/changed/);
 const [first]=await query('select * from claim_alert_schedule()');assert.ok(first.lease_id);
 assert.equal((await query('select * from claim_alert_schedule()')).length,0);
 await query('select finish_alert_schedule($1,$2,false)',[user,first.lease_id]);
 let [state]=await query('select * from alert_schedules');assert.equal(state.failures,1);assert.ok(state.last_error);assert.equal(state.last_success,null);assert.ok(new Date(state.next_run)>new Date(state.last_attempt));
 await query("update alert_schedules set next_run=now()-interval '2 days'");
 const [retry]=await query('select * from claim_alert_schedule()');assert.notEqual(retry.lease_id,first.lease_id);
 assert.equal((await query('select finish_alert_schedule($1,$2,true) as ok',[user,first.lease_id]))[0].ok,false);
 await query('select finish_alert_schedule($1,$2,true)',[user,retry.lease_id]);
 [state]=await query('select * from alert_schedules');assert.equal(state.failures,0);assert.equal(state.last_error,null);assert.ok(state.last_success);assert.ok(new Date(state.next_run)-new Date(state.last_success)>=86399000);
 await query("update alert_schedules set next_run=now()-interval '2 days',lease_until=now()-interval '1 minute'");
 const [catchup]=await query('select * from claim_alert_schedule()');assert.ok(catchup.lease_id);
 await query('select save_alert_schedule($1,1,false)',[user]);
 assert.equal((await query('select finish_alert_schedule($1,$2,true) as ok',[user,catchup.lease_id]))[0].ok,false);
 assert.equal((await query('select * from claim_alert_schedule()')).length,0);
 }finally{await db.close();}
});
test('worker records success or failure without exposing error details and skips canceled jobs',async()=>{
 for(const mode of ['success','failure','canceled']){
 const calls=[];let scanned=false;const db={rpc:async(name,args)=>{calls.push([name,args]);return {data:name==='claim_alert_schedule'?[{user_id:'u',lease_id:'l'}]:true};},from:()=>({select:()=>({eq:()=>({single:async()=>({data:{enabled:mode!=='canceled',lease_id:'l'}})})})})};
 await runScheduledAlert(db,{scan:async()=>{scanned=true;if(mode==='failure')throw Error('private details');}});
 assert.equal(scanned,mode!=='canceled');assert.equal(calls.length,mode==='canceled'?1:2);
 if(mode!=='canceled')assert.equal(calls[1][1].p_success,mode==='success');
 }
});
test('evidence triggers preserve changes during scans, respect opt-out and retain failure backoff',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as 'select null::uuid';create table import_revisions(user_id uuid,revision int);create table activity_state(user_id uuid,revision int);create table sale_reviews(user_id uuid);create table alert_preferences(user_id uuid);create table massive_daily_cache(price_date date);`);
 for(const file of ['202609270003_alert_schedules.sql','202609290001_alert_change_checks.sql'])await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
 const user='10000000-0000-0000-0000-000000000002',query=async(sql,args=[]) => (await db.query(sql,args)).rows;
 await query('insert into auth.users values($1)',[user]);await query('select save_alert_schedule($1,0,true)',[user]);
 const [job]=await query('select * from claim_alert_schedule()');await query('insert into sale_reviews values($1)',[user]);await query('select finish_alert_schedule($1,$2,true)',[user,job.lease_id]);
 const [catchup]=await query('select * from claim_alert_schedule()');assert.ok(catchup);assert.equal(Number(catchup.change_generation),1);
 await query('select finish_alert_schedule($1,$2,false)',[user,catchup.lease_id]);await query('insert into alert_preferences values($1)',[user]);assert.equal((await query('select * from claim_alert_schedule()')).length,0);
 await query('select save_alert_schedule($1,1,false)',[user]);await query("insert into massive_daily_cache values('2026-09-25')");assert.equal((await query('select * from claim_alert_schedule()')).length,0);
 await query('select alert_worker_heartbeat()');assert.equal((await query('select * from alert_worker_health')).length,1);
 await query('set role authenticated');await assert.rejects(query('select alert_worker_heartbeat()'),/permission denied/);
 }finally{await db.close();}
});

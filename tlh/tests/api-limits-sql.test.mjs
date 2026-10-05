import {test} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';
test('database quotas deny client bypass, reset windows, isolate users and survive upload deletion',async()=>{
 const db=new PGlite();const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table import_sources(id serial primary key,user_id uuid,created_at timestamptz default now());`);
 await db.query('insert into auth.users values($1),($2)',[a,b]);
 await db.exec(await readFile(new URL('../../supabase/migrations/202610050001_api_limits.sql',import.meta.url),'utf8'));
 await db.exec('set role authenticated');await assert.rejects(db.query('select consume_api_quota($1)',[a]),/permission denied/);await assert.rejects(db.query('select * from api_request_usage'),/permission denied/);await db.exec('reset role');
 await db.query('select consume_api_quota($1)',[a]);await db.query('update api_request_usage set minute_count=120 where user_id=$1',[a]);
 assert.equal((await db.query('select consume_api_quota($1) as ok',[a])).rows[0].ok,false);
 assert.equal((await db.query('select consume_api_quota($1) as ok',[b])).rows[0].ok,true);
 await db.query("update api_request_usage set minute_start=now()-interval '2 minutes' where user_id=$1",[a]);assert.equal((await db.query('select consume_api_quota($1) as ok',[a])).rows[0].ok,true);
 await db.query('update api_request_usage set hour_count=2000 where user_id=$1',[a]);assert.equal((await db.query('select consume_api_quota($1) as ok',[a])).rows[0].ok,false);
 for(let i=0;i<40;i++)await db.query('insert into import_sources(user_id) values($1)',[a]);await assert.rejects(db.query('insert into import_sources(user_id) values($1)',[a]),/Daily upload limit/);
 await db.query('delete from import_sources where user_id=$1',[a]);await assert.rejects(db.query('insert into import_sources(user_id) values($1)',[a]),/Daily upload limit/);
 await db.query("update upload_daily_usage set day=day-1 where user_id=$1",[a]);await db.query('insert into import_sources(user_id) values($1)',[a]);
 }finally{await db.close();}
});

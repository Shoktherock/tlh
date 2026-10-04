import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('universe ownership, append-only evidence and stale strategy revisions are enforced',async()=>{
  const db=new PGlite(),a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';try{
    await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to authenticated,service_role;create table portfolios(id uuid,user_id uuid,unique(id,user_id));");
    await db.query('insert into auth.users values($1),($2)',[a,b]);await db.query('insert into portfolios values($1,$1),($2,$2)',[a,b]);
    await db.exec(await readFile(new URL('../../supabase/migrations/202609230001_replacement_universes.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../../supabase/migrations/202609230002_replacement_metrics.sql',import.meta.url),'utf8'));
    await db.query("insert into replacement_universes(id,user_id,hash,name,benchmark,provenance,as_of,valid_through,member_count,source_name,source_text,document) values($1,$1,$2,'test','Russell 3000','synthetic','2026-09-01','2026-09-30',2,'test.json','{}','{}')",[a,'a'.repeat(64)]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[b]);await db.exec('set role authenticated');assert.equal((await db.query('select * from replacement_universes')).rows.length,0);
    await assert.rejects(db.query('delete from replacement_universes'),/permission denied/);
    await assert.rejects(db.query('select * from replacement_metric_cache'),/permission denied/);
    await assert.rejects(db.query("select save_replacement_strategy($1,$1,$1,0,'[]')",[a]),/permission denied/);
    await db.exec('reset role;set role service_role');
    assert.equal((await db.query("select save_replacement_strategy($1,$1,$1,0,'[]') as r",[a])).rows[0].r,1);
    await assert.rejects(db.query("select save_replacement_strategy($1,$1,$1,0,'[]')",[a]),/Stale/);
    await assert.rejects(db.query("select save_replacement_strategy($1,$1,$2,0,'[]')",[b,a]),/Universe/);
    await assert.rejects(db.query("update replacement_universes set name='changed'"),/permission denied/);
    assert.equal((await db.query('select * from replacement_strategy_events')).rows.length,1);
  }finally{await db.close();}
});

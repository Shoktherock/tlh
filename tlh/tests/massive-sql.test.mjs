import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('daily cache and provider budget are server-only with bounded concurrent requests',async()=>{
  const db=new PGlite();try{
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role');
    await db.exec(await readFile(new URL('../../supabase/migrations/202609220001_massive_daily.sql',import.meta.url),'utf8'));
    await db.exec('set role authenticated');
    for(const sql of ['select * from massive_daily_cache','select claim_massive_request()',"update massive_budget set minute_count=0"])await assert.rejects(db.query(sql),/permission denied/);
    await db.exec('reset role;set role service_role');
    const claim=async()=>(await db.query('select claim_massive_request() as result')).rows[0].result;
    assert.equal(await claim(),'ok');assert.equal(await claim(),'busy');
    for(let i=1;i<5;i++){await db.exec("update massive_budget set lease_until='-infinity'");assert.equal(await claim(),'ok');}
    await db.exec("update massive_budget set lease_until='-infinity'");assert.equal(await claim(),'rate_limit');
  }finally{await db.close();}
});

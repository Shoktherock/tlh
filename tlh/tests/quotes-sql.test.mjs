import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const quote={key:'twelve-data:TEST:XNAS:USD',provider:'twelve-data',provider_symbol:'TEST',mic:'XNAS',currency:'USD',price:'90.123456789',observed_at:'2026-09-15T17:59:00Z',fetched_at:'2026-09-15T18:00:00Z'};
async function role(name,user=a){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec(`set role ${name}`);}
before(async()=>{
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema public,auth to anon,authenticated,service_role;`);
  await db.query('insert into auth.users values($1),($2)',[a,b]);
  await db.exec(`create table public.accounts(id uuid,user_id uuid,primary key(id),unique(id,user_id));`);await db.query('insert into accounts values($1,$1),($2,$2)',[a,b]);
  await db.exec(await readFile(new URL('../../supabase/migrations/202609150001_quotes.sql',import.meta.url),'utf8'));
  await role('service_role');await db.query('select save_quote($1)',[JSON.stringify(quote)]);
  await db.query("insert into quote_mappings values($1,$1,'TEST','TEST','XNAS','identity')",[a]);
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../../supabase/migrations/202609200001_quote_global_select.sql',import.meta.url),'utf8'));
});
after(()=>db.close());

test('Global Select migration preserves old quotes and accepts exact segment mappings and cache keys',async()=>{
  await role('service_role');
  const segment={...quote,key:'twelve-data:MSFT:XNGS:USD',provider_symbol:'MSFT',mic:'XNGS'};
  assert.equal((await db.query('select claim_quote_request($1) as result',[segment.key])).rows[0].result,'ok');
  assert.equal((await db.query('select save_quote($1) as saved',[JSON.stringify(segment)])).rows[0].saved.mic,'XNGS');
  await db.query("insert into quote_mappings values($1,$1,'MSFT','MSFT','XNGS','identity')",[a]);
  await assert.rejects(db.query("select claim_quote_request('twelve-data:MSFT:FAKE:USD')"),/Invalid quote key/);
  await db.query('delete from quote_mappings where symbol=$1',['MSFT']);
  await db.query('delete from price_cache where key=$1',[segment.key]);
  await db.exec('delete from quote_leases; update quote_budget set minute_count=0,day_count=0');
});
test('authenticated users share only quotes; mappings remain owner-private and anonymous reads fail',async()=>{
  for(const id of [a,b]){await role('authenticated',id);assert.equal((await db.query('select price from price_cache')).rows[0].price,quote.price);assert.equal((await db.query('select * from quote_mappings')).rows.length,id===a?1:0);}
  await role('authenticated','');assert.equal((await db.query('select * from price_cache')).rows.length,0);
  await role('anon');await assert.rejects(db.query('select * from price_cache'),/permission denied/);
});
test('clients cannot poison quotes, alter mappings, delete cache, or spend the server quota',async()=>{
  await role('authenticated');
  for(const sql of ["update price_cache set price='0'",'delete from price_cache',"insert into quote_mappings values('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','OTHER','OTHER','XNAS','bad')",'delete from quote_mappings',"select claim_quote_request('twelve-data:TEST:XNAS:USD')",'select * from quote_budget',`select save_quote('${JSON.stringify(quote)}'::jsonb)`])await assert.rejects(db.query(sql),/permission denied/);
});
test('server save rejects invalid values and out-of-order responses preserve newer market data',async()=>{
  await role('service_role');
  for(const extra of [{price:'NaN'},{currency:'EUR'},{key:'wrong'},{observed_at:'2026-09-16T18:00:00Z'}])await assert.rejects(db.query('select save_quote($1)',[JSON.stringify({...quote,...extra})]),/check constraint/);
  let r=await db.query('select save_quote($1) as saved',[JSON.stringify({...quote,price:'1',observed_at:'2026-09-15T17:00:00Z',fetched_at:'2026-09-15T18:01:00Z'})]);assert.equal(r.rows[0].saved.price,quote.price);
  r=await db.query('select save_quote($1) as saved',[JSON.stringify({...quote,price:'91',observed_at:'2026-09-15T18:01:00Z',fetched_at:'2026-09-15T18:01:00Z'})]);assert.equal(r.rows[0].saved.price,'91');
});
test('atomic provider budget bounds concurrent refreshes, repeated symbols and daily exhaustion',async()=>{
  await role('service_role');
  const claim=async s=>(await db.query('select claim_quote_request($1) as result',[`twelve-data:${s}:XNAS:USD`])).rows[0].result;
  assert.equal(await claim('TEST'),'ok');assert.equal(await claim('TEST'),'busy');
  const results=await Promise.all(Array.from({length:10},(_,n)=>claim(`TEST${n}`)));assert.equal(results.filter(r=>r==='ok').length,7);assert.equal(results.filter(r=>r==='rate_limit').length,3);
  await db.exec("update quote_budget set minute_start=now()-interval '2 minutes',day_count=800");assert.equal(await claim('DAY'),'rate_limit');
  await db.exec("update quote_budget set day_start=(now() at time zone 'UTC')::date-1");assert.equal(await claim('NEXTDAY'),'ok');
});

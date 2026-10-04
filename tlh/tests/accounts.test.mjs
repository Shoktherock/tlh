import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { accountConfig } from '../src/accounts/config.mjs';

const alice='11111111-1111-4111-8111-111111111111';
const bob='22222222-2222-4222-8222-222222222222';
const db=new PGlite();
let alicePortfolio, bobPortfolio, aliceAccount;
async function asUser(user, role='authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)",[user ?? '']);
  await db.exec(`set role ${role}`);
}
before(async()=>{
  // Minimal Supabase Auth contract; no simulated RLS. PostgreSQL executes the real policies.
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;`);
  await db.query('insert into auth.users values ($1),($2)',[alice,bob]);
  await db.exec(await readFile(new URL('../../supabase/migrations/202609080001_accounts.sql',import.meta.url),'utf8'));
  await asUser(alice);
  alicePortfolio=(await db.query('insert into portfolios (user_id,name) values ($1,$2) returning id',[alice,'Alice portfolio'])).rows[0].id;
  aliceAccount=(await db.query("insert into accounts (user_id,portfolio_id,label,broker,account_type,masked_identifier) values ($1,$2,'Alice account','schwab','taxable','1234') returning id",[alice,alicePortfolio])).rows[0].id;
  await asUser(bob);
  bobPortfolio=(await db.query('insert into portfolios (user_id,name) values ($1,$2) returning id',[bob,'Bob portfolio'])).rows[0].id;
});
after(async()=>db.close());

test('PostgreSQL RLS isolates reads and edits even when another user knows record IDs',async()=>{
  await asUser(bob);
  assert.deepEqual((await db.query('select id from portfolios')).rows,[{id:bobPortfolio}]);
  assert.equal((await db.query('select id from accounts')).rows.length,0);
  assert.equal((await db.query("update accounts set label='stolen' where id=$1 returning id",[aliceAccount])).rows.length,0);
  assert.equal((await db.query("update portfolios set name='stolen' where id=$1 returning id",[alicePortfolio])).rows.length,0);
  await asUser(alice);
  assert.equal((await db.query('select label from accounts')).rows[0].label,'Alice account');
  assert.equal((await db.query("update accounts set account_type='roth_ira' where id=$1 returning account_type",[aliceAccount])).rows[0].account_type,'roth_ira');
});
test('forged ownership and attaching an account to another owner are rejected',async()=>{
  await asUser(bob);
  await assert.rejects(db.query('insert into portfolios(user_id,name) values ($1,$2)',[alice,'Forged']),/row-level security/);
  await assert.rejects(db.query("insert into accounts(user_id,portfolio_id,label,broker) values ($1,$2,'Forged','schwab')",[alice,alicePortfolio]),/row-level security/);
  await assert.rejects(db.query("insert into accounts(user_id,portfolio_id,label,broker) values ($1,$2,'Wrong parent','schwab')",[bob,alicePortfolio]),/foreign key/);
});
test('clients cannot transfer ownership, reparent accounts, or delete audit foundations',async()=>{
  await asUser(alice);
  await assert.rejects(db.query('update portfolios set user_id=$1 where id=$2',[bob,alicePortfolio]),/permission denied/);
  await assert.rejects(db.query('update accounts set portfolio_id=$1 where id=$2',[bobPortfolio,aliceAccount]),/permission denied/);
  await assert.rejects(db.query('update accounts set user_id=$1 where id=$2',[bob,aliceAccount]),/permission denied/);
  await assert.rejects(db.query('delete from accounts where id=$1',[aliceAccount]),/permission denied/);
  await assert.rejects(db.query('delete from portfolios where id=$1',[alicePortfolio]),/permission denied/);
});
test('anonymous and authenticated roles without a user claim have no account access',async()=>{
  await asUser(null,'anon');
  await assert.rejects(db.query('select * from portfolios'),/permission denied/);
  await assert.rejects(db.query('select * from accounts'),/permission denied/);
  await assert.rejects(db.query('insert into portfolios(user_id,name) values ($1,$2)',[alice,'Anon']),/permission denied/);
  await asUser(null);
  assert.equal((await db.query('select * from portfolios')).rows.length,0);
  await assert.rejects(db.query('insert into portfolios(user_id,name) values ($1,$2)',[alice,'No claim']),/row-level security/);
});
test('database validates account types, masked identifiers and blank labels; suffixes are not unique identities',async()=>{
  await asUser(alice);
  await assert.rejects(db.query("update accounts set account_type='guess' where id=$1",[aliceAccount]),/check constraint/);
  await assert.rejects(db.query("update accounts set masked_identifier='123456789' where id=$1",[aliceAccount]),/check constraint/);
  await assert.rejects(db.query("update accounts set label=' ' where id=$1",[aliceAccount]),/check constraint/);
  await db.query("insert into accounts(user_id,portfolio_id,label,broker,masked_identifier) values ($1,$2,'Separate account','schwab','1234')",[alice,alicePortfolio]);
  assert.equal((await db.query('select id from accounts')).rows.length,2);
});
test('configuration fails closed for secret keys and incomplete or unsafe origins',()=>{
  assert.equal(accountConfig(undefined,undefined),null);
  assert.throws(()=>accountConfig('https://test.supabase.co',undefined),/both/);
  assert.throws(()=>accountConfig('https://test.supabase.co','sb_secret_no'),/Secret/);
  const jwt=role=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({role})).toString('base64url')}.signature`;
  assert.throws(()=>accountConfig('https://test.supabase.co',jwt('service_role')),/Secret/);
  assert.equal(accountConfig('https://test.supabase.co',jwt('anon')).url,'https://test.supabase.co');
  assert.throws(()=>accountConfig('http://remote.example','sb_publishable_test'),/HTTPS/);
  assert.throws(()=>accountConfig('https://test.supabase.co/path','sb_publishable_test'),/origin/);
  assert.equal(accountConfig('http://127.0.0.1:54321','sb_publishable_test').url,'http://127.0.0.1:54321');
});

import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { localSupabase } from '../../scripts/configure-local-supabase.mjs';

test('real local Auth confirmation, account persistence, RLS isolation, and cross-tab sign-out',async({page,context,browser},info)=>{
  const config=localSupabase();
  const client=()=>createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const suffix=randomUUID().slice(0,8);const password=`Local-${randomUUID()}-7a!`;
  const emails=[`tlh-a-${suffix}@example.test`,`tlh-b-${suffix}@example.test`];
  const otherContext=await browser.newContext();const bobPage=await otherContext.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.name));
  async function register(target,email){
    await target.goto('http://127.0.0.1:4180/?workspace=accounts');
    await target.getByRole('button',{name:'Create sign-in',exact:true}).click();
    await target.getByRole('textbox',{name:'Email',exact:true}).fill(email);
    await target.getByLabel(/^Password/).fill(password);
    await target.getByRole('button',{name:'Register',exact:true}).click();
    await expect(target.getByText('Check your email to confirm registration, then return here to sign in.')).toBeVisible();
    let message;
    await expect.poll(async()=>{
      const list=await fetch('http://127.0.0.1:55324/api/v1/messages').then(r=>r.json());
      message=list.messages.find(m=>m.To.some(recipient=>recipient.Address===email));return Boolean(message);
    },{timeout:15000}).toBe(true);
    const body=await fetch(`http://127.0.0.1:55324/api/v1/message/${message.ID}`).then(r=>r.json());
    const links=[...body.HTML.matchAll(/href="([^"]+)"/g)].map(m=>m[1].replaceAll('&amp;','&'));
    const confirmation=links.find(link=>{try{const u=new URL(link);return u.origin===config.url && u.pathname==='/auth/v1/verify';}catch{return false;}});
    if(!confirmation)throw new Error('No local verification link found in the matching synthetic email.');
    try{await target.goto(confirmation);}catch{throw new Error('Local confirmation navigation failed.');}
    await expect(target.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  }
  try {
    await register(page,emails[0]);
    await page.getByLabel('New portfolio name').fill(`Local verification ${suffix}`);
    await page.getByRole('button',{name:'Create portfolio',exact:true}).click();
    await page.getByRole('textbox',{name:'Account label',exact:true}).fill(`Synthetic A ${suffix}`);
    await page.getByRole('button',{name:'Add account',exact:true}).click();
    await expect(page.getByText(`Synthetic A ${suffix}`,{exact:true})).toBeVisible();
    await page.reload();await expect(page.getByText(`Synthetic A ${suffix}`,{exact:true})).toBeVisible();
    await register(bobPage,emails[1]);
    await expect(bobPage.getByText('Create your first portfolio to add brokerage accounts.')).toBeVisible();
    const alice=client(),bob=client(),anon=client();
    const a=await alice.auth.signInWithPassword({email:emails[0],password});const b=await bob.auth.signInWithPassword({email:emails[1],password});
    expect(a.error).toBeNull();expect(b.error).toBeNull();
    const own=await alice.from('accounts').select('id,portfolio_id');expect(own.error).toBeNull();expect(own.data.length).toBe(1);
    const other=await bob.from('accounts').select('id');expect(other.error).toBeNull();expect(other.data).toEqual([]);
    const tamper=await bob.from('accounts').update({label:'forged'}).eq('id',own.data[0].id).select('id');expect(tamper.error).toBeNull();expect(tamper.data).toEqual([]);
    const attach=await bob.from('accounts').insert({user_id:b.data.user.id,portfolio_id:own.data[0].portfolio_id,label:'forged',broker:'schwab'});expect(Boolean(attach.error)).toBe(true);
    const forge=await bob.from('portfolios').insert({user_id:a.data.user.id,name:'forged'});expect(Boolean(forge.error)).toBe(true);
    expect(Boolean((await anon.from('accounts').select('id')).error)).toBe(true);
    const tab=await context.newPage();await tab.goto('/?workspace=accounts');await expect(tab.getByText(`Synthetic A ${suffix}`,{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('local-accounts.png'),fullPage:true});
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await expect(tab.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
    await page.getByRole('textbox',{name:'Email',exact:true}).fill(emails[0]);await page.getByLabel(/^Password/).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByText(`Synthetic A ${suffix}`,{exact:true})).toBeVisible();
    expect(errors).toEqual([]);
    await Promise.all([alice.auth.signOut(),bob.auth.signOut()]);
  } finally {await otherContext.close();}
});

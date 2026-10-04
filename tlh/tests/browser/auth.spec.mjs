import { test, expect } from '@playwright/test';

// HTTP fixtures exercise the real Supabase JS client. Database isolation is tested
// separately by executing the production migration under PostgreSQL roles.
async function mockProject(page,{confirm=false,failLoad=false}={}) {
  const portfolios=[]; const accounts=[]; const requests=[];
  const user={id:'11111111-1111-4111-8111-111111111111',aud:'authenticated',role:'authenticated',email:'test@example.test',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
  const session={access_token:'synthetic.access.token',refresh_token:'synthetic-refresh',expires_in:3600,token_type:'bearer',user};
  await page.route('https://tlh-test.supabase.co/**',async route=>{
    const req=route.request();const url=new URL(req.url());requests.push(url.pathname);
    const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname.endsWith('/token')) return req.postDataJSON()?.password==='wrong-password' ? reply({error:'invalid_grant',error_description:'Invalid login credentials'},400) : reply(session);
    if(url.pathname.endsWith('/signup')) return reply(confirm ? {...user,identities:[]} : session);
    if(url.pathname.endsWith('/logout')) return reply({});
    if(url.pathname.endsWith('/user')) return reply(user);
    const table=url.pathname.split('/').at(-1);const rows=table==='portfolios' ? portfolios : accounts;
    if(url.pathname.startsWith('/rest/v1/')){
      if(failLoad && req.method()==='GET') return reply({message:'synthetic permission failure'},403);
      if(req.method()==='GET')return reply(rows);
      if(req.method()==='POST'){const row={id:`${table}-${rows.length+1}`,...req.postDataJSON()};rows.push(row);return reply(row,201);}
      if(req.method()==='PATCH'){const row=rows.find(r=>`eq.${r.id}`===url.searchParams.get('id'));Object.assign(row,req.postDataJSON());return reply(row);}
    }
    return reply({message:'Unexpected request'},500);
  });
  return {portfolios,accounts,requests};
}
async function signIn(page,password='correct-password'){
  await page.getByRole('textbox',{name:'Email',exact:true}).fill('test@example.test');await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
}

test('sign in, create portfolio and account, edit type, reload and sign out',async({page},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));const backend=await mockProject(page);
  await page.goto('/?workspace=accounts');await signIn(page);
  await page.getByLabel('New portfolio name').fill('Synthetic portfolio');await page.getByRole('button',{name:'Create portfolio',exact:true}).click();
  await page.getByRole('textbox',{name:'Account label',exact:true}).fill('Synthetic brokerage');await page.getByLabel('Last four digits (optional)').fill('1234');
  await page.getByRole('button',{name:'Add account',exact:true}).click();await expect(page.getByText('Synthetic brokerage',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Edit Synthetic brokerage'}).click();await page.getByRole('combobox',{name:'Account type'}).click();await page.getByRole('option',{name:'Taxable',exact:true}).click();await page.getByRole('button',{name:'Save account'}).click();
  await expect(page.getByText('schwab · Taxable · …1234',{exact:true})).toBeVisible();expect(backend.accounts[0].account_type).toBe('taxable');await page.reload();await expect(page.getByText('Synthetic brokerage',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('accounts.png'),fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await expect(page.getByText('Synthetic brokerage',{exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);expect(backend.requests.some(p=>p.includes('/storage/'))).toBe(false);
});
test('failed sign in stays signed out and registration without a session asks for email confirmation',async({page})=>{
  await mockProject(page,{confirm:true});await page.goto('/?workspace=accounts');await signIn(page,'wrong-password');
  await expect(page.getByText('Sign-in failed.',{exact:false})).toBeVisible();await expect(page.getByLabel('New portfolio name')).toHaveCount(0);
  await page.getByRole('button',{name:'Create sign-in',exact:true}).click();await page.getByLabel(/^Password/).fill('synthetic-long-password');await page.getByRole('button',{name:'Register',exact:true}).click();
  await expect(page.getByText('Check your email to confirm registration, then return here to sign in.')).toBeVisible();await expect(page.getByLabel('New portfolio name')).toHaveCount(0);
});
test('database load failures are visible and cannot create a misleading empty workspace',async({page})=>{
  await mockProject(page,{failLoad:true});await page.goto('/?workspace=accounts');await signIn(page);
  await expect(page.getByText('Accounts could not load.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Create portfolio',exact:true})).toBeDisabled();
});
test('signing out in another tab removes the authenticated account view',async({page,context})=>{
  await mockProject(page);await page.goto('/?workspace=accounts');await signIn(page);await expect(page.getByLabel('New portfolio name')).toBeVisible();
  const other=await context.newPage();await mockProject(other);await other.goto('/?workspace=accounts');await expect(other.getByLabel('New portfolio name')).toBeVisible();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(other.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await expect(other.getByLabel('New portfolio name')).toHaveCount(0);
});

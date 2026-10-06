import DataPrivacy from './DataPrivacy';
import React, { useEffect, useMemo, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { Alert, Button, MenuItem, TextField } from '@mui/material';
import { accountClient } from './client';
import ImportApp from '../ImportApp';
import { supabaseStore } from '../import/supabase-store';

const accountTypes = [['unknown','Unknown'],['taxable','Taxable'],['traditional_ira','Traditional IRA'],['roth_ira','Roth IRA'],['other','Other']];
type Portfolio = { id: string; name: string };
type Account = { id: string; portfolio_id: string; label: string; broker: string; masked_identifier: string | null; account_type: string };

export default function AccountsApp({imports=false}:{imports?:boolean}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(accountClient));
  const [error, setError] = useState('');
  const store=useMemo(()=>accountClient ? supabaseStore(accountClient) : null,[]);
  useEffect(() => {
    if (!accountClient) return;
    const { data } = accountClient.auth.onAuthStateChange((_event, next) => {
      setSession(next); setLoading(false); setError('');
    });
    return () => data.subscription.unsubscribe();
  }, []);
  async function signOut() {
    if (!accountClient) return;
    const { error } = await accountClient.auth.signOut({ scope: 'local' });
    if (error) setError('Sign-out could not complete. Try again.');
  }
  if(imports && session && store)return <ImportApp key={session.user.id} store={store} persistent />;
  return <div className="app"><aside className="sidebar"><div className="brand"><span>t</span> TLH <small>ACCOUNTS</small></div>
    <p className="eyebrow">WORKSPACE</p><a className="nav" href="/">Local import pilot ↗</a><div className="nav active">Accounts</div><a className="nav" href="/?workspace=imports">Persistent imports ↗</a>
    <div className="local-note"><strong>Local Supabase</strong><p>Manage your sign-in and account labels. Use Persistent imports to review and save brokerage files.</p></div></aside>
    <main><div className="topline"><span>PHASE 4B.1 · ACCOUNTS</span>{session && <Button onClick={signOut}>Sign out</Button>}</div>
      <header><h1>Your portfolios and accounts.</h1><p>Group brokerage accounts and classify them before connecting imports.</p></header>
      {error && <Alert severity="error">{error}</Alert>}
      {!accountClient ? <section className="card"><h2>Connect a development project</h2><p>Supabase is not configured for this build. The local import pilot remains available.</p><p>Follow the Phase 4B.1 setup guide to configure sign-in and account storage.</p></section>
        : loading ? <p role="status">Checking sign-in…</p>
        : session ? <AccountWorkspace key={session.user.id} client={accountClient} userId={session.user.id} email={session.user.email ?? ''} />
        : <SignIn client={accountClient} />}
    </main></div>;
}

function SignIn({ client }: { client: SupabaseClient }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const result = register
        ? await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: `${location.origin}/?workspace=accounts` } })
        : await client.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      setPassword('');
      if (register && !result.data.session) setMessage('Check your email to confirm registration, then return here to sign in.');
    } catch { setError(register ? 'Registration could not complete. Check your details or try again later.' : 'Sign-in failed. Check your email and password, or try again later.'); }
    finally { setBusy(false); }
  }
  return <section className="card"><h2>{register ? 'Create your sign-in' : 'Sign in'}</h2>
    <p>Use a test sign-in for the development project.</p>{error && <Alert severity="error">{error}</Alert>}{message && <Alert severity="success">{message}</Alert>}
    <form onSubmit={submit}><div className="form-grid">
      <TextField required type="email" autoComplete="email" label="Email" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/>
      <TextField required type="password" autoComplete={register ? 'new-password' : 'current-password'} label="Password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy} slotProps={{htmlInput:{minLength:register ? 12 : undefined}}}/>
    </div>{register && <p className="muted">Use at least 12 characters. Email confirmation may be required.</p>}
    <div className="section-end"><Button disabled={busy} onClick={()=>{setRegister(!register);setError('');setMessage('');setPassword('');}}>{register ? 'Back to sign in' : 'Create sign-in'}</Button><Button type="submit" variant="contained" disabled={busy}>{busy ? 'Working…' : register ? 'Register' : 'Sign in'}</Button></div></form>
  </section>;
}

function AccountWorkspace({client, userId, email}: {client:SupabaseClient;userId:string;email:string}) {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]); const [accounts, setAccounts] = useState<Account[]>([]);
  const [portfolioId, setPortfolioId] = useState(''); const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null); const [label, setLabel] = useState(''); const [broker, setBroker] = useState('schwab');
  const [type, setType] = useState('unknown'); const [suffix, setSuffix] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(true); const [ready, setReady] = useState(false);
  useEffect(()=> {
    let active = true;
    Promise.all([client.from('portfolios').select('id,name').order('created_at'), client.from('accounts').select('id,portfolio_id,label,broker,masked_identifier,account_type').order('created_at')])
      .then(([p,a])=> {if (!active) return; if(p.error || a.error) {setError('Accounts could not load. Check the connection and database setup.');return;} setPortfolios(p.data);setAccounts(a.data);setPortfolioId(p.data[0]?.id ?? '');setReady(true);})
      .catch(()=>{if(active)setError('Accounts could not load. Try refreshing.');})
      .finally(()=>{if(active)setBusy(false);});
    return ()=>{active=false;};
  },[client,userId]);
  async function createPortfolio(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError('');
    try {const {data,error}=await client.from('portfolios').insert({user_id:userId,name:name.trim()}).select('id,name').single();if(error)throw error;setPortfolios(p=>[...p,data]);setPortfolioId(data.id);setName('');resetAccount();}
    catch {setError('Portfolio could not be created. Use a distinct name and check the connection.');} finally{setBusy(false);}
  }
  function resetAccount(){setEditing(null);setLabel('');setBroker('schwab');setType('unknown');setSuffix('');}
  async function saveAccount(e:React.FormEvent){
    e.preventDefault();setBusy(true);setError('');
    const values={label:label.trim(),broker:broker.trim(),account_type:type,masked_identifier:suffix || null};
    try {
      const request=editing ? client.from('accounts').update(values).eq('id',editing) : client.from('accounts').insert({...values,portfolio_id:portfolioId,user_id:userId});
      const {data,error}=await request.select('id,portfolio_id,label,broker,masked_identifier,account_type').single();if(error)throw error;
      setAccounts(a=>editing ? a.map(old=>old.id===editing ? data : old) : [...a,data]);resetAccount();
    }catch{setError('Account could not be saved. Check its label, last four digits, and connection.');}finally{setBusy(false);}
  }
  return <><p className="muted">Signed in as {email}</p><Alert severity="info">Account labels are saved to your development project. Use Persistent imports to add holdings after review.</Alert>
    {error && <Alert severity="error">{error}</Alert>}
    <section className="card"><h2>Portfolios</h2><form onSubmit={createPortfolio}><div className="form-grid"><TextField required label="New portfolio name" value={name} onChange={e=>setName(e.target.value)} disabled={busy || !ready} slotProps={{htmlInput:{maxLength:100}}}/><Button type="submit" variant="contained" disabled={busy || !ready || !name.trim()}>Create portfolio</Button></div></form></section>
    {portfolios.length>0 && <section className="card"><h2>Brokerage accounts</h2><TextField select fullWidth label="Portfolio" value={portfolioId} disabled={busy} onChange={e=>{setPortfolioId(e.target.value);resetAccount();}}>{portfolios.map(p=><MenuItem value={p.id} key={p.id}>{p.name}</MenuItem>)}</TextField>
      <div className="file-list">{accounts.filter(a=>a.portfolio_id===portfolioId).map(a=><div className="file" key={a.id}><div><strong>{a.label}</strong><small>{a.broker} · {accountTypes.find(([v])=>v===a.account_type)?.[1]}{a.masked_identifier ? ` · …${a.masked_identifier}` : ''}</small></div><Button disabled={busy} onClick={()=>{setEditing(a.id);setLabel(a.label);setBroker(a.broker);setType(a.account_type);setSuffix(a.masked_identifier ?? '');}}>Edit {a.label}</Button></div>)}</div>
      <h3>{editing ? 'Edit account' : 'Add account'}</h3><form onSubmit={saveAccount}><div className="form-grid">
        <TextField required label="Account label" value={label} disabled={busy} onChange={e=>setLabel(e.target.value)} slotProps={{htmlInput:{maxLength:100}}}/>
        <TextField required label="Broker" value={broker} disabled={busy} onChange={e=>setBroker(e.target.value)} slotProps={{htmlInput:{maxLength:80}}}/>
        <TextField select label="Account type" value={type} disabled={busy} onChange={e=>setType(e.target.value)}>{accountTypes.map(([v,l])=><MenuItem value={v} key={v}>{l}</MenuItem>)}</TextField>
        <TextField label="Last four digits (optional)" value={suffix} disabled={busy} onChange={e=>setSuffix(e.target.value)} slotProps={{htmlInput:{maxLength:4,pattern:'[0-9]{4}',inputMode:'numeric'}}} helperText="A display hint, never an automatic account match."/>
      </div><div className="section-end">{editing ? <Button disabled={busy} onClick={resetAccount}>Cancel edit</Button> : <span>Use a label you can recognize during import.</span>}<Button variant="contained" type="submit" disabled={busy || !label.trim() || !broker.trim()}>{editing ? 'Save account' : 'Add account'}</Button></div></form>
    </section>}
    <DataPrivacy client={client} email={email} onDeleted={()=>{setAccounts([]);setPortfolios([]);setPortfolioId('');resetAccount();}}/>
    {!busy && ready && !portfolios.length && <p>Create your first portfolio to add brokerage accounts.</p>}
  </>;
}

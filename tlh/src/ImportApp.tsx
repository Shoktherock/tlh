import UploadHub from './UploadHub';
import RealizedLosses from './RealizedLosses';
import QuotePanel from './QuotePanel';
import AlertInbox from './AlertInbox';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Chip, Dialog, DialogContent, DialogTitle, FormControlLabel, MenuItem, TextField } from '@mui/material';
import { readSource, decodeSourceBytes } from './import/sources.mjs';
import { emptyState, previewImport } from './import/engine.mjs';
import * as localStore from './import/store.mjs';
import { sumDecimals } from '../../browser-helper/src/decimal.mjs';
import { sampleFiles } from './sample.mjs';
import Recovery from './Recovery';
import Reconciliation from './Reconciliation';
import {reconciliationIssues} from './import/reconciliation.mjs';
import Corrections from './Corrections';
import {correctionView} from './import/corrections.mjs';
import ManualEntry from './ManualEntry';
import Valuation from './Valuation';
import AnalysisInputs from './AnalysisInputs';
import Activity from './Activity';
import LossCandidates from './LossCandidates';
import Dashboard from './Dashboard';
import SaleTracking from './SaleTracking';
const decimal = (value: string | null | undefined) => {
  if (value == null) return 'Unknown';
  const [whole, fraction] = value.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
};
const formatTime = (value: string | null) => value ? value.includes('T') ? new Date(value).toLocaleString() : value : 'Unknown';
const download = (name: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export default function ImportApp({ store = localStore, persistent = false }: { store?: any; persistent?: boolean }) {
  const { readState, commitImport } = store;
  const [routedUpload,setRoutedUpload]=useState<any>(null);
  const [pricesOpen,setPricesOpen]=useState(false);
  const [alertFocus,setAlertFocus]=useState<any>(null);
  const [state, setState] = useState<any>(emptyState());
  const [tab, setTab] = useState(persistent && new URLSearchParams(window.location.search).get('view')==='dashboard'?'Dashboard':'Import');
  const [sources, setSources] = useState<any[]>([]);
  const [accountId, setAccountId] = useState(''); const [accountLabel, setAccountLabel] = useState('');
  const [accountType, setAccountType] = useState('unknown'); const [currency, setCurrency] = useState('');
  const [sourceAccountRef, setSourceAccountRef] = useState(''); const [completeAccount, setCompleteAccount] = useState(false);
  const [preview, setPreview] = useState<any>(null); const [selected, setSelected] = useState<string[]>([]);
  const [mappingReviewed, setMappingReviewed] = useState(false); const [timingReviewed, setTimingReviewed] = useState(false);
  const [reason, setReason] = useState(''); const [includeCash, setIncludeCash] = useState(true);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(''); const [page, setPage] = useState(0); const [detail, setDetail] = useState<any>(null);
  const [resumed,setResumed]=useState<any>(null);
  const [correctionTarget,setCorrectionTarget]=useState<any>(null);

  const [providerResult,setProviderResult]=useState<any>({items:[]}),[priceMode,setPriceMode]=useState('provider');
  const [scenarioPrices,setScenarioPrices]=useState<any[]>([]),[valuationTime,setValuationTime]=useState(()=>new Date().toISOString());
  useEffect(() => { readState().then(setState).catch(e => setError(e.message)); }, []);
  const options = useMemo(() => ({ accountId: accountId || null, accountLabel, accountType, currency: currency || null, sourceAccountRef, completeAccount }), [accountId, accountLabel, accountType, currency, sourceAccountRef, completeAccount]);
  useEffect(() => { setPreview(null); setMappingReviewed(false); setTimingReviewed(false); }, [options, sources]);
  useEffect(()=>{if(resumed){setPreview(resumed);setSelected(resumed.sources.find(s=>s.kind==='manual')?.data.positions.map(p=>p.symbol)??resumed.rows.map(r=>r.symbol));setIncludeCash(true);setReason('');setResumed(null);}},[resumed]);
  const sourceAccounts = sources.find(s => s.kind === 'snapshot')?.data.accounts ?? [];
  const effective=useMemo(()=>correctionView(state),[state]);
  const activeHoldings = Object.entries(effective.holdings).flatMap(([id, holdings]: any) => Object.entries(holdings).filter(([, h]: any) => h.active).map(([symbol, h]: any) => ({ ...h, symbol, accountId: id })));
  const reconciliation=useMemo(()=>reconciliationIssues(state),[state]);
  const reviewHoldings=new Set(reconciliation.filter(i=>i.active).map(i=>JSON.stringify([i.accountId,i.symbol]))).size;
  const basisCurrencies = new Set(activeHoldings.map(h => h.confirmedCurrency ?? h.position.currency));
  const basis = basisCurrencies.size === 1 && !basisCurrencies.has(null) ? sumDecimals(activeHoldings.map(h => h.position.total_basis)) : null;
  const visibleRows = (tab === 'Import' ? preview?.rows ?? [] : activeHoldings).filter(r => r.symbol.toLowerCase().includes(search.toLowerCase()));
  const needsReason = preview && (preview.rows.some(r => selected.includes(r.symbol) && r.requiresReason) || preview.issues.some(i => i.code === 'CSV_BASIS_TOTAL' || (i.code === 'SOURCE_CONFLICT' && (!i.symbol || selected.includes(i.symbol)))) || (includeCash && preview.cash?.requiresReason));
  const canAccept = preview && mappingReviewed && timingReviewed && (!needsReason || reason.trim()) && (selected.length || (includeCash && preview.cash)) && !busy;

  async function addFiles(files: { name: string; text: string }[]) {
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try {
      const parsed: any[] = [];
      for (const file of files) parsed.push(await readSource(file));
      const next = [...sources]; for (const source of parsed) if (!next.some(s => s.id === source.id)) next.push(source);
      setSources(next);
      const accounts = next.find(s => s.kind === 'snapshot')?.data.accounts;
      if (accounts?.length === 1) setSourceAccountRef(accounts[0].account_ref);
    } catch (e: any) { setError(`${e.message} The selected files were not added.`); }
    finally { setBusy(false); }
  }
  async function buildPreview() {
    setBusy(true); setError(''); setMessage(''); setPreview(null); setMappingReviewed(false); setTimingReviewed(false);
    try {
      const latest = await readState(); setState(latest);
      const result = await (store.buildPreview ?? previewImport)(latest, sources, options);
      setPreview(result); setSelected(result.sources.find(s=>s.kind==='manual')?.data.positions.map(p=>p.symbol)??result.rows.map(r => r.symbol)); setIncludeCash(true); setReason(result.sources.find(s=>s.kind==='manual')?.data.reason??''); setPage(0); setSearch('');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function accept() {
    setBusy(true); setError('');
    try {
      const result: any = await commitImport(preview, { symbols: selected, includeCash, mappingReviewed, timingReviewed, reason });
      setState(result.state); const batch = result.state.imports.find(i => i.id === result.importId);
      setAccountId(batch.accountId); setPreview(null); setMessage(result.duplicate ? 'Already imported. No holdings or history were duplicated.' : `Import accepted. ${selected.length} selected holdings reviewed in one transaction.`);
      setTab('Portfolio'); setPage(0); setSearch('');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function showSource(source:any){
    try{setDetail({title:source.name,source:source.text ?? await store.readSource(source)});}catch(e:any){setError(e.message);}
  }
  async function discardUploads(){
    setBusy(true);setError('');
    try{await store.discard();setPreview(null);setMessage('Unaccepted staged uploads discarded. Accepted holdings and originals are retained.');}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  const switchTab = (name: string) => { setAlertFocus(null); setTab(name); setPage(0); setSearch(''); };
  function resumeImport(plan:any){
    const o=plan.options;setAccountId(o.accountId);setAccountLabel(o.accountLabel);setAccountType(o.accountType);setCurrency(o.currency??'');setSourceAccountRef(o.sourceAccountRef);setCompleteAccount(o.completeAccount);
    setSources(plan.sources);setError('');setMessage('Saved preview recovered. Review the selected scopes before accepting.');setResumed(plan);setMappingReviewed(false);setTimingReviewed(false);switchTab('Import');
  }
  return <div className="app">
    <aside className="sidebar"><div className="brand"><span>t</span> TLH <small>PORTFOLIO</small></div><p className="eyebrow">WORKSPACE</p>
      {persistent&&<nav aria-label="Planning workspace">{[['Loss candidates','Opportunities'],['Dashboard','Results'],['Import','Data & accounts']].map(([name,label])=>{const active=name==='Dashboard'?['Dashboard','Tracking'].includes(tab):name==='Import'?!['Dashboard','Tracking','Loss candidates','Replacements','Alerts'].includes(tab):['Loss candidates','Replacements'].includes(tab);return <button key={name} className={active?'nav active':'nav'} aria-current={active?'page':undefined} onClick={()=>switchTab(name)}>{label}</button>;})}</nav>}
      {persistent&&<button className={tab==='Alerts'?'nav active':'nav'} onClick={()=>switchTab('Alerts')}>Notifications</button>}
      {(!persistent||!['Dashboard','Tracking','Loss candidates','Replacements','Alerts'].includes(tab))&&<div className="data-navigation"><nav aria-label="Data tools">{['Import','Portfolio',...(persistent?['Activity']:[]),'Valuation'].map(name=><button key={name} className={tab===name?'nav active':'nav'} onClick={()=>switchTab(name)}>{({Import:'Upload files',Portfolio:'Holdings',Activity:'Transactions',Valuation:'Prices'} as any)[name]}</button>)}<a className="nav" href="/?workspace=accounts">Accounts & sign-in</a></nav><details open={['Manual entry','Analysis inputs','Reconciliation','Corrections','History','Recovery'].includes(tab)}><summary>Advanced tools</summary><nav aria-label="Advanced data tools">{[...(persistent?['Manual entry','Analysis inputs']:[]),'Reconciliation',...(persistent?['Corrections']:[]),'History',...(persistent?['Recovery']:[])].map(name=><button key={name} className={tab===name?'nav active':'nav'} onClick={()=>{if(name==='Corrections')setCorrectionTarget(null);switchTab(name);}}>{name}</button>)}</nav></details></div>}
      <div className="local-note"><strong>{persistent ? 'Your data' : 'Local import pilot'}</strong><p>{persistent ? 'Review imported evidence before accepting it. Holdings change only when you accept.' : 'Files and accepted holdings stay in this browser. Export a backup before clearing browser data.'}</p>{persistent ? <><a href="/?workspace=pilot">Open local pilot</a><Button size="small" disabled={busy} onClick={discardUploads}>Discard staged uploads</Button></> : <Button size="small" disabled={!state.imports.length} onClick={() => download('tlh-local-portfolio-backup.json', JSON.stringify(state, null, 2))}>Export backup</Button>}</div></aside>
    <main><div className="topline"><span>{persistent ? 'PORTFOLIO PLANNING' : 'IMPORT & RECONCILIATION'}</span><span>{state.accounts.length} accounts · revision {state.revision}</span></div>
      {persistent&&['Dashboard','Tracking'].includes(tab)&&<nav className="section-navigation" aria-label="Results views"><Button aria-current={tab==='Dashboard'?'page':undefined} onClick={()=>switchTab('Dashboard')}>Overview</Button><Button aria-current={tab==='Tracking'?'page':undefined} onClick={()=>switchTab('Tracking')}>Sales & follow-up</Button></nav>}
      {persistent&&['Dashboard','Loss candidates'].includes(tab)&&<div className="price-toolbar"><span>Daily closing prices · not live quotes</span><Button variant="outlined" onClick={()=>setPricesOpen(true)}>Update prices</Button></div>}
      {pricesOpen&&<Dialog open onClose={()=>setPricesOpen(false)} maxWidth="md" fullWidth aria-labelledby="update-prices-title"><DialogTitle id="update-prices-title">Update market prices</DialogTitle><DialogContent><p>Choose a closing date and fetch prices. Your current page updates when you close this panel.</p><QuotePanel rows={activeHoldings} request={store.quotes} onResult={setProviderResult} onRefreshTime={()=>setValuationTime(new Date().toISOString())}/><Button onClick={()=>setPricesOpen(false)}>Done</Button></DialogContent></Dialog>}
      {tab==='Alerts'&&persistent&&<AlertInbox store={store} onOpen={target=>{if(['Tracking','Loss candidates','Valuation','Reconciliation'].includes(target.view)){switchTab(target.view);setAlertFocus(target);}}}/>}
      {tab==='Tracking'&&persistent&&<SaleTracking initialSaleId={alertFocus?.saleId} store={store} onActivity={()=>switchTab('Activity')}/>}
      {!['Tracking','Alerts','Loss candidates','Dashboard'].includes(tab)&&<header><div><h1>{tab==='Replacements'?'Review a potential trade.':tab==='Dashboard'?'Your portfolio':tab==='Loss candidates'?'Find opportunities worth reviewing.':tab==='Activity'?'Review supplied activity and history gaps.':tab==='Analysis inputs'?'Set the assumptions for your analysis.':tab==='Valuation'?'Value your accepted holdings.':tab==='Manual entry'?'Bring in evidence by hand.':tab==='Corrections'?'Review and record corrections.':tab==='Reconciliation'?'Review the gaps in your evidence.':tab === 'Recovery'?'Back up, restore, and resume.':tab === 'Import' ? 'Data & accounts' : tab==='Realized import'?'Review realized report.' : tab === 'Portfolio' ? 'Your accepted holdings.' : 'Every import, preserved.'}</h1><p>{tab==='Replacements'?'Review dated membership and explainable exposure comparisons.':tab==='Dashboard'?'A clear view of your investments and tax-loss activity.':tab==='Loss candidates'?'Inspect source evidence, missing history and conditional tax scenarios.':tab==='Activity'?'Keep transaction evidence separate from holdings, with explicit overlap decisions and coverage.':tab==='Analysis inputs'?'Review rate assumptions, account inclusion, and the history records you have available.':tab==='Valuation'?'Explore unrealized gains and losses with explicit prices and visible evidence gaps.':tab==='Manual entry'?'Transcribe what you observed, then review it through the import workflow.':tab==='Corrections'?'Keep verified changes attached to their original evidence.':tab==='Reconciliation'?'Trace data gaps, source disagreements, and timing uncertainty to the accepted files.':tab === 'Recovery'?'Review saved evidence and recover unfinished work.':tab === 'Import' ? 'Stage the files, review the evidence, then accept the scopes you choose.' : tab === 'Portfolio' ? 'Positions and lot evidence describe the same holdings. Their quantities are never added together.' : 'Original files, review decisions, and earlier holdings remain attached to each accepted import.'}</p></div></header>}
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}{message && <Alert severity="success" onClose={() => setMessage('')}>{message}</Alert>}
      {tab==='Dashboard'&&persistent&&<Dashboard store={store} prices={scenarioPrices} providerResult={providerResult} priceMode={priceMode} asOf={valuationTime} onProvider={setProviderResult} onState={setState} onNavigate={switchTab}/>} 
      {tab==='Corrections'&&persistent&&<Corrections state={state} store={store} onChanged={setState} initial={correctionTarget}/>}
      {tab==='Analysis inputs'&&persistent&&<AnalysisInputs store={store}/>}
      {tab==='Activity'&&persistent&&<Activity store={store} initialFile={routedUpload?.kind==='activity'?routedUpload.file:null} onFileConsumed={()=>setRoutedUpload(null)}/>} 

      {tab==='Loss candidates'&&persistent&&<LossCandidates initialFilter={alertFocus} store={store} prices={scenarioPrices} providerResult={providerResult} priceMode={priceMode} asOf={valuationTime} onNavigate={switchTab}/>} 
      {tab==='Valuation'&&<Valuation providerResult={providerResult} setProviderResult={setProviderResult} priceMode={priceMode} setPriceMode={setPriceMode} state={state} prices={scenarioPrices} onPrices={setScenarioPrices} asOf={valuationTime} onAsOf={setValuationTime} onRefresh={async()=>setState(await readState())} onReconcile={()=>switchTab('Reconciliation')} quoteRequest={persistent?store.quotes:undefined}/>}
      {tab==='Manual entry'&&persistent&&<ManualEntry state={state} onStage={async(file,id)=>{const source=await readSource(file);setSources([source]);setAccountId(id);setAccountType(state.accounts.find(a=>a.id===id).type);setCurrency('');setSourceAccountRef('');setCompleteAccount(false);setError('');setMessage('Manual evidence staged. Build the import preview, review account mapping and coverage, then accept.');switchTab('Import');}}/>}
      {tab==='Recovery'&&persistent&&<Recovery store={store} state={state} onRestored={setState} onResume={resumeImport}/>}
      {tab==='Reconciliation'&&<Reconciliation state={state} issues={reconciliation} store={store} onRefresh={async()=>setState(await readState())} onCorrect={persistent?(target=>{setCorrectionTarget(target);switchTab('Corrections');}):undefined}/>}
      {tab==='Realized import'&&persistent&&<RealizedLosses importOnly store={store} accounts={state.accounts} initialFile={routedUpload?.kind==='realized'?routedUpload.file:null} onFileConsumed={()=>setRoutedUpload(null)} onTracking={()=>switchTab('Tracking')}/>}
      {tab === 'Import' && <>
        {persistent&&<UploadHub onRoute={async(kind,files)=>{if(kind==='holdings'){await addFiles(files);}else{setRoutedUpload({kind,file:files[0]});switchTab(kind==='activity'?'Activity':'Realized import');}}}/>}
        <details open={!persistent||sources.length>0}><summary>Holdings import review & manual file selection</summary>
        {persistent && <Alert severity="info">Build preview uploads these files to private local Supabase storage. Choose an account created on the Accounts page; accepted holdings remain unchanged until you confirm the preview.</Alert>}
        <section className="card"><div className="section-title"><span className="step">01</span><div><h2>Source files</h2><p>Helper JSON, Schwab Positions CSV, per-security Lot Details CSV, or the manual evidence template.</p></div></div>
          <div className="file-zone"><div><strong>Choose your brokerage exports</strong><p>One helper snapshot and one Positions CSV per batch. The CSV supplies position totals; the snapshot supplies lots. Add a Lot Details CSV only for a security without a lot scope in the helper snapshot.</p></div><Button variant="contained" component="label" disabled={busy}>Choose files<input aria-label="Source files" type="file" hidden multiple accept=".json,.csv" onChange={async e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; try { await addFiles(await Promise.all(files.map(async f => ({ name: f.name, text: decodeSourceBytes(await f.arrayBuffer()) })))); } catch { setError('The selected files could not be read.'); } }} /></Button></div>
          <div className="file-list">{sources.map(source => <div className="file" key={source.id}><div><strong>{source.name}</strong><small>{source.kind} · SHA-256 {source.id.slice(0, 12)}…</small></div><Button size="small" onClick={() => setDetail({ title: source.name, source: source.text })}>View source</Button><Button size="small" disabled={busy} onClick={() => setSources(sources.filter(s => s.id !== source.id))}>Remove</Button></div>)}</div>
          {!sources.length && <Button size="small" disabled={busy} onClick={() => addFiles(sampleFiles())}>Try synthetic sample files</Button>}
        </section>
        <section className="card"><div className="section-title"><span className="step">02</span><div><h2>Account & source decisions</h2><p>Map the files explicitly. Account labels and masked suffixes are display hints.</p></div></div>
          <div className="form-grid"><TextField select label="Target account" value={accountId} slotProps={{select:{displayEmpty:true},inputLabel:{shrink:true}}} onChange={e => { setAccountId(e.target.value); const a = state.accounts.find(a => a.id === e.target.value); if (a) setAccountType(a.type); }}><MenuItem value="">{persistent ? 'Choose an existing account' : 'Create a new local account'}</MenuItem>{state.accounts.map(a => <MenuItem key={a.id} value={a.id}>{a.portfolioName ? `${a.portfolioName} / ${a.label}` : a.label}</MenuItem>)}</TextField>
            {!accountId && !persistent && <TextField label="Account label" value={accountLabel} onChange={e => setAccountLabel(e.target.value)} placeholder="e.g. My Schwab trust" />}
            <TextField select label="Account type" value={accountType} disabled={Boolean(accountId)} onChange={e => setAccountType(e.target.value)}>{[['unknown','Unknown'],['taxable','Taxable'],['traditional_ira','Traditional IRA'],['roth_ira','Roth IRA'],['other','Other']].map(([value,label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField>
            <TextField select label="Confirmed currency" value={currency} slotProps={{select:{displayEmpty:true},inputLabel:{shrink:true}}} onChange={e => setCurrency(e.target.value)}><MenuItem value="">Keep unknown</MenuItem><MenuItem value="USD">USD — confirmed by me</MenuItem></TextField>
            {sourceAccounts.length > 0 && <TextField select label="Snapshot source account" value={sourceAccountRef} onChange={e => setSourceAccountRef(e.target.value)}>{sourceAccounts.map(a => <MenuItem key={a.account_ref} value={a.account_ref}>{a.display_label} · {a.account_ref}</MenuItem>)}</TextField>}</div>
          <p className="muted">Currency confirmation is stored as your decision. Original source currencies and unknown effective dates are preserved.</p>
          {sources.some(s => s.kind === 'positions') && <FormControlLabel control={<Checkbox checked={completeAccount} onChange={e => setCompleteAccount(e.target.checked)} />} label="I verified that this Positions CSV includes every holding with no limiting filters. Preview eligible removals." />}
          <div className="section-end"><span>No portfolio changes until you accept.</span><Button variant="contained" disabled={busy || !sources.length || (persistent && !accountId)} onClick={buildPreview}>{busy ? 'Working…' : 'Build preview'}</Button></div>
        </section>
        {preview && <section className="card" id="preview"><div className="section-title"><span className="step">03</span><div><h2>Review & accept</h2><p>{preview.rows.length} holdings · {preview.rows.filter(r => r.next.lotScope).reduce((n,r) => n + r.next.lotScope.lots.length, 0)} retained or incoming lot rows · transaction history unknown</p></div></div>
          <div className="summary-strip">{['add','update','unchanged','retain','archive','close'].map(action => <div key={action}><strong>{preview.rows.filter(r => r.action === action).length}</strong><span>{action}</span></div>)}</div>
          <details className="source-review"><summary>Source accounts, timestamps, and import issues</summary>{preview.labels.map((label,i) => <p key={i}>{label}</p>)}{preview.timing.map(t => <p key={t.name}>{t.name}: {formatTime(t.from)} — {formatTime(t.to)}</p>)}<p>Helper timestamps are observation times. Unknown broker effective dates remain unknown; totals matching across files do not verify lot acquisition dates.</p>{preview.issues.map((i,index) => <p key={index}>{i.code}: {i.message}</p>)}</details>
          {Boolean(preview.correctionConflicts?.length)&&<Alert severity="warning">This import changes evidence supporting manual corrections for {[...new Set(preview.correctionConflicts.map(c=>c.symbol))].join(', ')}. Accepting those securities suspends the affected corrections and displays imported values until you review them in Corrections. A review reason is required.</Alert>}
          {preview.sources.filter(s=>s.kind==='manual').map(s=><Alert key={s.id} severity="info">Manually entered evidence · {s.data.account_label} · {s.data.reference}. {s.data.positions.map(p=>`${p.symbol}: ${p.lots?`${p.lots.rows.length} observed rows, ${p.lots.coverage} lot coverage`:'position only'}`).join('; ')}. Only securities in this manual source are selected by default.</Alert>)}
          {table(true)}
          {preview.cash && <div className="cash-review"><FormControlLabel control={<Checkbox checked={includeCash} onChange={e => setIncludeCash(e.target.checked)} />} label={`Include cash observation · ${decimal(preview.cash.candidate.amount)} ${currency || '(currency unknown)'} · ${preview.cash.action}`} /><small>Cash is stored separately and creates no tax lots.</small></div>}
          <div className="acceptance"><FormControlLabel control={<Checkbox checked={mappingReviewed} onChange={e => setMappingReviewed(e.target.checked)} />} label="I reviewed all source account labels and confirm these files belong to the target account." /><FormControlLabel control={<Checkbox checked={timingReviewed} onChange={e => setTimingReviewed(e.target.checked)} />} label="I reviewed source times and unknown dates, currency, incomplete lots, and the selected changes." />
            <TextField fullWidth multiline minRows={2} label={needsReason ? 'Review reason (required)' : 'Review note (optional)'} value={reason} onChange={e => setReason(e.target.value)} helperText="Conflicts remain unresolved after acceptance. No transactions or tax conclusions are created." />
            <div className="section-end"><span>{selected.length} holdings selected{includeCash && preview.cash ? ' + cash' : ''}</span><Button variant="contained" disabled={!canAccept} onClick={accept}>Accept selected scopes</Button></div></div>
        </section>}
        </details>
      </>}
      {tab === 'Portfolio' && <>{effective.correctionStates.length>0&&<Alert severity="info">Holdings below include {effective.correctionStates.filter(c=>c.status==='active').length} applied corrections. {effective.correctionStates.filter(c=>c.status==='conflict').length} corrections are suspended pending review. Open Corrections to review the original and effective values.</Alert>}<div className="metrics"><div><small>ACTIVE HOLDINGS</small><strong>{activeHoldings.length}</strong></div><div><small>LOT ROWS</small><strong>{activeHoldings.reduce((n,h) => n + (h.lotScope?.lots.length ?? 0), 0)}</strong></div><div><small>{effective.correctionStates.some(c=>c.status==='active')?'REVIEWED BASIS · SOURCE UNITS':'REPORTED BASIS · SOURCE UNITS'}</small><strong>{decimal(basis)}</strong></div><div><small>HOLDINGS NEEDING REVIEW</small><strong>{reviewHoldings}</strong><Button size="small" onClick={()=>switchTab('Reconciliation')}>Open reconciliation</Button></div></div>
        <section className="card"><h2>Holdings</h2>{!activeHoldings.length ? <p>No accepted holdings yet. Start with an import preview.</p> : table(false)}</section>
        <section className="card"><h2>Cash by account</h2>{Object.entries(state.cash).map(([id,c]: any) => <p key={id}>{state.accounts.find(a => a.id === id)?.label}: <strong>{decimal(c.amount)} {c.confirmedCurrency ?? c.currency ?? '(currency unknown)'}</strong> · effective date {c.effective_date ?? 'unknown'}</p>)}{!Object.keys(state.cash).length && <p>No cash observation accepted.</p>}<p className="muted">Use Valuation and Loss candidates to review supplied prices and lot evidence. Transactions do not reconstruct these snapshots.</p></section></>}
      {tab === 'History' && <section className="card"><h2>Accepted imports</h2>{[...state.imports].reverse().map(batch => <div className="history" key={batch.id}><div><strong>{state.accounts.find(a => a.id === batch.accountId)?.label}</strong><p>{formatTime(batch.acceptedAt)} · {batch.outcomes.length} scopes · {batch.sources.length} source files</p><small>{batch.decisions.reason || 'No additional review note.'}</small></div><Button onClick={() => setDetail({ title: 'Import audit', batch })}>Review import</Button></div>)}{!state.imports.length && <p>Nothing accepted yet. Staging files does not create import history.</p>}</section>}
      <footer>{persistent ? 'Original files are private to your sign-in. Partial imports never imply a sale. The browser-only pilot remains separate.' : 'Original source evidence is preserved. Partial imports never imply a sale. Local browser storage is not a backup or a multi-user database.'}</footer>
    </main><Dialog open={Boolean(detail)} onClose={() => setDetail(null)} fullWidth maxWidth="md"><DialogTitle>{detail?.title}<Button style={{float:'right'}} onClick={() => setDetail(null)}>Close</Button></DialogTitle><DialogContent>
      {detail?.source && <pre>{detail.source}</pre>}{detail?.row && holdingDetails(detail.row)}
      {detail?.batch && <>{detail.batch.acceptedBy&&<p>{detail.batch.restoration?'Historical acceptance actor recorded in backup':'Accepted by signed-in user'}: {detail.batch.acceptedBy}</p>}<p>{detail.batch.sourceLabels.join(' · ')}</p><p>{detail.batch.decisions.reason || 'No review note.'}</p>{detail.batch.sources.map(s => <div className="file" key={s.id}><span>{s.name}</span><Button onClick={() => showSource(s)}>View original source</Button></div>)}<pre>{JSON.stringify(detail.batch.outcomes, null, 2)}</pre></>}
    </DialogContent></Dialog>
  </div>;

  function holdingDetails(row: any) {
    const h = row.next ?? row;
    const scope = h.lotScope ?? h.supplementalScope;
    return <><p>{h.position.description ?? row.symbol} · {h.active ? 'Active position' : 'Closed current view'}</p>
      {row.current && <p>Previously accepted: {decimal(row.current.position.quantity)} shares · {decimal(row.current.position.total_basis)} basis.</p>}
      <p>{row.next ? 'Proposed' : 'Accepted'}: {decimal(h.position.quantity)} shares · {decimal(h.position.total_basis)} basis. Currency: {h.confirmedCurrency ?? h.position.currency ?? 'unknown'}.</p>
      <p>Position effective date: {formatTime(h.position.effective_at ?? h.position.effective_date)}. Lot effective date: {formatTime(scope?.effective_at ?? scope?.effective_date)}. Lot coverage: {h.lotCoverage}.</p>
      {h.warnings.map((w,i) => <Alert key={i} severity="warning" sx={{mb:1}}>{w.message}</Alert>)}
      {scope?.lots.length ? <div className="table-wrap"><table><thead><tr><th>Acquired</th><th>Quantity</th><th>Total basis</th><th>Cost/share</th><th>Broker term</th></tr></thead><tbody>{scope.lots.map((lot,i) => <tr key={i}><td>{lot.acquisition_date ?? 'Unknown'}</td><td>{decimal(lot.quantity)}</td><td>{decimal(lot.total_basis)}</td><td>{decimal(lot.cost_per_share)}</td><td>{lot.broker_holding_period ?? 'Unknown'}</td></tr>)}</tbody></table></div> : <p>No lot rows. The position is retained without invented lots.</p>}</>;
  }

  function table(staged: boolean) {
    return <><div className="table-tools"><TextField size="small" label="Find security" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />{staged && <div><Button onClick={() => setSelected(preview.rows.map(r => r.symbol))}>Select all</Button><Button onClick={() => setSelected([])}>Select none</Button></div>}<span>{visibleRows.length} rows</span></div>
      <div className="table-wrap"><table><thead><tr>{staged && <th>Select</th>}<th>Security</th><th>Quantity</th><th>Total basis</th><th>Lots / coverage</th><th>{staged ? 'Change' : 'Account'}</th><th>Review</th></tr></thead><tbody>{visibleRows.slice(page * 25, (page + 1) * 25).map((row: any) => { const h = staged ? row.next : row; return <tr key={`${row.accountId ?? ''}/${row.symbol}`}>
        {staged && <td><Checkbox size="small" checked={selected.includes(row.symbol)} slotProps={{input:{'aria-label':`Include ${row.symbol}`}}} onChange={e => setSelected(e.target.checked ? [...selected,row.symbol] : selected.filter(s => s !== row.symbol))} /></td>}
        <td><strong>{row.symbol}</strong><small>{h.position.description ?? 'Snapshot holding'}</small></td><td className="numeric">{decimal(h.position.quantity)}</td><td className="numeric">{decimal(h.position.total_basis)}</td><td>{h.lotScope?.lots.length ?? h.supplementalScope?.lots.length ?? 0}<small>{h.lotCoverage}</small></td><td>{staged ? <Chip size="small" label={row.action} variant="outlined" /> : state.accounts.find(a => a.id === row.accountId)?.label}</td><td><Button size="small" onClick={() => setDetail({title:row.symbol,row})}>{h.warnings.length ? `${h.warnings.length} notes` : 'Details'}</Button></td></tr>; })}</tbody></table></div>
      <div className="pagination"><span>Page {page + 1} of {Math.max(1,Math.ceil(visibleRows.length / 25))}</span><Button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><Button disabled={(page + 1) * 25 >= visibleRows.length} onClick={() => setPage(page + 1)}>Next</Button></div></>;
  }
}





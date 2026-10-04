import SaleTracking from './SaleTracking';
import RealizedLosses from './RealizedLosses';
import React,{useEffect,useMemo,useState} from 'react';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,TextField} from '@mui/material';
import {buildDashboard} from './valuation/dashboard.mjs';
import {combineValuationPrices} from './valuation/engine.mjs';
import {activityCoverage} from './activity/engine.mjs';
import {shiftDate} from './analysis/candidates.mjs';
const display=v=>{if(v===null||v===undefined)return 'Unavailable';const [whole,fraction]=String(v).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction===undefined?'':`.${fraction}`);};
const inventory=a=>JSON.stringify(a.map(x=>[x.id,x.type]).sort((a,b)=>a[0].localeCompare(b[0])));
export default function Dashboard({store,prices,providerResult,priceMode,asOf,onProvider,onState,onNavigate}:{store:any,prices:any[],providerResult:any,priceMode:string,asOf:string,onProvider:(v:any)=>void,onState:(v:any)=>void,onNavigate:(v:string)=>void}){
  const [data,setData]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[warnings,setWarnings]=useState<string[]>([]);
  const [portfolio,setPortfolio]=useState(''),[account,setAccount]=useState(''),[termDate,setTermDate]=useState(asOf.slice(0,10)),[ordinary,setOrdinary]=useState(false),[page,setPage]=useState(0);
  async function load(initial=false){
    setBusy(true);setError('');setData(null);setWarnings([]);
    try{
      const [s,i,a,q]=await Promise.allSettled([store.readState(),store.analysis({action:'read'}),store.activity({action:'read'}),store.quotes({action:'read'})]);
      if(s.status==='rejected')throw s.reason;
      const state=s.value,problems:string[]=[];
      const inputs=i.status==='fulfilled'&&inventory(i.value.accounts)===inventory(state.accounts)?i.value:null;
      const activity=a.status==='fulfilled'&&inventory(a.value.accounts)===inventory(state.accounts)?a.value:null;
      if(!inputs)problems.push('Saved analysis inputs could not be loaded consistently. Holdings remain visible; refresh to retry.');
      if(!activity)problems.push('Activity coverage is unavailable. Refresh to retry.');
      if(q.status==='fulfilled')onProvider(q.value);else{onProvider({items:[]});problems.push('Cached quotes could not be loaded. Only available scenario prices are used.');}
      if(initial&&inputs?.input?.analysisDate)setTermDate(inputs.input.analysisDate);
      setData({state,inputs,activity,loadedAt:new Date().toISOString()});setWarnings(problems);onState(state);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  useEffect(()=>{load(true);},[store]);
  const computed=useMemo(()=>{
    if(!data)return null;
    try{
      const report=buildDashboard({state:data.state,prices:combineValuationPrices(data.state,prices,providerResult.items,asOf,priceMode),asOf,termDate,ordinaryPurchase:ordinary,portfolioId:portfolio,accountId:account});
      const range={start:shiftDate(termDate,-30),end:shiftDate(termDate,30)};
      const coverage=data.activity?activityCoverage(data.activity.state,report.accounts,range.start,range.end):null;
      return {report,coverage,range,error:null};
    }catch(e:any){return {report:null,coverage:null,range:null,error:e.message};}
  },[data,prices,providerResult,priceMode,asOf,termDate,ordinary,portfolio,account]);
  const report=computed?.report;
  const portfolios=data?[...new Map(data.state.accounts.map(a=>[a.portfolioId??'unassigned',{id:a.portfolioId??'unassigned',label:a.portfolioName??data.inputs?.accounts.find(x=>x.id===a.id)?.portfolioName??a.portfolioId??'Unassigned'}])).values()] as any[]:[];
  const label=id=>data?.inputs?.accounts.find(a=>a.id===id)?.portfolioName??data?.state.accounts.find(a=>a.id===id)?.portfolioId??'Unassigned';
  const pages=Math.max(1,Math.ceil((report?.rows.length??0)/25)),current=Math.min(page,pages-1);
  return <>
    <section className="card overview-toolbar"><h1>Portfolio overview</h1><p>Your portfolio and tax-loss activity at a glance.</p>
      <div className="table-tools"><Button disabled={busy} onClick={()=>load()}>Reload saved data</Button><Button onClick={()=>onNavigate('Import')}>Upload files</Button><Button onClick={()=>onNavigate('Loss candidates')}>Review loss candidates</Button></div>
      {busy&&<p>Loading portfolio evidence…</p>}{error&&<Alert severity="error">{error}</Alert>}{warnings.map(w=><Alert severity="warning" key={w}>{w}</Alert>)}{computed?.error&&<Alert severity="error">{computed.error}</Alert>}
      {data&&<><div className="form-grid"><TextField select label="Dashboard portfolio" value={portfolio} onChange={e=>{setPortfolio(e.target.value);setAccount('');setPage(0);}}><MenuItem value="">All portfolios</MenuItem>{portfolios.map(p=><MenuItem key={p.id} value={p.id}>{p.label} · {p.id}</MenuItem>)}</TextField><TextField select label="Dashboard account" value={account} onChange={e=>{setAccount(e.target.value);setPage(0);}}><MenuItem value="">All accounts in view</MenuItem>{data.state.accounts.filter(a=>!portfolio||(a.portfolioId??'unassigned')===portfolio).map(a=><MenuItem key={a.id} value={a.id}>{a.label} · {a.id}</MenuItem>)}</TextField>
        </div><details className="setup-drawer"><summary>Valuation assumptions & source details</summary><TextField type="date" label="Dashboard holding-period date" value={termDate} onChange={e=>setTermDate(e.target.value)} slotProps={{inputLabel:{shrink:true}}}/>
        <FormControlLabel control={<Checkbox checked={ordinary} onChange={e=>setOrdinary(e.target.checked)}/>} label="Use ordinary-purchase holding periods for this dashboard scenario."/>
        <p>Term classifications use the same conditional date rules as Loss candidates. Special or adjusted holding periods need review. This view includes all account types, independent of harvesting selections.</p>
        {termDate!==asOf.slice(0,10)&&<Alert severity="warning">The holding-period date differs from the valuation UTC date. Term totals describe a mixed-date scenario.</Alert>}
        <p>Valuation time: {asOf} · {priceMode==='scenario'?'Scenario only':'Provider with scenario fallback'}. Evidence read at {data.loadedAt}; holdings revision {data.state.revision}, inputs {data.inputs?.revision??'unavailable'}, activity {data.activity?.revision??'unavailable'}. Refresh reads cached quotes; it does not fetch new provider prices.</p></details>
      </>}
    </section>
    {report&&<>
      <div className="overview-values">{report.totals.map(t=><section className="card value-card" key={t.currency}><span className="metric-label">Priced securities · {t.currency}</span><strong className="value-number">{t.marketValue===null?'Unavailable':Number(t.marketValue).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong><p>{t.priced} of {t.positions} positions priced · excludes cash</p><div className="value-secondary"><span>Unrealized gain / loss</span><strong>{t.pnl===null?'Unavailable':Number(t.pnl).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} {t.currency}</strong></div><Button onClick={()=>onNavigate('Portfolio')}>View holdings →</Button></section>)}</div>
      <RealizedLosses store={store} accounts={report.accounts} onTracking={()=>document.getElementById('results-sales')?.scrollIntoView({behavior:'smooth'})}/>
      <section id="results-sales" aria-label="Sales and follow-up"><SaleTracking store={store} accountIds={report.accounts.map(a=>a.id)} onActivity={()=>onNavigate('Import')}/></section>
      <div className="metrics"><div><small>ACCOUNTS IN VIEW</small><strong>{report.accounts.length}</strong></div><div><small>ACCEPTED POSITIONS</small><strong>{report.positions}</strong></div><div><small>POSITIONS WITH USABLE VALUES</small><strong>{report.priced} / {report.positions}</strong></div><div><small>COMPLETE LOT COLLECTIONS</small><strong>{report.lotComplete} / {report.positions}</strong></div></div>
      {!report.positions&&<Alert severity="info">No active holdings in this view. Import holdings or select a different account. Cash observations, if present, appear below.</Alert>}
      <details className="dashboard-detail"><summary>Portfolio breakdown</summary><section className="card"><h2>Currency summaries</h2><p>Known position P/L = short-term + long-term + unresolved-term P/L. Unpriced or unknown-basis positions are counted separately; their missing amounts are never treated as zero. Term allocation requires reconciled complete lots. Prices may still be scenarios or stale observations.</p>
        <div className="table-wrap"><table aria-label="Dashboard currency summaries"><thead><tr><th>Currency</th><th>Priced securities</th><th>Reported basis</th><th>Known position P/L</th><th>Short-term scenario</th><th>Long-term scenario</th><th>Unresolved-term P/L</th><th>P/L unavailable</th></tr></thead><tbody>{report.totals.map(t=><tr key={t.currency}><td>{t.currency}</td><td className="numeric">{display(t.marketValue)}<small>{t.priced} / {t.positions} positions</small></td><td className="numeric">{display(t.basis)}<small>{t.basisKnown} / {t.positions} positions</small></td><td className="numeric">{display(t.pnl)}<small>{t.knownPnl} / {t.positions} positions</small></td><td className="numeric">{display(t.short)}</td><td className="numeric">{display(t.long)}</td><td className="numeric">{display(t.unresolved)}</td><td>{t.unavailablePnl} positions</td></tr>)}</tbody></table></div>
        {!report.totals.length&&<p>No currency totals yet.</p>}
      </section>
      <section className="card"><h2>Account totals and freshness</h2><p>Dates describe source observations, not verification that holdings are current. Complete lot collection is separate from reconciliation. Stale quote counts are relative to the displayed valuation time.</p>
        <div className="table-wrap"><table aria-label="Dashboard account totals"><thead><tr><th>Portfolio / account</th><th>Currency</th><th>Priced securities</th><th>Known P/L</th><th>Position coverage</th><th>Evidence dates</th><th>Price coverage</th></tr></thead><tbody>{report.accounts.flatMap(a=>(a.totals.length?a.totals:[{currency:'—',marketValue:null,pnl:null}]).map(t=><tr key={`${a.id}:${t.currency}`}><td>{label(a.id)} / {a.label}<small>{a.type} · {a.id}</small></td><td>{t.currency}</td><td>{display(t.marketValue)}</td><td>{display(t.pnl)}</td><td>{a.priced} / {a.positions} valued<small>{a.lotComplete} complete lot collections</small></td><td>{a.positionOldest??'Unknown'} through {a.positionNewest??'Unknown'}<small>{a.positionUnknown} unknown position dates; {a.lotTimeUnknown} unknown lot dates</small></td><td>{a.scenario} scenario prices<small>{a.prices.stale} stale; {a.prices['time-unknown']} unknown time; {a.prices.missing} missing; {a.prices.invalid+a.prices.future} invalid/future</small></td></tr>))}</tbody></table></div>
      </section>
      <section className="card"><h2>Cash observations</h2><p>Cash is not included in priced securities or P/L. {report.cashMissing} account(s) in view have no cash observation.</p><div className="table-wrap"><table aria-label="Dashboard cash"><thead><tr><th>Account</th><th>Reported amount</th><th>Currency</th><th>Effective date</th><th>Status</th></tr></thead><tbody>{report.cash.map(c=><tr key={c.accountId}><td>{c.label}</td><td>{display(c.amount)}</td><td>{c.currency??'Unknown / conflicting'}</td><td>{c.date??'Unknown'}</td><td>{c.reason??'Known reported amount'}</td></tr>)}</tbody></table></div>{report.totals.filter(t=>t.cashReported).map(t=><p key={t.currency}>{t.currency} cash subtotal: {display(t.cash)} · {t.cashKnown} / {t.cashReported} usable observations.</p>)}</section>
      <section className="card"><h2>History coverage</h2><p>Supplied activity for {computed?.range?.start} through {computed?.range?.end}, inclusive. These are collection declarations, not wash-sale clearance; current/future windows remain open.</p>
        {computed?.coverage?<div className="table-wrap"><table aria-label="Dashboard history coverage"><thead><tr><th>Account / harvesting selection</th><th>Supplied coverage</th><th>Uncovered dates</th></tr></thead><tbody>{computed.coverage.map(c=><tr key={c.accountId}><td>{c.label}<small>{data.inputs?.input?.accounts.find(a=>a.accountId===c.accountId)?.scope??'unreviewed'}</small></td><td>{c.status.replaceAll('_',' ')}</td><td>{c.gaps.map(g=>`${g.start} through ${g.end}`).join('; ')||'No gaps in supplied declarations'}</td></tr>)}</tbody></table></div>:<p>Activity coverage unavailable.</p>}
        <Button onClick={()=>onNavigate('Activity')}>Review transaction coverage</Button><Button onClick={()=>onNavigate('Analysis inputs')}>Review saved assumptions</Button>
      </section>
      </details><details className="dashboard-detail"><summary>Holdings & source evidence</summary><section className="card"><h2>Holdings and unresolved amounts</h2><div className="table-wrap"><table aria-label="Dashboard holdings"><thead><tr><th>Account / security</th><th>Position P/L</th><th>Short / long / unresolved</th><th>Price evidence</th><th>Review details</th></tr></thead><tbody>{report.rows.slice(current*25,(current+1)*25).map(r=><tr key={r.key}><td>{r.accountLabel} / {r.symbol}</td><td>{display(r.pnl)} {r.currency}</td><td>{display(r.terms.short)} / {display(r.terms.long)} / {display(r.terms.unresolved)}</td><td>{display(r.price?.price)} {r.price?.currency}<small>{r.price?.kind??'No price'} · {r.priceStatus}</small><small>{r.price?.priceType==='daily-close'?'Closing date':'Market time'}: {r.price?.priceDate??r.price?.observedAt??'Unknown'}</small><small>Retrieved: {r.price?.fetchedAt??'Unknown'}</small></td><td><details><summary>Explain {r.accountLabel} {r.symbol}</summary><p>{[...new Set([...r.terms.reasons,...r.reasons,...r.issues.map(i=>i.title)])].join(' ')||'Position and lot totals reconcile; terms use the confirmed scenario assumption.'}</p><p>Price reference: {r.price?.reference??'Unknown'}. Position dated {r.positionDate??'Unknown'}; lots dated {r.lotDate??'Unknown'}.</p>{r.terms.lots.map(l=><p key={l.index}>{l.row_ref} · {l.acquisition_date??'Unknown date'} · {l.classification.term} · P/L {display(l.pnl)} · {l.classification.reason}</p>)}<Button onClick={()=>onNavigate('Reconciliation')}>Open evidence reconciliation</Button></details></td></tr>)}</tbody></table></div><div className="table-tools"><Button disabled={!current} onClick={()=>setPage(current-1)}>Previous holdings</Button><span>Page {current+1} of {pages}</span><Button disabled={current+1>=pages} onClick={()=>setPage(current+1)}>Next holdings</Button></div></section></details>
    </>}
  </>;
}

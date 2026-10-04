import React,{useMemo,useState} from 'react';
import {Alert,Button,Checkbox,Chip,Dialog,DialogContent,DialogTitle,FormControlLabel,MenuItem,TextField} from '@mui/material';
import {issueCategories} from './import/reconciliation.mjs';

const display=value=>value===null||value===undefined?'Unknown':String(value);
export default function Reconciliation({state,issues,store,onRefresh,onCorrect}:{state:any,issues:any[],store:any,onRefresh:()=>Promise<void>,onCorrect?:(target:any)=>void}){
  const [account,setAccount]=useState(''),[category,setCategory]=useState(''),[priority,setPriority]=useState(''),[search,setSearch]=useState(''),[closed,setClosed]=useState(false),[page,setPage]=useState(0);
  const [detail,setDetail]=useState<any>(null),[original,setOriginal]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const visible=useMemo(()=>issues.filter(i=>(closed||i.active)&&(!account||i.accountId===account)&&(!category||i.category===category)&&(!priority||i.priority===priority)&&`${i.symbol} ${i.title} ${i.accountLabel}`.toLowerCase().includes(search.toLowerCase())),[issues,account,category,priority,search,closed]);
  const holdings=new Set(visible.map(i=>JSON.stringify([i.accountId,i.symbol]))).size;
  const pages=Math.max(1,Math.ceil(visible.length/25)),currentPage=Math.min(page,pages-1);
  const filter=(setter,value)=>{setter(value);setPage(0);};
  async function source(file){setBusy(true);setError('');try{setOriginal({name:file.name,text:file.text??await store.readSource(file)});}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  return <>
    <Alert severity="info">This inbox reviews accepted holdings. Data gaps remain open until supporting evidence changes. Viewing an issue or a saved review note does not resolve it.</Alert>
    {error&&<Alert severity="error" onClose={()=>setError('')}>{error}</Alert>}
    <div className="metrics"><div><small>ISSUES IN THIS VIEW</small><strong>{visible.length}</strong></div><div><small>AFFECTED HOLDINGS</small><strong>{holdings}</strong></div><div><small>DATA GAPS / DISAGREEMENTS</small><strong>{visible.filter(i=>i.priority==='data').length}</strong></div><div><small>TIMING / REVIEW</small><strong>{visible.filter(i=>i.priority==='review').length}</strong></div></div>
    <section className="card"><h2>Reconciliation inbox</h2>
      <div className="form-grid">
        <TextField select label="Filter account" value={account} slotProps={{select:{displayEmpty:true},inputLabel:{shrink:true}}} onChange={e=>filter(setAccount,e.target.value)}><MenuItem value="">All accounts</MenuItem>{state.accounts.map(a=><MenuItem key={a.id} value={a.id}>{a.portfolioName?`${a.portfolioName} / `:''}{a.label}</MenuItem>)}</TextField>
        <TextField select label="Issue category" value={category} slotProps={{select:{displayEmpty:true},inputLabel:{shrink:true}}} onChange={e=>filter(setCategory,e.target.value)}><MenuItem value="">All categories</MenuItem>{issueCategories.map(c=><MenuItem key={c} value={c}>{c}</MenuItem>)}</TextField>
        <TextField select label="Review priority" value={priority} slotProps={{select:{displayEmpty:true},inputLabel:{shrink:true}}} onChange={e=>filter(setPriority,e.target.value)}><MenuItem value="">All priorities</MenuItem><MenuItem value="data">Data gap or disagreement</MenuItem><MenuItem value="review">Review evidence</MenuItem></TextField>
        <TextField label="Find reconciliation issue" value={search} onChange={e=>filter(setSearch,e.target.value)} placeholder="Security, account, or issue"/>
      </div>
      <div className="table-tools"><FormControlLabel control={<Checkbox checked={closed} onChange={e=>filter(setClosed,e.target.checked)}/>} label="Include closed holdings"/><Button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await onRefresh();}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Refresh accepted evidence</Button></div>
      {!visible.length?<p>{issues.length?'No issues match these filters.':'No issues found in the accepted holdings. This does not establish complete transaction history or harvesting readiness.'}</p>:<>
        <div className="table-wrap"><table><thead><tr><th>Security / account</th><th>Issue</th><th>Category</th><th>Priority</th><th>Evidence</th></tr></thead><tbody>{visible.slice(currentPage*25,(currentPage+1)*25).map(i=><tr key={i.id}><td><strong>{i.symbol}</strong><small>{i.portfolioName?`${i.portfolioName} / `:''}{i.accountLabel}{!i.active?' · closed':''}</small></td><td>{i.title}</td><td>{i.category}</td><td><Chip size="small" variant="outlined" label={i.priority==='data'?'Data gap / disagreement':'Review evidence'}/></td><td><Button aria-label={`Review ${i.symbol}: ${i.title}`} onClick={()=>{setDetail(i);setOriginal(null);setError('');}}>Review evidence</Button></td></tr>)}</tbody></table></div>
        <div className="pagination"><span>Page {currentPage+1} of {pages}</span><Button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous issues</Button><Button disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>Next issues</Button></div>
      </>}
      <p className="muted">Import updated evidence through Import, or review a manual change in Corrections. Position and lot quantities describe the same holding and are never added together.</p>
    </section>
    <Dialog open={Boolean(detail)} onClose={()=>{if(!busy){setDetail(null);setOriginal(null);}}} fullWidth maxWidth="lg"><DialogTitle>{original?original.name:`${detail?.symbol??''} · ${detail?.title??''}`}<Button disabled={busy} style={{float:'right'}} onClick={()=>{setDetail(null);setOriginal(null);}}>Close evidence</Button></DialogTitle><DialogContent>
      {error&&<Alert severity="error">{error}</Alert>}
      {original?<><Button onClick={()=>setOriginal(null)}>Back to issue</Button><pre>{original.text}</pre></>:detail&&<>
        {onCorrect&&<Button onClick={()=>onCorrect({accountId:detail.accountId,symbol:detail.symbol})}>Correct this holding</Button>}
        {(state.corrections??[]).some(c=>c.accountId===detail.accountId&&c.symbol===detail.symbol)&&<Alert severity="info">This holding has correction history. Totals and lot rows below include applicable reviewed values; original source files remain unchanged. Review applied or suspended entries in Corrections.</Alert>}
        <p>{detail.portfolioName?`${detail.portfolioName} / `:''}{detail.accountLabel} · {detail.active?'Active holding':'Closed holding'}</p><Alert severity={detail.priority==='data'?'warning':'info'}>{detail.message}</Alert><p><strong>Next step:</strong> {detail.nextStep}</p>
        <h3>Position and lot totals</h3><div className="table-wrap"><table><thead><tr><th>Evidence</th><th>Quantity</th><th>Cost basis</th></tr></thead><tbody>{[['Position',detail.totals.position],['Reported lot total',detail.totals.reported],['Sum of lot rows',detail.totals.rows]].map(([name,totals]:any)=><tr key={name}><td>{name}</td><td>{display(totals?.quantity)}</td><td>{display(totals?.total_basis)}</td></tr>)}</tbody></table></div>
        <p>Confirmed currency: {detail.holding.confirmedCurrency??'Unknown'} · position source currency: {detail.holding.position.currency??'Unknown'}.</p>
        {detail.totals.currencyConflict&&<Alert severity="warning">The evidence contains different currencies. Cost basis is not compared across currencies, and a mixed-currency lot sum is left unknown.</Alert>}
        <p>{detail.totals.timing==='different'?'Effective times differ. Position and lot totals are not treated as simultaneous.':detail.totals.timing==='unknown'?'Effective timing is unverified; matching or differing totals do not establish the same observation date.':detail.totals.timing==='same-day'?'Reported dates match; intraday timing is not verified.':'Reported effective timestamps match.'} Unknown amounts are not zero.</p>
        <h3>Source evidence</h3>{detail.evidence.map((e,index)=><div key={index} className="file"><div><strong>{e.role}: {e.source?.name??'Source reference unavailable'}</strong><p>Source row/panel: {e.sourceRef??'Unknown'} · effective: {e.effectiveAt??'Unknown'} · observed: {e.observedAt??'Unknown'}</p><small>Source import accepted: {e.acceptedAt??'Unknown'}</small></div>{e.source&&<Button disabled={busy} onClick={()=>source(e.source)}>View original {e.role.toLowerCase()}</Button>}</div>)}
        <h3>Accepted lot rows</h3>{detail.holding.lotScope?.lots.length?<div className="table-wrap" style={{maxHeight:400,overflow:'auto'}}><table><thead><tr><th>Source row</th><th>Acquired</th><th>Quantity</th><th>Cost basis</th><th>Currency</th><th>Issue</th></tr></thead><tbody>{detail.holding.lotScope.lots.map((lot,index)=><tr key={index}><td>{lot.row_ref??index+1}</td><td>{lot.acquisition_date??'Unknown'}</td><td>{display(lot.quantity)}</td><td>{display(lot.total_basis)}</td><td>{lot.currency??'Unknown'}</td><td>{detail.lotRows.includes(index)?'Affected row':'—'}</td></tr>)}</tbody></table></div>:<p>No accepted complete lot rows. A position-only holding remains visible without invented lots.</p>}
        {detail.holding.supplementalScope&&<p>Latest incomplete capture: {detail.holding.supplementalScope.status} · {detail.holding.supplementalScope.lots.length} observed rows. Use its original source above to review those rows.</p>}
        <h3>Recorded import review</h3><p>{detail.review?.acceptedAt??'Unknown acceptance time'} · {detail.review?.reason||'No additional review note.'}</p>{detail.review?.restoration&&<p>Restored from a backup on {detail.review.restoration.restoredAt}. Original acceptance history is retained.</p>}
        {(detail.holding.warnings??[]).map((w,index)=><p key={index}>{w.message}</p>)}
      </>}
    </DialogContent></Dialog>
  </>;
}

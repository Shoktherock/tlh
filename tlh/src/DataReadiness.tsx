import React,{useEffect,useState} from 'react';
import {Alert,Button} from '@mui/material';
import {buildDashboard} from './valuation/dashboard.mjs';
import {combineValuationPrices} from './valuation/engine.mjs';
import {activityCoverage} from './activity/engine.mjs';
import {shiftDate} from './analysis/candidates.mjs';
import {readinessSteps} from './readiness.mjs';

export default function DataReadiness({store,revision,prices,providerResult,priceMode,asOf,onNavigate,guided=false}:any){
  const [result,setResult]=useState<any>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;setResult(null);setError('');
    (async()=>{
      try{
        const [state,activity,quotes]=await Promise.allSettled([store.readState(),store.activity({action:'read'}),store.quotes({action:'read'})]);
        if(state.status==='rejected')throw state.reason;
        const report=buildDashboard({state:state.value,prices:combineValuationPrices(state.value,prices,quotes.status==='fulfilled'?quotes.value.items:[],asOf,priceMode),asOf,termDate:asOf.slice(0,10)});
        const start=shiftDate(asOf.slice(0,10),-30),end=shiftDate(asOf.slice(0,10),30);
        const inventory=(accounts:any[])=>JSON.stringify(accounts.map(a=>[a.id,a.type]).sort((a,b)=>a[0].localeCompare(b[0])));
        const coverage=activity.status==='fulfilled'&&inventory(activity.value.accounts)===inventory(state.value.accounts)?activityCoverage(activity.value.state,report.accounts,start,end):null;
        if(active)setResult({steps:readinessSteps(report,coverage),start,end,quoteError:quotes.status==='rejected'});
      }catch{if(active)setError('Could not check data readiness. Existing records are unchanged.');}
    })();
    return ()=>{active=false;};
  },[store,revision,prices,providerResult,priceMode,asOf,attempt]);
  const next=result?.steps.find(s=>!s.done);
  return <section className="card" aria-label="Data readiness">
    <h2>{guided?'Your setup checklist':'Data readiness'}</h2>
    <p>Collect evidence → review exceptions → explore opportunities. These checks describe supplied records, not trade approval.</p>
    {error&&<Alert severity="warning">{error}</Alert>}
    {!result&&!error&&<p role="status">Checking saved evidence…</p>}
    {result&&<>
      {result.quoteError&&<Alert severity="warning">Saved provider prices could not be loaded. Retry before relying on price coverage.</Alert>}
      <p><strong>Next: {next?.title??'Explore opportunities'}</strong></p>
      {next&&<Button variant="contained" onClick={()=>onNavigate(next.route)}>{next.action}</Button>}
      {!next&&<Button variant="contained" onClick={()=>onNavigate('Loss candidates')}>Explore opportunities</Button>}
      {!guided&&<p>{result.steps.filter(s=>['positions','lots','prices','activity'].includes(s.id)).map(s=>`${s.title}: ${s.done?'evidence supplied':'review needed'}`).join(' · ')}</p>}
      <details open={guided}><summary>View setup and evidence checks</summary>
        <ol>{result.steps.map(s=><li key={s.id} style={{marginBottom:16}}><strong>{s.title} · {s.done?'Evidence supplied':s.id==='prices'?'Check date':'Needs review'}</strong><p>{s.detail}</p><Button onClick={()=>onNavigate(s.route)}>{s.action}</Button></li>)}</ol>
        <p>Transaction review window: {result.start} through {result.end}. Coverage declarations do not establish wash-sale clearance.</p>
        <p>Realized gain/loss Details reports are optional for exploring opportunities; add them after sales to support realized-loss reporting. Uploading a file does not complete a step until its preview is accepted.</p>
      </details>
    </>}
    <Button onClick={()=>setAttempt(x=>x+1)}>Recheck saved evidence</Button>
  </section>;
}

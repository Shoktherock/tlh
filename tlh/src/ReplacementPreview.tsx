import React,{useEffect,useState} from 'react';
import {Button} from '@mui/material';
// Serialize cached comparisons so a page of holdings does not flood the local service.
let queue=Promise.resolve();
export default function ReplacementPreview({store,accountId,portfolioId,symbol,date,amount,mode,revision,currency}:any){
 const [result,setResult]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[retry,setRetry]=useState(0);
 useEffect(()=>{let alive=true;setResult(null);setError('');setBusy(true);
 if(currency!=='USD'||!portfolioId||!(Number(amount)>0)){setError('Comparison needed: requires a portfolio and a positive USD sale amount.');setBusy(false);return;}
 queue=queue.catch(()=>{}).then(async()=>{if(!alive)return;try{const r=await store.replacements({action:'compare',accountId,portfolioId,symbol,date,amount,mode,poolLimit:20});if(alive)setResult(r);}catch(e:any){if(alive)setError(e.message);}finally{if(alive)setBusy(false);}});
 return()=>{alive=false;};
 },[store,accountId,portfolioId,symbol,date,amount,mode,revision,currency,retry]);
 const top=result?.rows.find(r=>r.rankable&&!r.excluded.length),names={returns:'Return-pattern similarity',industry:'Industry classification match',size:'Market-cap similarity',volatility:'Volatility similarity',concentration:'Concentration fit',constituents:'Constituent alignment',sectors:'Sector alignment',stockFit:'Stock similarity'};
 const strongest=top?Object.entries(top.components??{}).filter(([,v])=>typeof v==='number').sort(([a,av]:any,[b,bv]:any)=>bv*(result.scoring.weights[b]??0)-av*(result.scoring.weights[a]??0)).slice(0,3):[];
 return <div className="replacement-preview" aria-label={`Replacement preview ${symbol}`} aria-busy={busy}>
 {busy?<small>Checking saved comparison evidence…</small>:error?<><strong>Comparison needed</strong><small>{error}</small></>:!top?<><strong>Insufficient evidence</strong><small>No eligible fully scored candidate. Open the comparison flow to review exclusions or refresh ranking evidence.</small></>:<><strong>{symbol} → {top.symbol}</strong><small>{top.name} · {top.score.toFixed(1)} / 100</small><ul>{strongest.map(([k,v]:any)=><li key={k}>{names[k]??k}: {(v*100).toFixed(1)}% fit · weight {result.scoring.weights[k]}%</li>)}</ul><small>{top.observations} aligned return observations · price / metrics {result.metricsAsOf}</small><small>Based on ${amount} of losing lots · {mode==='index'?'index alignment':'stock exposure'} · evaluated pool of {result.scoring.pool.length}</small><details><summary>Evidence & limitations</summary><p>{result.universe.benchmark} · {result.universe.provenance} · snapshot {result.universe.asOf}</p><p>{result.scoring.scope}</p>{[...result.warnings,...top.flags,...top.reasons].map((v,i)=><p key={i}>{v}</p>)}<p>Heuristic scores, not probabilities or tax clearance. Similar scores are close alternatives. Review actual lot quantities before comparing a trade.</p></details></>}
 {!busy&&<Button size="small" onClick={()=>setRetry(n=>n+1)}>Recheck {symbol} comparison</Button>}
 </div>;
}

import React,{useEffect,useState,useRef} from 'react';
import {runQuoteQueue} from './valuation/quote-queue.mjs';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,TextField} from '@mui/material';

const exchanges=[['XNAS','NASDAQ'],['XNGS','NASDAQ Global Select'],['XNYS','NYSE'],['ARCX','NYSE Arca'],['BATS','Cboe BZX'],['XASE','NYSE American']];
export default function QuotePanel({rows,request,onResult,onRefreshTime}:{rows:any[],request:(body:any)=>Promise<any>,onResult:(v:any)=>void,onRefreshTime:()=>void}){
  const [result,setResult]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [selected,setSelected]=useState(''),[providerSymbol,setProviderSymbol]=useState(''),[mic,setMic]=useState(''),[reviewed,setReviewed]=useState(false);
  const queue=useRef<AbortController|null>(null),[progress,setProgress]=useState(''),[exceptions,setExceptions]=useState<any[]>([]);
  useEffect(()=>()=>{queue.current?.abort();},[]);
  async function bulk(){
    if(queue.current)return;
    const controller=new AbortController();queue.current=controller;setBusy(true);setError('');setExceptions([]);
    try{await runQuoteQueue({rows,request,signal:controller.signal,publish:next=>{if(!controller.signal.aborted){setResult(next);onResult(next);onRefreshTime();}},progress:(message,issues)=>{if(!controller.signal.aborted){setProgress(message);setExceptions([...issues]);}}});}
    catch(e:any){if(!controller.signal.aborted)setError(e.message);}
    finally{if(queue.current===controller){queue.current=null;setBusy(false);if(controller.signal.aborted)setProgress('Stopped. Saved mappings and quotes are retained.');}}
  }
  const chosen=rows.find(r=>r.key===selected),saved=result?.items.find(i=>i.accountId===chosen?.accountId&&i.symbol===chosen?.symbol);
  async function run(body){setBusy(true);setError('');try{const next=await request(body);setResult(next);onResult(next);if(body.action==='refresh')onRefreshTime();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  useEffect(()=>{let alive=true;request({action:'read'}).then(next=>{if(alive){setResult(next);onResult(next);}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[request]);
  function choose(key){setSelected(key);const row=rows.find(r=>r.key===key),mapping=result?.items.find(i=>i.accountId===row?.accountId&&i.symbol===row?.symbol)?.mapping;setProviderSymbol(mapping?.providerSymbol??row?.symbol??'');setMic(mapping?.mic??'');setReviewed(false);}
  const [clock,setClock]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),30000);return()=>clearInterval(timer);},[]);
  const pending=(result?.items??[]).filter(i=>i.valid&&(!i.quote||Math.max(clock,Date.now())-Date.parse(i.quote.fetchedAt)>=900000)).slice(0,8);
  return <section className="card"><h2>Provider quotes</h2>
    <p>Prices from Twelve Data. Refresh checks the 15-minute cache before requesting a new quote. Market time and retrieval time are separate; quotes may be delayed or from a previous session.</p>
    {result&&!result.configured&&<Alert severity="info">Live quotes are not configured. You can save a symbol mapping and use scenario prices now. A server-side Twelve Data API key is needed to fetch prices.</Alert>}
    {error&&<Alert severity="error">{error}</Alert>}
    <div className="table-tools"><Button variant="contained" disabled={busy||!result?.configured||!rows.length} onClick={bulk}>Set up and refresh all quotes</Button><Button disabled={!queue.current} onClick={()=>queue.current?.abort()}>Stop bulk refresh</Button></div>
    <p>Automatically matches exact US dollar listings and preserves saved mappings. Requests are paced; keep this view open. Stop at any time and use the same button to resume. Unsupported or ambiguous listings need review.</p>
    {progress&&<p role="status">{progress}</p>}
    {exceptions.length>0&&<details open><summary>{exceptions.length} exceptions needing review</summary>{exceptions.map((i,n)=><p key={`${i.accountId}:${i.symbol}:${n}`}>{rows.find(r=>r.accountId===i.accountId&&r.symbol===i.symbol)?.accountLabel} / {i.symbol}: {i.message} <Button disabled={busy} onClick={()=>choose(rows.find(r=>r.accountId===i.accountId&&r.symbol===i.symbol)?.key??'')}>Review mapping</Button></p>)}</details>}
    <div className="form-grid" style={{marginTop:16}}>
      <TextField select label="Quote holding" value={selected} onChange={e=>choose(e.target.value)}><MenuItem value="">Choose holding</MenuItem>{rows.map(r=><MenuItem key={r.key} value={r.key}>{r.accountLabel} / {r.symbol}</MenuItem>)}</TextField>
      <TextField label="Provider symbol" value={providerSymbol} onChange={e=>{setProviderSymbol(e.target.value.toUpperCase());setReviewed(false);}} helperText="Use the exact Twelve Data symbol, including share class."/>
      <TextField select label="Quote exchange" value={mic} onChange={e=>{setMic(e.target.value);setReviewed(false);}}><MenuItem value="">Choose exchange</MenuItem>{exchanges.map(([code,label])=><MenuItem key={code} value={code}>{label} ({code})</MenuItem>)}</TextField>
    </div>
    <FormControlLabel control={<Checkbox checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>} label="I checked that this symbol and exchange identify my holding in USD."/>
    <div className="table-tools"><Button disabled={busy||!chosen||!mic||!providerSymbol||!reviewed} onClick={()=>run({action:'map',accountId:chosen.accountId,symbol:chosen.symbol,providerSymbol,mic,reviewed})}>Save quote mapping</Button><Button disabled={busy||!saved} onClick={()=>run({action:'unmap',accountId:chosen.accountId,symbol:chosen.symbol})}>Remove quote mapping</Button><Button disabled={busy||!saved?.valid||!result?.configured} variant="contained" onClick={()=>run({action:'refresh',holdings:[{accountId:chosen.accountId,symbol:chosen.symbol}]})}>Refresh selected quote</Button></div>
    {saved&&<p>Saved mapping: {saved.mapping.providerSymbol} / {saved.mapping.mic}. {saved.valid?`Cache: ${saved.cacheStatus}.`:'Mapping needs review.'}</p>}
    <div className="table-tools"><Button disabled={busy} onClick={()=>run({action:'read'})}>Reload cached quotes</Button><Button disabled={busy||!result?.configured||!pending.length} onClick={()=>run({action:'refresh',holdings:pending.map(i=>({accountId:i.accountId,symbol:i.symbol}))})}>Refresh next {pending.length||8} missing or stale quotes</Button><span>{busy?'Working…':`${result?.items.filter(i=>i.valid).length??0} mapped holdings`}</span></div>
    <p>Refresh handles up to eight holdings at a time, with a shared allowance of eight provider requests per minute and 800 per UTC day. Quote refresh sets valuation time to now. No automatic background fetching.</p>
    {(result?.items??[]).filter(i=>i.error).map(i=><Alert severity="warning" key={`${i.accountId}:${i.symbol}`} sx={{mb:1}}>{rows.find(r=>r.accountId===i.accountId&&r.symbol===i.symbol)?.accountLabel} / {i.symbol}: {i.error.message}</Alert>)}
  </section>;
}

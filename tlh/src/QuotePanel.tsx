import React,{useCallback,useEffect,useState} from 'react';
import {Alert,Button,MenuItem,TextField} from '@mui/material';
import TwelveQuotePanel from './TwelveQuotePanel';
export default function QuotePanel(props:any){
  const [provider,setProvider]=useState('massive');
  const request=useCallback(body=>props.request({...body,provider}),[props.request,provider]);
  return <><TextField select label="Market data provider" value={provider} onChange={e=>setProvider(e.target.value)} sx={{my:2,minWidth:300}}><MenuItem value="massive">Massive — daily closing prices</MenuItem><MenuItem value="twelve-data">Twelve Data — individual quotes</MenuItem></TextField>
    {provider==='massive'?<MassivePanel {...props} request={request}/>:<TwelveQuotePanel {...props} request={request}/>}</>;
}
function MassivePanel({rows,request,onResult,onRefreshTime}:any){
  const [result,setResult]=useState<any>(null),[date,setDate]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let alive=true;request({action:'read'}).then(next=>{if(alive){setResult(next);setDate(next.suggestedDate??'');onResult(next);}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[request]);
  async function run(action){setBusy(true);setError('');try{const next=await request({action,...(action==='daily-refresh'?{date}:{})});setResult(next);onResult(next);if(action==='daily-refresh')onRefreshTime();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  const items=result?.items??[],priced=items.filter(i=>i.quote).length,exceptions=items.filter(i=>i.error);
  return <section className="card"><h2>Daily portfolio prices</h2>
    <p>Massive fetches the US market's daily summary in one request. Exact USD symbols are matched automatically; no exchange setup is required. These are unadjusted closing prices, not live quotes.</p>
    {result&&!result.configured&&<Alert severity="info">Massive is not configured. Add MASSIVE_API_KEY to the server settings, then restart the quote service. Keep API keys out of the browser and chat.</Alert>}
    {(error||result?.error)&&<Alert severity="warning">{error||result.error.message}</Alert>}
    <div className="table-tools"><TextField type="date" label="Closing price date" value={date} disabled={busy} slotProps={{inputLabel:{shrink:true}}} onChange={e=>setDate(e.target.value)}/><Button variant="contained" disabled={busy||!date||!result?.configured||!rows.length} onClick={()=>run('daily-refresh')}>Fetch closing prices</Button><Button disabled={busy} onClick={()=>run('read')}>Reload saved prices</Button></div>
    <p role="status">{busy?'Fetching market summary…':`${priced} / ${items.length} active holdings priced. Closing date: ${result?.priceDate??'None saved'}.`}</p>
    <p>Choose a completed trading day. On holidays or when a day's data is unavailable, choose an earlier date. Saved daily summaries are reused for 24 hours. Failures retain previous prices and their original date.</p>
    {exceptions.length>0&&<details><summary>{exceptions.length} securities without daily prices</summary>{exceptions.map(i=><p key={`${i.accountId}:${i.symbol}`}>{rows.find(r=>r.accountId===i.accountId&&r.symbol===i.symbol)?.accountLabel} / {i.symbol}: {i.error.message}</p>)}</details>}
  </section>;
}

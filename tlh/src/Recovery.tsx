import PlanningRecovery from './PlanningRecovery';
import React, {useEffect,useState} from 'react';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,TextField} from '@mui/material';
import {decodeSourceBytes} from './import/sources.mjs';
import {exportBackup,validateBackup} from './import/recovery.mjs';
import * as localStore from './import/store.mjs';

export default function Recovery({store,state,onRestored,onResume}:{store:any,state:any,onRestored:(state:any)=>void,onResume:(preview:any)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [backup,setBackup]=useState<any>(null),[mapping,setMapping]=useState<any>({}),[preview,setPreview]=useState<any>(null),[reviewed,setReviewed]=useState(false);
  const [pending,setPending]=useState<any>({uploads:[],imports:[],restores:[]});
  const refresh=async()=>setPending(await store.recovery());
  useEffect(()=>{refresh().catch(e=>setError(e.message));},[]);
  async function run(action:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await action();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  async function inspect(text:string){
    setBackup(null);setMapping({});setPreview(null);setReviewed(false);
    if(new TextEncoder().encode(text).length>26214400)throw new Error('Choose a backup below 25 MB.');
    const verified=await validateBackup(JSON.parse(text));setBackup({text,...verified});
  }
  async function prepare(){
    setPreview(null);setReviewed(false);
    const result=await store.prepareRestore(backup.text,mapping);
    if(result.duplicate)setMessage('This backup was already restored to these accounts. Nothing was duplicated.');else setPreview(result.preview);
    await refresh();
  }
  async function accept(){
    const result=await store.acceptRestore(preview.preparedId,reviewed);onRestored(result.state);setPreview(null);setReviewed(false);
    setMessage(result.duplicate?'This restore was already completed. Nothing was duplicated.':`Restore complete. ${result.restoredImports} historical imports preserved.`);await refresh();
  }
  return <>
    {error&&<Alert severity="error">{error}</Alert>}{message&&<Alert severity="success">{message}</Alert>}
    <section className="card"><h2>Back up accepted imports</h2><p>Save original source files, holdings, cash, corrections, and review history. Export planning assumptions from Analysis inputs and transaction evidence from Activity separately; quote mappings and cached prices are not included. The downloaded JSON contains private financial data in plain text. Current limit: 25 MB and 100 historical imports, and 500 correction events.</p>
      <Button disabled={busy||!state.imports.length} onClick={()=>run(async()=>{
        const text=await store.exportBackup();const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='tlh-portfolio-backup.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage('Backup exported with verified source files and review history.');
      })}>Export imports backup</Button>
    </section>
    <section className="card"><h2>Migrate or restore</h2><p>Inspect a backup or the local pilot in this browser. Map each source account to a distinct empty account of the same type. Saved evidence and review decisions are replayed and checked against the backup before a restore is prepared.</p>
      <Button component="label" disabled={busy}>Choose backup<input type="file" accept=".json" hidden aria-label="Portfolio backup" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)run(async()=>{if(file.size>26214400)throw new Error('Choose a backup below 25 MB.');await inspect(decodeSourceBytes(await file.arrayBuffer()));});}}/></Button>
      <Button disabled={busy} onClick={()=>run(async()=>{await inspect(await exportBackup(await localStore.readState(),async()=>{throw new Error('Local source missing.');}));})}>Inspect browser-local imports</Button>
      <p className="muted">Inspection stays in this browser. Build restore preview uploads the backup to your private Supabase storage. Your browser-local data is retained.</p>
      {backup&&<>
        {backup.summary.map(a=><div key={a.id} className="file"><div><strong>{a.label}</strong><p>{a.holdings} active holdings · {a.closed} closed · {a.lots} lots · {a.imports} imports · {a.corrections??0} correction events · cash {a.cash??'unknown'}</p></div>
          <TextField select label={`Destination for ${a.label}`} value={mapping[a.id]??''} disabled={busy} sx={{minWidth:260}} slotProps={{select:{displayEmpty:true},inputLabel:{shrink:true}}} onChange={e=>{setMapping({...mapping,[a.id]:e.target.value});setPreview(null);setReviewed(false);}}><MenuItem value="">Choose an account</MenuItem>{state.accounts.filter(t=>t.type===a.type&&t.broker?.toLowerCase()==='schwab').map(t=><MenuItem key={t.id} value={t.id}>{t.portfolioName?`${t.portfolioName} / `:''}{t.label}</MenuItem>)}</TextField>
        </div>)}
        <details><summary>Saved source files and review decisions</summary>{backup.state.imports.map(b=><div key={b.id}><p>{b.acceptedAt} · {b.sources.map(s=>s.name).join(', ')}</p><p>{b.decisions.symbols.length} selected securities · cash {b.decisions.includeCash?'included':'excluded'} · complete-account coverage {b.options.completeAccount?'confirmed':'not confirmed'}</p>{b.acceptedBy&&<p>Historical acceptance actor recorded in backup: {b.acceptedBy}</p>}<p>{b.decisions.reason||'No additional review note.'}</p></div>)}</details>
        <details><summary>Saved correction audit</summary>{(backup.state.corrections??[]).map(c=><p key={c.id}>{c.at} · {c.symbol} · {c.target.section} / {c.target.field} · {c.kind} · value {JSON.stringify(c.value)} · historical actor {c.actor} · {c.reason}</p>)}</details><Button variant="contained" disabled={busy||backup.summary.some(a=>!mapping[a.id])} onClick={()=>run(prepare)}>Build restore preview</Button>
      </>}
      {preview&&<div className="acceptance"><h3>Review restore</h3>{preview.summary.map(a=><p key={a.id}>{a.label} → {preview.targets.find(t=>t.sourceId===a.id)?.label}: {a.holdings} active holdings, {a.lots} lots, {a.imports} historical imports, {a.corrections??0} correction events, cash {a.cash??'unknown'}.</p>)}
        <p>All mapped accounts restore together in one transaction. Original acceptance dates and notes remain in history, with restore provenance attached.</p>
        <details><summary>Review historical selections and notes</summary>{preview.history.map((b,i)=><div key={i}><p>{b.acceptedAt} · {preview.targets.find(t=>t.id===b.accountId)?.label}</p><p>{b.sources.map(s=>s.name).join(', ')}</p><p>Selected: {b.decisions.symbols.join(', ')||'cash only'} · cash {b.decisions.includeCash?'included':'excluded'} · currency {b.options.currency??'unknown'} · complete-account coverage {b.options.completeAccount?'confirmed':'not confirmed'}</p>{b.acceptedBy&&<p>Historical acceptance actor recorded in backup: {b.acceptedBy}</p>}<p>{b.decisions.reason||'No additional review note.'}</p></div>)}</details>
        <details><summary>Review restored corrections</summary>{(preview.corrections??[]).map(c=><p key={c.id}>{c.at} · {c.symbol} · {c.target.section} / {c.target.field} · {c.kind} · value {JSON.stringify(c.value)} · historical actor recorded in backup: {c.actor} · {c.reason}</p>)}</details><FormControlLabel control={<Checkbox checked={reviewed} disabled={busy} onChange={e=>setReviewed(e.target.checked)}/>} label="I reviewed the backup, saved decisions, and destination accounts and confirm this restore."/>
        <Button variant="contained" disabled={busy||!reviewed} onClick={()=>run(accept)}>Accept restore</Button>
      </div>}
    </section>
    <PlanningRecovery store={store} state={state}/>
    <section className="card"><h2>Unfinished uploads and previews</h2><p>Resume a saved preview within 24 hours. A changed portfolio requires a new preview. For an interrupted upload, reselect the same files in Import and build again; completed files are verified and reused.</p>
      <Button disabled={busy} onClick={()=>run(refresh)}>Refresh recovery list</Button>
      {pending.imports.map(job=><div key={job.id} className="file"><span>Import preview · {state.accounts.find(a=>a.id===job.account_id)?.label} · {job.created_at}</span><Button disabled={busy} onClick={()=>run(async()=>onResume(await store.resume(job.id)))}>Resume import preview</Button></div>)}
      {pending.restores.map(job=><div key={job.id} className="file"><span>Restore preview · {job.created_at}</span><Button disabled={busy} onClick={()=>run(async()=>{setPreview(await store.resume(job.id,'restore'));setReviewed(false);})}>Resume restore preview</Button></div>)}
      {pending.uploads.map(file=><p key={file.id}>{file.name} · {file.status==='prepared'?'Prepared':'Upload reserved'} · {file.bytes} bytes</p>)}
      {!pending.uploads.length&&<p>No unfinished uploads.</p>}
      <Button disabled={busy||!pending.uploads.length} onClick={()=>run(async()=>{await store.discard();setPreview(null);await refresh();setMessage('Unaccepted uploads discarded. Accepted originals and holdings are retained.');})}>Discard all unfinished uploads</Button>
    </section>
  </>;
}

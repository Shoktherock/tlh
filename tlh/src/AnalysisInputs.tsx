import React,{useEffect,useState} from 'react';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,TextField} from '@mui/material';
import {describeInputs,inspectInputsBackup,projectInputs} from './analysis/inputs.mjs';

const rateLabels={federalShort:'Assumed federal short-term rate (%)',federalLong:'Assumed federal long-term rate (%)',state:'Assumed state rate (%)'};
const scopes=[['unreviewed','Not reviewed'],['include','Include'],['omit','Omit']];
const statuses=[['not_reviewed','Not reviewed'],['unavailable','No records available'],['partial_available','Some records available — not imported'],['available','Records available — not imported']];
function saveFile(value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='tlh-analysis-inputs.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export default function AnalysisInputs({store}:{store:any}){
  const [saved,setSaved]=useState<any>(null),[draft,setDraft]=useState<any>(null),[reason,setReason]=useState('');
  const [preview,setPreview]=useState<any>(null),[reviewed,setReviewed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [backup,setBackup]=useState<any>(null),[mapping,setMapping]=useState<any>({});
  function adopt(value){setSaved(value);setDraft(projectInputs(value.input,value.accounts));setPreview(null);setReviewed(false);setReason('');}
  useEffect(()=>{let alive=true;store.analysis({action:'read'}).then(v=>{if(alive)adopt(v);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[store]);
  async function run(action){setBusy(true);setError('');setMessage('');try{await action();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  function change(value){setDraft(value);setPreview(null);setReviewed(false);setMessage('');}
  function accountChange(id,patch){change({...draft,accounts:draft.accounts.map(r=>r.accountId===id?{...r,...patch}:r)});}
  async function prepare(restore=false){setPreview(null);setReviewed(false);const result=await store.analysis(restore?{action:'prepare-restore',baseRevision:saved.revision,backup,mapping,reason}:{action:'prepare',baseRevision:saved.revision,input:draft,reason});setPreview(result.preview);}
  return <>
    <Alert severity="info">These are your planning assumptions and account declarations. Saving them does not calculate tax savings or verify transaction history. Leave unknown rates blank.</Alert>
    {error&&<Alert severity="error" sx={{mt:2}}>{error}</Alert>}{message&&<Alert severity="success" sx={{mt:2}}>{message}</Alert>}
    {!saved?<Button onClick={()=>run(async()=>adopt(await store.analysis({action:'read'})))}>Reload analysis inputs</Button>:<>
      <section className="card"><div className="section-title"><h2>Analysis assumptions</h2><span>Saved revision {saved.revision}</span></div>
        <fieldset disabled={busy} style={{border:0,padding:0}}><div className="form-grid">
          <TextField type="date" label="Proposed analysis date" value={draft.analysisDate??''} slotProps={{inputLabel:{shrink:true}}} onChange={e=>change({...draft,analysisDate:e.target.value||null})}/>
          {Object.entries(rateLabels).map(([key,label])=><TextField key={key} label={label} value={draft.rates[key]??''} onChange={e=>change({...draft,rates:{...draft.rates,[key]:e.target.value||null}})} helperText="Your assumption, 0–100. Blank means unknown."/>)}
          <TextField label="Minimum loss amount" value={draft.minLoss.amount??''} onChange={e=>change({...draft,minLoss:{...draft.minLoss,amount:e.target.value||null}})} helperText="Future screening threshold. Blank means not set."/>
          <TextField label="Loss threshold currency" value={draft.minLoss.currency} onChange={e=>change({...draft,minLoss:{...draft.minLoss,currency:e.target.value.toUpperCase()}})} helperText="No currency conversion is implied."/>
        </div></fieldset>
        <p>No rates are inferred from your income or account type. These values will support labelled scenarios in a later phase.</p>
      </section>
      <section className="card"><h2>Accounts and available history</h2><p>Include the accounts you intend to examine. Omitted and unreviewed accounts remain visible gaps. A stated date range describes records you have; it does not establish complete history in TLH.</p>
        <fieldset disabled={busy} style={{border:0,padding:0}}><div className="form-grid">
          <TextField select label="Household account declaration" value={draft.household} onChange={e=>change({...draft,household:e.target.value})}><MenuItem value="not_reviewed">Not reviewed</MenuItem><MenuItem value="all_known_listed">All known accounts are listed — my declaration</MenuItem><MenuItem value="additional_accounts">Additional accounts are not listed</MenuItem></TextField>
          <TextField label="Household note" value={draft.householdNote} onChange={e=>change({...draft,householdNote:e.target.value})} helperText="Describe additional accounts or uncertainty."/>
        </div>
        {draft.accounts.map(row=>{const a=saved.accounts.find(a=>a.id===row.accountId),h=row.history,available=['available','partial_available'].includes(h.status);return <div key={row.accountId} style={{borderTop:'1px solid #ddd',marginTop:24,paddingTop:16}}><h3>{a.portfolioName?`${a.portfolioName} / `:''}{a.label} · {a.type}</h3><div className="form-grid">
          <TextField select label={`Include ${a.label}`} value={row.scope} onChange={e=>accountChange(row.accountId,{scope:e.target.value})}>{scopes.map(([value,label])=><MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField>
          <TextField label={`Account reason ${a.label}`} value={row.reason} onChange={e=>accountChange(row.accountId,{reason:e.target.value})} helperText="Required when omitting an account."/>
          <TextField select label={`History availability ${a.label}`} value={h.status} onChange={e=>{const status=e.target.value;accountChange(row.accountId,{history:{...h,status,...(!['available','partial_available'].includes(status)?{start:null,end:null}:{})}});}}>{statuses.map(([value,label])=><MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField>
          <TextField label={`History source ${a.label}`} value={h.reference} onChange={e=>accountChange(row.accountId,{history:{...h,reference:e.target.value}})} helperText="Reference to records you have; nothing is uploaded here."/>
          {available&&<><TextField type="date" label={`History start ${a.label}`} value={h.start??''} slotProps={{inputLabel:{shrink:true}}} onChange={e=>accountChange(row.accountId,{history:{...h,start:e.target.value||null}})}/><TextField type="date" label={`History end ${a.label}`} value={h.end??''} slotProps={{inputLabel:{shrink:true}}} onChange={e=>accountChange(row.accountId,{history:{...h,end:e.target.value||null}})}/></>}
          <TextField label={`History note ${a.label}`} value={h.note} onChange={e=>accountChange(row.accountId,{history:{...h,note:e.target.value}})}/>
        </div><p>Activity evidence in this step: not supplied. Lot acquisition dates remain snapshot evidence and are not converted to transactions.</p></div>;})}
        {!draft.accounts.length&&<p>Create accounts on the Accounts page to record their inclusion and history availability.</p>}</fieldset>
      </section>
      <section className="card"><h2>Review and save</h2><TextField fullWidth label="Reason for saving inputs" value={reason} disabled={busy} onChange={e=>{setReason(e.target.value);setPreview(null);setReviewed(false);}}/>
        <div className="table-tools" style={{marginTop:16}}><Button variant="contained" disabled={busy} onClick={()=>run(()=>prepare())}>Preview input changes</Button><Button disabled={busy} onClick={()=>run(async()=>{adopt(await store.analysis({action:'read'}));setMessage('Saved inputs reloaded. Unsaved edits were cleared.');})}>Reload saved inputs (clear edits)</Button></div>
        {preview&&<div className="acceptance"><h3>{preview.kind==='restore'?'Review restored inputs':'Review input changes'}</h3><p>{preview.reason}</p><div className="table-wrap"><table aria-label="Analysis input changes"><thead><tr><th>Input</th><th>Saved</th><th>Proposed</th></tr></thead><tbody>{preview.changes.map((c,i)=><tr key={i}><td>{c.label}</td><td>{c.before}</td><td>{c.after}</td></tr>)}</tbody></table></div>
          {preview.warnings.map((w,i)=><p key={i}>{w}</p>)}<FormControlLabel control={<Checkbox disabled={busy} checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>} label="I reviewed these assumptions and account declarations; history is still unverified."/>
          <Button variant="contained" disabled={busy||!reviewed} onClick={()=>run(async()=>{const next=await store.analysis({action:'accept',preparedId:preview.preparedId,reviewed});adopt(next.saved);setMessage(`Analysis inputs saved at revision ${next.receipt.revision}. Imported holdings are unchanged.`);})}>Confirm input changes</Button>
        </div>}
      </section>
      <section className="card"><h2>Save or restore an inputs backup</h2><p>This separate backup contains the current assumptions and account declarations. Portfolio source files and earlier input revisions are not included.</p>
        <Button disabled={busy||!saved.input} onClick={()=>run(async()=>saveFile((await store.analysis({action:'export'})).backup))}>Export analysis inputs</Button>
        <Button component="label" disabled={busy}>Choose inputs backup<input aria-label="Analysis inputs backup" hidden type="file" accept=".json" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)run(async()=>{setBackup(null);setMapping({});setPreview(null);setReviewed(false);if(file.size>1048576)throw new Error('Choose an inputs backup below 1 MB.');setBackup(inspectInputsBackup(JSON.parse(await file.text())));});}}/></Button>
        {backup&&<><p>Map every saved account to a distinct account of the same type. Restoring replaces the current input declarations after review. Other current accounts start as unreviewed.</p>{backup.accounts.map(a=><div key={a.id} className="file"><span>{a.portfolioName?`${a.portfolioName} / `:''}{a.label} · {a.type}</span><TextField select label={`Input destination ${a.label}`} value={mapping[a.id]??''} disabled={busy} sx={{minWidth:240}} onChange={e=>{setMapping({...mapping,[a.id]:e.target.value});setPreview(null);setReviewed(false);}}><MenuItem value="">Choose destination</MenuItem>{saved.accounts.filter(t=>t.type===a.type).map(t=><MenuItem key={t.id} value={t.id}>{t.portfolioName?`${t.portfolioName} / `:''}{t.label}</MenuItem>)}</TextField></div>)}<Button disabled={busy||backup.accounts.some(a=>!mapping[a.id])} onClick={()=>run(()=>prepare(true))}>Preview restored inputs</Button><p>Enter a reason in Review and save above. The preview appears there.</p></>}
      </section>
      <section className="card"><h2>Saved input history</h2><p>Latest 50 saves, with the signed-in actor and acceptance time. Earlier revisions remain in the database.</p>
        {saved.history.map(event=><details key={event.id}><summary>Revision {event.revision} · {event.kind} · {new Date(event.saved_at).toLocaleString()}</summary><p>{event.reason} · actor {event.user_id}</p><div className="table-wrap"><table aria-label={`Input revision ${event.revision}`}><tbody>{describeInputs(event.input,event.accounts).map(([label,value],i)=><tr key={i}><th>{label}</th><td>{value}</td></tr>)}</tbody></table></div><Button disabled={busy} onClick={()=>{change(projectInputs(event.input,saved.accounts));setReason('');setMessage('Earlier inputs loaded into the form. Preview and confirm to save them as a new revision.');}}>Use revision {event.revision} as draft</Button></details>)}
        {!saved.history.length&&<p>No saved analysis inputs yet.</p>}
      </section>
    </>}
  </>;
}

import React,{useState} from 'react';
import {Alert,Button} from '@mui/material';
import {decodeSourceBytes} from './import/sources.mjs';
import {classifyBatch} from './import/upload-routing.mjs';
export default function UploadHub({onRoute}:any){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 return <section className="card"><h2>Upload brokerage files</h2><p>Positions, helper lot JSON, lot CSV, transactions, or realized gain/loss Details CSV. We identify the contents and open the right review. Choose positions and lots together; review other reports one at a time.</p><Button variant="contained" component="label" disabled={busy}>{busy?'Checking files…':'Upload files'}<input aria-label="Brokerage files" hidden multiple type="file" accept=".csv,.json" onChange={async e=>{const chosen=[...(e.target.files??[])];e.target.value='';if(!chosen.length)return;setBusy(true);setError('');try{if(chosen.length>20||chosen.some(f=>f.size>10000000))throw Error('Choose up to 20 files, each below 10 MB.');const files=await Promise.all(chosen.map(async f=>({name:f.name,text:decodeSourceBytes(await f.arrayBuffer())})));await onRoute(await classifyBatch(files),files);}catch(err:any){setError(err.message);}finally{setBusy(false);}}}/></Button><p>No records change until you choose an account, preview, and accept.</p>{error&&<Alert severity="error">{error}</Alert>}</section>;
}

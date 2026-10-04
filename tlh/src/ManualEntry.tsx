import React,{useState} from 'react';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,TextField} from '@mui/material';
import {validateManual,manualTemplate} from './import/manual.mjs';

const blankLot=()=>({acquisition_date:'',quantity:'',total_basis:'',cost_per_share:''});
export default function ManualEntry({state,onStage}:{state:any,onStage:(file:any,accountId:string)=>Promise<void>}){
  const [account,setAccount]=useState(''),[sourceAccount,setSourceAccount]=useState(''),[reference,setReference]=useState(''),[reason,setReason]=useState('');
  const [symbol,setSymbol]=useState(''),[description,setDescription]=useState(''),[quantity,setQuantity]=useState(''),[basis,setBasis]=useState(''),[currency,setCurrency]=useState(''),[positionDate,setPositionDate]=useState('');
  const [coverage,setCoverage]=useState('none'),[complete,setComplete]=useState(false),[lotDate,setLotDate]=useState(''),[reportedQuantity,setReportedQuantity]=useState(''),[reportedBasis,setReportedBasis]=useState(''),[lots,setLots]=useState<any[]>([blankLot()]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const nullable=v=>v.trim()===''?null:v.trim();
  const edit=(index,key,value)=>setLots(lots.map((l,i)=>i===index?{...l,[key]:value}:l));
  async function stage(){setError('');setBusy(true);try{
    if(coverage==='complete'&&!complete)throw new Error('Confirm that every lot row for this security is included, or choose partial coverage.');
    const data=validateManual({format:'tlh-manual-evidence',version:1,account_label:sourceAccount,reference,reason,positions:[{
      symbol:symbol.trim(),description,quantity:quantity.trim(),total_basis:nullable(basis),currency:nullable(currency),effective_date:nullable(positionDate),
      lots:coverage==='none'?null:{coverage,effective_date:nullable(lotDate),reported_quantity:nullable(reportedQuantity),reported_basis:nullable(reportedBasis),rows:lots.map(l=>({acquisition_date:nullable(l.acquisition_date),quantity:l.quantity.trim(),total_basis:nullable(l.total_basis),cost_per_share:nullable(l.cost_per_share)}))}
    }]});
    await onStage({name:`manual-${data.positions[0].symbol.replace(/[^A-Za-z0-9._-]/g,'_')}.json`,text:JSON.stringify(data,null,2)},account);
  }catch(e:any){setError(e.message);}finally{setBusy(false);}}
  return <>
    <Alert severity="info">Enter values you observed in a brokerage screen or statement. This creates a source document for review in Import. Use Corrections to fix a field in existing evidence. The helper is optional.</Alert>
    <p className="muted">This form is an unsaved draft. Review it as an import before leaving this tab; refreshing or leaving clears the form.</p>
    {error&&<Alert severity="error">{error}</Alert>}
    <section className="card"><h2>1. Identify your evidence</h2><div className="form-grid">
      <TextField select label="Manual target account" value={account} disabled={busy} onChange={e=>setAccount(e.target.value)}><MenuItem value="">Choose an existing account</MenuItem>{state.accounts.filter(a=>a.broker.toLowerCase()==='schwab').map(a=><MenuItem key={a.id} value={a.id}>{a.portfolioName?`${a.portfolioName} / `:''}{a.label}</MenuItem>)}</TextField>
      <TextField label="Account label on source" value={sourceAccount} onChange={e=>setSourceAccount(e.target.value)} helperText="Copy the label you see; review the target mapping before acceptance."/>
      <TextField label="Evidence reference" value={reference} onChange={e=>setReference(e.target.value)} placeholder="e.g. September statement, page 4, OTIS lots"/>
      <TextField label="Entry reason" value={reason} onChange={e=>setReason(e.target.value)} placeholder="e.g. Transcribed lots unavailable in the export"/>
    </div></section>
    <section className="card"><h2>2. Enter the position</h2><p>Copy reported position totals. Blank basis, currency, and dates mean unknown; they do not mean zero.</p><div className="form-grid">
      <TextField label="Manual security symbol" value={symbol} onChange={e=>setSymbol(e.target.value)}/><TextField label="Security description" value={description} onChange={e=>setDescription(e.target.value)}/>
      <TextField label="Position quantity" value={quantity} onChange={e=>setQuantity(e.target.value)}/><TextField label="Position total basis" value={basis} onChange={e=>setBasis(e.target.value)}/>
      <TextField label="Source currency" value={currency} onChange={e=>setCurrency(e.target.value)} helperText="Three-letter code, e.g. USD, or blank."/><TextField label="Position effective date" value={positionDate} onChange={e=>setPositionDate(e.target.value)} helperText="YYYY-MM-DD, or blank if not reported."/>
    </div></section>
    <section className="card"><h2>3. Enter observed lots</h2><TextField select label="Manual lot coverage" value={coverage} onChange={e=>{setCoverage(e.target.value);setComplete(false);}}><MenuItem value="none">No lot evidence</MenuItem><MenuItem value="partial">Partial — some rows only</MenuItem><MenuItem value="complete">Complete — every row for this security</MenuItem></TextField>
      <p>Copy each row separately, including identical-looking lots. Enter decimals without commas or currency signs. Acquisition dates and effective dates serve different purposes.</p>
      {coverage!=='none'&&<><div className="form-grid"><TextField label="Lot effective date" value={lotDate} onChange={e=>setLotDate(e.target.value)} helperText="YYYY-MM-DD, or blank if not reported."/><TextField label="Reported lot quantity" value={reportedQuantity} onChange={e=>setReportedQuantity(e.target.value)} helperText="Copy the displayed total; leave blank if absent."/><TextField label="Reported lot basis" value={reportedBasis} onChange={e=>setReportedBasis(e.target.value)}/></div>
        {lots.map((l,i)=><div key={i} className="card" style={{margin:'16px 0'}}><h3>Lot row {i+1}</h3><div className="form-grid">{[['acquisition_date','Acquisition date'],['quantity','Quantity'],['total_basis','Total basis'],['cost_per_share','Cost per share']].map(([key,label])=><TextField key={key} label={`Lot ${i+1} ${label.toLowerCase()}`} value={l[key]} onChange={e=>edit(i,key,e.target.value)} helperText={key==='acquisition_date'?'YYYY-MM-DD or blank':key==='quantity'?'Positive quantity required':'Blank means unknown'}/>)}</div><Button disabled={lots.length===1||busy} onClick={()=>setLots(lots.filter((_,index)=>index!==i))}>Remove lot row {i+1}</Button></div>)}
        <Button disabled={busy||lots.length>=500} onClick={()=>setLots([...lots,blankLot()])}>Add lot row</Button>
        {coverage==='complete'&&<FormControlLabel control={<Checkbox checked={complete} onChange={e=>{setComplete(e.target.checked);setError('');}}/>} label="I checked all pages and included every lot row for this security."/>}
        {coverage==='partial'&&<Alert severity="warning">Partial evidence does not replace previously accepted complete lots. The observed rows remain in the source document and the holding stays flagged for review.</Alert>}
      </>}
      <div className="section-end"><p>This stages a new manual source for this account. Any current unaccepted import preview is replaced. Nothing is saved to the portfolio until import acceptance.</p><Button sx={{minWidth:170,whiteSpace:'nowrap',flexShrink:0}} variant="contained" disabled={busy||!account} onClick={stage}>Review as import</Button></div>
    </section>
    <section className="card"><h2>Bulk entry with a CSV template</h2><p>For multiple securities, use the template's POSITION, SCOPE, and LOT rows. Replace the synthetic examples and metadata, then upload the file in Import. A SCOPE row declares complete or partial lot coverage. Each LOT row stays separate.</p>
      <Button onClick={()=>{const url=URL.createObjectURL(new Blob([manualTemplate()],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='tlh-manual-evidence-template.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>Download manual CSV template</Button>
    </section>
  </>;
}

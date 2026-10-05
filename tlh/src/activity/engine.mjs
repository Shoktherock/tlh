import {ReviewError} from '../review-error.mjs';
import {validDate} from '../analysis/inputs.mjs';
import {inspectSchwabActivity} from './schwab.mjs';
export const actions=['buy','sell','reinvest','transfer_in','transfer_out','adjustment','other'];
const check=(ok,message)=>{if(!ok)throw new ReviewError(message);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,fields)=>object(v)&&Object.keys(v).every(k=>fields.includes(k));
const text=(v,label,required=false,max=1000)=>{check(typeof v==='string'&&v.length<=max&&(!required||v.trim().length>=3),`${label}: ${required?'3':'0'}–${max} characters required.`);return v.trim();};
const decimal=(v,label,signed=false)=>{if(v===null)return null;check(typeof v==='string'&&v.length<=40&&(signed?/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/:/^(?:0|[1-9]\d*)(?:\.\d+)?$/).test(v),`${label}: use a decimal string or null for unknown.`);const n=v.includes('.')?v.replace(/0+$/,'').replace(/\.$/,''):v;return /^-?0$/.test(n)?'0':n;};
export const hashText=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
export const emptyActivity=()=>({version:1,events:[]});
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
export function activityTemplate(){return {format:'tlh-manual-activity',version:1,sourceAccount:'Synthetic account',reference:'Synthetic statement example',reason:'Manual transcription for review',coverage:{start:'2026-09-01',end:'2026-09-17',status:'partial',noActivity:false},rows:[{rowRef:'row-1',brokerId:null,date:'2026-09-10',symbol:'EXAMPLE',exchange:null,action:'buy',quantity:'1.25',cashAmount:'-125.00',currency:'USD',note:'Synthetic example; replace before accepting.'}]};}
export function normalizeActivity(raw){
  check(exact(raw,['format','version','sourceAccount','reference','reason','coverage','rows'])&&raw.format==='tlh-manual-activity'&&raw.version===1,'Choose a version 1 TLH manual activity JSON document.');
  const c=raw.coverage;check(exact(c,['start','end','status','noActivity'])&&validDate(c.start)&&validDate(c.end)&&c.start<=c.end&&['partial','complete'].includes(c.status)&&typeof c.noActivity==='boolean','Provide a valid inclusive activity range and partial/complete collection status.');
  check(Array.isArray(raw.rows)&&raw.rows.length<=500,'Limit each activity source to 500 rows.');
  check(raw.rows.length>0?!c.noActivity:c.status==='complete'&&c.noActivity,'An empty source needs an explicit complete-range no-activity declaration.');
  const seen=new Set();const rows=raw.rows.map((r,index)=>{
    const label=`Row ${index+1}`;
    check(exact(r,['rowRef','brokerId','date','symbol','exchange','action','quantity','cashAmount','currency','note']),`${label}: unknown row fields.`);
    check(typeof r.rowRef==='string'&&r.rowRef.trim().length>0&&r.rowRef.length<=100&&!seen.has(r.rowRef),`${label}: unique row reference required.`);seen.add(r.rowRef);
    check(r.brokerId===null||typeof r.brokerId==='string'&&r.brokerId.trim().length>0&&r.brokerId.length<=150,`${label}: invalid broker transaction ID.`);
    check(r.date===null||validDate(r.date)&&r.date>=c.start&&r.date<=c.end,`${label}: trade date must be unknown or within the declared range.`);
    check(r.symbol===null||typeof r.symbol==='string'&&/^[A-Z0-9][A-Z0-9.\-/^ ]{0,39}$/.test(r.symbol),`${label}: enter an uppercase security symbol or null.`);
    check(r.exchange===null||typeof r.exchange==='string'&&/^[A-Z0-9 .-]{1,40}$/.test(r.exchange),`${label}: invalid exchange.`);
    check(actions.includes(r.action),`${label}: unsupported activity action.`);
    check(r.currency===null||typeof r.currency==='string'&&/^[A-Z]{3}$/.test(r.currency),`${label}: three-letter currency or null required.`);
    return {rowRef:r.rowRef,brokerId:r.brokerId?.trim()??null,date:r.date,symbol:r.symbol,exchange:r.exchange,action:r.action,quantity:decimal(r.quantity,`${label} quantity`,r.action==='adjustment'),cashAmount:decimal(r.cashAmount,`${label} cash amount`,true),currency:r.currency,note:text(r.note,`${label} note`,['other','adjustment'].includes(r.action))};
  });
  return {format:raw.format,version:1,sourceAccount:text(raw.sourceAccount,'Source account',true,200),reference:text(raw.reference,'Source reference',true),reason:text(raw.reason,'Entry reason',true),coverage:{...c},rows};
}
const signature=r=>JSON.stringify([r.date,r.symbol,r.exchange,r.action,r.quantity,r.cashAmount,r.currency]);
const possibleMatch=(a,b)=>a.action===b.action&&['date','symbol','exchange','quantity','cashAmount','currency'].every(k=>a[k]===null||b[k]===null||a[k]===b[k]);
const fullSignature=r=>JSON.stringify([r.brokerId,signature(r)]);
export function activityView(state){
  const withdrawn=new Set(state.events.filter(e=>e.kind==='withdraw').map(e=>e.batchId));
  const batches=state.events.filter(e=>e.kind==='batch');let active=batches.filter(b=>!withdrawn.has(b.id));
  for(;;){const ids=new Set(active.map(b=>b.id)),next=active.filter(b=>(b.dependencies??[]).every(id=>ids.has(id)));if(next.length===active.length)break;active=next;}
  return {batches,active,suspended:batches.filter(b=>!withdrawn.has(b.id)&&!active.includes(b)),transactions:active.flatMap(b=>b.transactions.map(t=>({...t,accountId:b.accountId,batchId:b.id,reference:b.document.reference}))),withdrawn};
}
export function checkActivityLimits(state){
  const batches=state.events.filter(e=>e.kind==='batch');
  check(state.events.length<=200&&batches.length<=50,'Activity limit: 50 source batches and 200 ledger events.');
  check(batches.reduce((n,b)=>n+b.document.rows.length,0)<=10000,'Activity limit: 10,000 source rows.');
  check(batches.reduce((n,b)=>n+new TextEncoder().encode(b.source.text).length,0)<=2*1024*1024,'Activity originals exceed the 2 MB workspace limit.');
}
export function parseActivitySource(source){
  check(exact(source,['name','text','review'])&&typeof source.name==='string'&&source.name.length>0&&source.name.length<=240&&typeof source.text==='string'&&new TextEncoder().encode(source.text).length<=262144,'Choose a named activity JSON or Schwab CSV source up to 256 KB.');
  if(source.review!==undefined){
    const r=source.review;
    check(exact(r,['format','version','sourceAccount','reference','reason','coverage','currency','tradeDatesConfirmed'])&&r.format==='schwab-transactions-csv'&&r.version===1&&r.currency==='USD'&&r.tradeDatesConfirmed===true,'Confirm this Schwab CSV reports USD amounts and trade dates.');
    const csv=inspectSchwabActivity(source.text);
    const document=normalizeActivity({format:'tlh-manual-activity',version:1,sourceAccount:r.sourceAccount,reference:r.reference,reason:r.reason,coverage:r.coverage,rows:csv.rows.map(row=>({...row,currency:r.currency}))});
    return {...document,format:'tlh-schwab-activity'};
  }
  let parsed;try{parsed=JSON.parse(source.text.replace(/^\uFEFF/,''));}catch{throw new ReviewError('Activity JSON is malformed. No rows were accepted.');}
  return normalizeActivity(parsed);
}
export async function previewActivity(state,accountId,source,decisions={}){
  const document=parseActivitySource(source),view=activityView(state),existing=view.transactions.filter(t=>t.accountId===accountId);
  // Broker descriptions, action labels, price and fees are meaningful evidence, even
  // when quantity and net cash happen to match. Changed CSV evidence needs review.
  const fingerprint=await hashText(canonical([document.coverage,document.rows.map(r=>document.format==='tlh-schwab-activity'?JSON.stringify([fullSignature(r),r.note]):fullSignature(r)).sort()]));
  const duplicate=view.active.find(b=>b.accountId===accountId&&b.fingerprint===fingerprint);
  if(duplicate)return {duplicate:duplicate.id,rows:[],unresolved:[],document};
  check(object(decisions),'Invalid overlap decisions.');
  const ids=new Map(existing.filter(t=>t.brokerId).map(t=>[t.brokerId,t])),claims=new Set(),rows=[],transactions=[],acceptedDecisions={};
  for(const row of document.rows){
    const prior=row.brokerId?ids.get(row.brokerId):null;
    let status='new',matches=[],chosen=null;
    if(prior){status=signature(prior)===signature(row)?'known-id':'conflicting-id';matches=[prior];}
    else{
      matches=existing.filter(t=>possibleMatch(t,row));
      if(matches.length){status='ambiguous';chosen=decisions[row.rowRef];if(chosen==='keep')status='keep';else if(matches.some(t=>t.id===chosen)&&!claims.has(chosen)){status='duplicate';claims.add(chosen);}else chosen=null;}
    }
    if(['new','keep'].includes(status)){const transaction={...row,id:crypto.randomUUID()};transactions.push(transaction);if(row.brokerId)ids.set(row.brokerId,transaction);}
    if(chosen)acceptedDecisions[row.rowRef]=chosen;
    rows.push({row,status,matches:matches.map(t=>({id:t.id,rowRef:t.rowRef,batchId:t.batchId??null})),choice:chosen});
  }
  check(Object.keys(decisions).every(k=>rows.some(r=>r.row.rowRef===k&&r.matches.length&&!['known-id','conflicting-id'].includes(r.status))),'Overlap decisions no longer match this source. Review it again.');
  const unresolved=rows.filter(r=>['ambiguous','conflicting-id'].includes(r.status)).map(r=>r.row.rowRef);
  const warnings=document.rows.filter(r=>!r.date||!r.symbol||r.quantity===null||!r.currency||['adjustment','other'].includes(r.action)).map(r=>`${r.rowRef}: incomplete or unclassified activity evidence; coverage cannot support a no-gap result.`);
  const dependencies=[...new Set(rows.flatMap(r=>r.status==='known-id'?r.matches.filter(m=>m.batchId).map(m=>m.batchId):r.status==='duplicate'?r.matches.filter(m=>m.id===r.choice&&m.batchId).map(m=>m.batchId):[]))].sort();
  const batch={kind:'batch',id:crypto.randomUUID(),accountId,source:{...source,hash:await hashText(source.text)},document,decisions:acceptedDecisions,transactions,fingerprint,dependencies};
  if(!unresolved.length)checkActivityLimits({version:1,events:[...state.events,batch]});
  return {document,rows,unresolved,warnings,batch,newRows:transactions.length,duplicateRows:rows.filter(r=>['duplicate','known-id'].includes(r.status)).length};
}
const nextDay=d=>new Date(Date.parse(`${d}T00:00:00Z`)+86400000).toISOString().slice(0,10);
export function activityCoverage(state,accounts,start,end){
  check(validDate(start)&&validDate(end)&&start<=end,'Choose a valid inclusive coverage query range.');
  const {active}=activityView(state);
  return accounts.map(account=>{
    const batches=active.filter(b=>b.accountId===account.id&&b.document.coverage.start<=end&&b.document.coverage.end>=start);
    const uncertain=batches.filter(b=>b.document.rows.some(r=>!r.date||!r.symbol||r.quantity===null||!r.currency||['other','adjustment'].includes(r.action)));
    const complete=batches.filter(b=>b.document.coverage.status==='complete'&&!uncertain.includes(b));
    const ranges=complete.map(b=>({start:b.document.coverage.start<start?start:b.document.coverage.start,end:b.document.coverage.end>end?end:b.document.coverage.end})).sort((a,b)=>a.start.localeCompare(b.start));
    const gaps=[];let cursor=start;
    for(const range of ranges){if(range.start>cursor)gaps.push({start:cursor,end:new Date(Date.parse(`${range.start}T00:00:00Z`)-86400000).toISOString().slice(0,10)});if(range.end>=cursor){if(range.end===end){cursor=null;break;}cursor=nextDay(range.end);}}
    if(cursor!==null&&cursor<=end)gaps.push({start:cursor,end});
    return {accountId:account.id,label:account.label,status:uncertain.length?'uncertain_records':gaps.length?'gaps':'covered_in_supplied_records',gaps,sourceCount:batches.length,uncertainSources:uncertain.map(b=>b.id)};
  });
}
export async function validateActivityState(raw){
  check(exact(raw,['version','events'])&&raw.version===1&&Array.isArray(raw.events)&&raw.events.length<=200,'Unsupported activity ledger.');
  const replay=emptyActivity(),ids=new Set();
  for(const event of raw.events){
    check(event&&typeof event.id==='string'&&/^[0-9a-f-]{36}$/i.test(event.id)&&!ids.has(event.id)&&typeof event.actor==='string'&&event.actor.length<=100&&typeof event.at==='string'&&Number.isFinite(Date.parse(event.at)),'Activity event identity or attribution is invalid.');ids.add(event.id);
    if(event.kind==='batch'){
      const {hash,...original}=event.source??{};
      const plan=await previewActivity(replay,event.accountId,original,event.decisions);
      check(!plan.duplicate&&!plan.unresolved.length&&event.source.hash===plan.batch.source.hash&&canonical(event.document)===canonical(plan.document)&&event.fingerprint===plan.batch.fingerprint&&canonical(event.dependencies)===canonical(plan.batch.dependencies),'Activity source/review does not match the ledger.');
      check(Array.isArray(event.transactions)&&event.transactions.length===plan.batch.transactions.length,'Activity transactions do not replay.');
      for(let i=0;i<event.transactions.length;i++){const t=event.transactions[i],expected=plan.batch.transactions[i];check(typeof t.id==='string'&&/^[0-9a-f-]{36}$/i.test(t.id)&&!ids.has(t.id)&&canonical({...t,id:null})===canonical({...expected,id:null}),'Activity row changed or ID is duplicated.');ids.add(t.id);}
    }else{
      const view=activityView(replay);
      check(event.kind==='withdraw'&&view.batches.some(b=>b.id===event.batchId)&&!view.withdrawn.has(event.batchId),'Withdrawal targets an unavailable batch.');text(event.reason,'Withdrawal reason',true);
    }
    replay.events.push(structuredClone(event));
  }
  checkActivityLimits(replay);return replay;
}
export async function restoreActivity(backup,mapping,accounts,current){
  check(exact(backup,['format','version','accounts','state','exportedAt'])&&backup.format==='tlh-activity-backup'&&backup.version===1&&Array.isArray(backup.accounts)&&backup.accounts.length<=500,'Choose a version 1 activity backup.');
  check(object(mapping)&&Object.keys(mapping).length===backup.accounts.length&&new Set(backup.accounts.map(a=>a.id)).size===backup.accounts.length,'Map every source account.');
  const state=await validateActivityState(backup.state),occupied=new Set(activityView(current).batches.map(b=>b.accountId)),targets=new Set();
  const used=new Set(activityView(state).batches.map(b=>b.accountId));check(used.size===backup.accounts.length&&backup.accounts.every(a=>used.has(a.id)),'Backup accounts do not match the activity sources.');
  for(const a of backup.accounts){const t=accounts.find(t=>t.id===mapping[a.id]);check(t&&t.type===a.type&&!targets.has(t.id)&&!occupied.has(t.id),'Use distinct owned accounts of the same type with no existing activity history.');targets.add(t.id);}
  const events=state.events.map(e=>e.kind==='batch'?{...e,accountId:mapping[e.accountId]}:e);
  return validateActivityState({version:1,events:[...current.events,...events]});
}

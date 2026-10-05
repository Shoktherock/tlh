import {ReviewError} from '../review-error.mjs';
import {parseDecimal,equalDecimals} from '../../../browser-helper/src/decimal.mjs';

export const correctionFields={position:['quantity','total_basis','effective_date'],lots:['effective_date','reported_quantity','reported_basis'],lot:['acquisition_date','quantity','total_basis','cost_per_share'],holding:['confirmedCurrency']};
const stable=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(stable(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]))])):value??null);
const check=(test,message)=>{if(!test)throw new ReviewError(message);};
export const targetKey=t=>JSON.stringify([t.section,t.field,t.section==='lot'?t.row:null]);
const eventKey=e=>JSON.stringify([e.accountId,e.symbol,targetKey(e.target)]);
export function latestCorrections(state){
  const current=new Map();for(const e of [...(state.corrections??[])].sort((a,b)=>a.baseRevision-b.baseRevision))current.set(eventKey(e),e);
  return [...current.values()].filter(e=>e.kind==='set');
}
function basis(holding,target){
  if(!holding)return null;
  return target.section==='position'?holding.position:target.section==='holding'?{confirmedCurrency:holding.confirmedCurrency,source_id:holding.position.source_id,sourceCurrency:holding.position.currency}:holding.lotScope;
}
function read(holding,target){
  if(!holding)return undefined;
  if(target.section==='position')return target.field==='effective_date'?{effective_at:holding.position.effective_at??null,effective_date:holding.position.effective_date??null}:holding.position[target.field];
  if(target.section==='holding')return holding.confirmedCurrency;
  const scope=holding.lotScope;if(!scope)return undefined;
  if(target.section==='lot')return scope.lots[target.row]?.[target.field];
  return target.field==='effective_date'?{effective_at:scope.effective_at??null,effective_date:scope.effective_date??null}:scope.reported_totals[target.field==='reported_quantity'?'quantity':'total_basis'];
}
function write(holding,target,value){
  if(target.section==='holding'){holding.confirmedCurrency=value;return;}
  if(target.section==='position'){
    if(target.field==='effective_date'){holding.position.effective_at=null;holding.position.effective_date=value;}
    else holding.position[target.field]=value;
    if(target.field==='quantity')holding.active=!equalDecimals(value,'0');
  }else if(target.section==='lot')holding.lotScope.lots[target.row][target.field]=value;
  else if(target.field==='effective_date'){holding.lotScope.effective_at=null;holding.lotScope.effective_date=value;}
  else holding.lotScope.reported_totals[target.field==='reported_quantity'?'quantity':'total_basis']=value;
}
export function correctionView(state){
  const current=latestCorrections(state);if(!current.length)return {...state,correctionStates:[]};
  const holdings=structuredClone(state.holdings);
  const statuses=current.map(event=>{
    const raw=state.holdings[event.accountId]?.[event.symbol];
    const active=Boolean(raw&&read(raw,event.target)!==undefined&&stable(basis(raw,event.target))===stable(event.basis));
    if(active){write(holdings[event.accountId][event.symbol],event.target,event.value);holdings[event.accountId][event.symbol].unresolved=false;}
    return {...event,status:active?'active':'conflict',importedValue:read(raw,event.target)??null};
  });
  return {...state,holdings,correctionStates:statuses};
}
function replacement(target,input){
  if(target.field==='effective_date'||target.field==='acquisition_date'){
    if(input===null)return null;
    check(typeof input==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(input),'Use a calendar date in YYYY-MM-DD format, or unknown.');
    const d=new Date(`${input}T00:00:00Z`);check(Number.isFinite(+d)&&d.toISOString().slice(0,10)===input,'Invalid calendar date.');return input;
  }
  if(target.field==='confirmedCurrency'){check(input===null||typeof input==='string'&&/^[A-Z]{3}$/.test(input),'Use a three-letter currency code, or unknown.');return input;}
  const quantity=target.field==='quantity'||target.field==='reported_quantity';
  check(typeof input==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input)||input===null&&!quantity,'Use a nonnegative decimal string; quantity cannot be unknown.');
  if(input===null)return null;
  const value=parseDecimal(input,{allowUnknown:!quantity});
  if(target.section==='lot'&&target.field==='quantity')check(!equalDecimals(value,'0'),'An individual lot quantity must be positive.');
  return value;
}
export function previewCorrection(state,request,actor){
  check(request&&request.baseRevision===state.revision,'This correction view is stale. Refresh accepted evidence and try again.');
  const account=state.accounts.find(a=>a.id===request.accountId),raw=state.holdings[request.accountId]?.[request.symbol];
  check(account&&raw,'Choose an accepted holding in one of your accounts.');
  check(typeof request.reason==='string'&&request.reason.trim().length>=3&&request.reason.length<=4000,'Provide a review reason of 3–4000 characters.');
  const t=request.target;
  check(t&&correctionFields[t.section]?.includes(t.field),'Unsupported correction field.');
  const target={section:t.section,field:t.field,...(t.section==='lot'?{row:t.row}:{})};
  if(t.section==='lot')check(Number.isInteger(t.row)&&t.row>=0&&(request.kind==='revoke'||t.row<(raw.lotScope?.lots.length??0)),'Select an existing accepted lot row.');
  check(request.kind==='revoke'||read(raw,target)!==undefined,'This holding has no accepted evidence for that field. Import complete lot evidence first.');
  check(['set','revoke'].includes(request.kind),'Choose a correction or withdrawal.');
  const previous=latestCorrections(state).find(e=>eventKey(e)===eventKey({accountId:account.id,symbol:request.symbol,target}));
  check((request.previousId??null)===(previous?.id??null),'The correction changed. Refresh before reviewing it again.');
  const view=correctionView(state),effective=view.holdings[account.id][request.symbol];
  if(request.kind==='revoke')check(previous,'There is no active correction to withdraw.');
  if(request.kind==='set'&&t.section==='lot'&&previous&&view.correctionStates.find(e=>e.id===previous.id)?.status==='conflict')throw new ReviewError('Lot evidence changed. Withdraw the old correction, then select and review a row from the current lot source.');
  const value=request.kind==='set'?replacement(target,request.value):null;
  const next=structuredClone(effective);
  if(request.kind==='set')write(next,target,value);
  check(request.kind==='revoke'||stable(read(next,target))!==stable(read(effective,target))||Boolean(previous),'The proposed value is already in effect.');
  return {baseRevision:state.revision,accountType:account.type,record:{id:crypto.randomUUID(),accountId:account.id,symbol:request.symbol,target,kind:request.kind,value,
    before:read(raw,target)??null,effectiveBefore:read(effective,target)??null,basis:structuredClone(basis(raw,target)??null),reason:request.reason.trim(),actor,previousId:previous?.id??null,baseRevision:state.revision},
    imported:read(raw,target)??null,before:read(effective,target)??null,after:request.kind==='revoke'?read(raw,target)??null:read(next,target),createdAt:new Date().toISOString()};
}
export function acceptCorrection(state,plan,{reviewed},{id=()=>plan.record.id,now=()=>new Date().toISOString()}={}){
  check(reviewed===true,'Review the original value, replacement, and reason before accepting.');
  check(state.revision===plan.baseRevision,'This correction preview is stale. Build it again.');
  const record={...structuredClone(plan.record),id:id(),at:now()};
  const next={...structuredClone(state),revision:state.revision+1,corrections:[...(state.corrections??[]),record]};
  return {state:next,correctionId:record.id,record};
}

export function annotateImportCorrections(state,plan){
  const accountId=plan.options.accountId;if(!accountId||!(state.corrections??[]).length)return plan;
  const future={...state,holdings:{...state.holdings,[accountId]:{...state.holdings[accountId],...Object.fromEntries(plan.rows.map(r=>[r.symbol,r.next]))}}};
  const active=new Set(correctionView(state).correctionStates.filter(c=>c.status==='active').map(c=>c.id));
  const conflicts=correctionView(future).correctionStates.filter(c=>c.accountId===accountId&&c.status==='conflict'&&active.has(c.id));
  return {...plan,correctionConflicts:conflicts.map(c=>({id:c.id,symbol:c.symbol,target:c.target})),rows:plan.rows.map(r=>conflicts.some(c=>c.symbol===r.symbol)?{...r,requiresReason:true}:r)};
}

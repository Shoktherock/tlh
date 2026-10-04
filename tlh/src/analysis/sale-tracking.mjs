import {activityView,activityCoverage} from '../activity/engine.mjs';
import {shiftDate} from './candidates.mjs';
import {validDate} from './inputs.mjs';
import {correctionView} from '../import/corrections.mjs';
import {sameReplacementIssuer} from './replacement-identity.mjs';
export function saleInventory(activity,accounts,today){
 const view=activityView(activity),active=new Set(view.active.map(b=>b.id));
 return view.batches.flatMap(b=>b.transactions.filter(t=>t.action==='sell').map(t=>{
  const account=accounts.find(a=>a.id===b.accountId),window=validDate(t.date)?{start:shiftDate(t.date,-30),end:shiftDate(t.date,30)}:null;
  return {...t,accountId:b.accountId,accountLabel:account?.label??'Unknown account',accountType:account?.type??'unknown',batchId:b.id,reference:b.document.reference,source:b.source.name,active:active.has(b.id),sourceStatus:active.has(b.id)?'active':view.withdrawn.has(b.id)?'withdrawn':'suspended',window,phase:!window?'date_missing':t.date>today?'future_sale':today<=window.end?'window_open':'window_elapsed'};
 })).sort((a,b)=>(b.date??'').localeCompare(a.date??'')||a.id.localeCompare(b.id));
}
export function saleEvidence({sale,activity,holdings,accounts,today}){
 const view=activityView(activity),effective=correctionView(holdings),related=symbol=>symbol===sale.symbol?'same symbol':symbol&&sale.symbol&&sameReplacementIssuer({symbol:sale.symbol},{symbol})?'known related share class':!symbol?'unknown symbol':null;
 const inWindow=date=>!date||!sale.window||date>=sale.window.start&&date<=sale.window.end;
 const acquisitions=[],uncertainties=[];
 for(const t of view.transactions){if(t.id===sale.id||!inWindow(t.date))continue;const relation=related(t.symbol);if(!relation)continue;
  const record={...t,accountLabel:accounts.find(a=>a.id===t.accountId)?.label??'Unknown account',accountType:accounts.find(a=>a.id===t.accountId)?.type??'unknown',kind:'transaction',relation};
  if(['buy','reinvest'].includes(t.action))acquisitions.push(record);else if(['transfer_in','transfer_out','adjustment','other','sell'].includes(t.action))uncertainties.push(record);
 }
 for(const account of accounts)for(const [symbol,h] of Object.entries(effective.holdings[account.id]??{})){
  if(!h.active||!related(symbol))continue;
  for(const [index,l] of (h.lotScope?.lots??[]).entries())if(inWindow(l.acquisition_date))acquisitions.push({kind:'snapshot',accountId:account.id,accountLabel:account.label,accountType:account.type,symbol,date:l.acquisition_date,quantity:l.quantity,rowRef:l.row_ref,reference:h.lotScope.source_id,index,relation:related(symbol),action:'held lot (may duplicate a transaction or sold lot)'});
 }
 return {sale,acquisitions,uncertainties,coverage:sale.window?activityCoverage(activity,accounts,sale.window.start,sale.window.end):[],warnings:[
  'Sale cost basis and realized gain/loss are not established by these transaction rows. A sale is not automatically a harvested loss.',
  'Exact symbols and the known GOOG/GOOGL share-class relationship are screened. Other substantially identical securities, options and unlisted household accounts require separate review.',
  'Snapshot and transaction records can describe the same shares. No matched quantities, disallowed losses or basis adjustments are calculated.',
  ...(sale.phase==='window_open'?[`The forward window remains open through ${sale.window.end}, inclusive.`]:[]),
  ...(sale.phase==='future_sale'?['The recorded sale date is in the future; correct or verify the source.']:[]),
  ...(!sale.symbol||!sale.date||!sale.quantity?['Sale details are incomplete; review the original source.']:[]),
  ...(!sale.active?['The sale source is withdrawn or suspended; this is historical evidence only.']:[]),
  ...(sale.accountType!=='taxable'?['This account is not classified taxable; it is not treated as a harvesting sale.']:[])
 ]};
}

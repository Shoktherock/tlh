import {activityView,activityCoverage} from '../activity/engine.mjs';
import {total,subtract} from '../valuation/engine.mjs';
// Match daily aggregates, never infer which execution disposed of an individual lot.
export function reconcileRealized(reports,activity,accounts,year){
 const allowed=new Set(accounts.map(a=>a.id)),active=reports.filter(r=>r.active&&allowed.has(r.account_id)),view=activityView(activity),groups=new Map();
 const group=(accountId,symbol,date)=>{const key=JSON.stringify([accountId,symbol,date]);if(!groups.has(key))groups.set(key,{key,accountId,symbol,date,lots:[],sales:[]});return groups.get(key);};
 for(const r of active)for(const lot of r.document.rows)if(lot.closed.startsWith(year+'-'))group(r.account_id,lot.symbol,lot.closed).lots.push({...lot,reportId:r.id,reportName:r.name});
 for(const sale of view.transactions)if(allowed.has(sale.accountId)&&sale.action==='sell'&&(!sale.date||sale.date.startsWith(year+'-')))group(sale.accountId,sale.symbol,sale.date).sales.push(sale);
 return [...groups.values()].map(g=>{
  const known=g.date&&g.symbol,coverage=known?activityCoverage(activity,[{id:g.accountId}],g.date,g.date)[0].status:null;
  const reportCovers=known&&active.some(r=>r.account_id===g.accountId&&r.document.start<=g.date&&r.document.end>=g.date);
  const lotQuantity=total(g.lots.map(l=>l.quantity)),proceeds=total(g.lots.map(l=>l.proceeds)),saleQuantity=g.sales.every(s=>s.quantity!==null)?total(g.sales.map(s=>s.quantity)):null,cash=g.sales.every(s=>s.cashAmount!==null&&s.currency==='USD')?total(g.sales.map(s=>s.cashAmount)):null;
  const quantityDifference=g.lots.length&&g.sales.length&&saleQuantity!==null?subtract(lotQuantity,saleQuantity):null,proceedsDifference=g.lots.length&&g.sales.length&&cash!==null?subtract(proceeds,cash):null;
  let status,action;
  if(!known){status='Incomplete sale identity';action='Correct the missing symbol or trade date in Activity.';}
  else if(!g.sales.length){status=coverage==='covered_in_supplied_records'?'Missing sale':'Activity coverage needed';action='Import or review transaction history for this sale date.';}
  else if(!g.lots.length){status=reportCovers?'Missing realized lots':'Realized report coverage needed';action='Import or review a realized Details report covering this sale date.';}
  else if(saleQuantity===null||cash===null){status='Incomplete sale amounts';action='Review quantity, cash amount and USD currency in Activity.';}
  else if(quantityDifference!=='0'){status='Quantity difference';action='Review missing, duplicated or corrected sales and realized lots.';}
  else if(proceedsDifference!=='0'){status='Proceeds difference';action='Review fees, rounding and corrections: Activity cash may be net of fees. No adjustment is inferred.';}
  else{status='Totals match';action='Daily totals agree; execution-to-lot allocation and tax treatment are not established.';}
  return {...g,lotQuantity,proceeds,saleQuantity,cash,quantityDifference,proceedsDifference,status,action,coverage};
 }).sort((a,b)=>(a.status==='Totals match')-(b.status==='Totals match')||(b.date??'').localeCompare(a.date??'')||String(a.symbol).localeCompare(String(b.symbol)));
}

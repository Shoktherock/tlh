import {sumDecimals} from '../../../browser-helper/src/decimal.mjs';
export function brokerLossBreakdown(rows){
 return [...new Set(rows.filter(r=>r.candidate&&r.loss!==null).map(r=>r.currency))].map(currency=>{
 const lots=rows.filter(r=>r.candidate&&r.loss!==null&&r.currency===currency);
 const buckets=['short','long','unknown'].map(term=>{
 const selected=lots.filter(r=>{const label=(r.brokerTerm??'').trim().toLowerCase();const actual=['short','short term','short-term'].includes(label)?'short':['long','long term','long-term'].includes(label)?'long':'unknown';return actual===term;});
 return {term,count:selected.length,amount:sumDecimals(selected.map(r=>r.loss))??'0'};
 });return {currency,amount:sumDecimals(lots.map(r=>r.loss)),buckets};
 });
}

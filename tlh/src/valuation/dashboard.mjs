import {buildValuation,total,subtract} from './engine.mjs';
import {lotTerm} from '../analysis/candidates.mjs';
import {validDate} from '../analysis/inputs.mjs';
const equal=(a,b)=>a!=null&&b!=null&&subtract(a,b)==='0';
const knownSum=values=>values.length?total(values):null;
const date=v=>v?.slice(0,10)??null;
function decompose(row,termDate,ordinaryPurchase){
  const reasons=[];
  if(row.pnl===null)return {short:null,long:null,unresolved:null,reasons:['Position P/L is unavailable.'],lots:[]};
  if(row.lotCoverage!=='complete'||!row.lots.length)reasons.push('Complete lot evidence is missing.');
  if(row.issues.some(i=>['Totals','Source conflicts'].includes(i.category)))reasons.push('Totals or source conflicts require reconciliation.');
  if(row.positionDate&&row.lotDate&&date(row.positionDate)!==date(row.lotDate))reasons.push('Position and lot effective dates differ.');
  if(row.positionDate?.includes('T')&&row.lotDate?.includes('T')&&Date.parse(row.positionDate)!==Date.parse(row.lotDate))reasons.push('Position and lot effective times differ.');
  if([row.positionDate,row.lotDate].some(d=>d&&date(d)>termDate))reasons.push('Evidence is after the holding-period date.');
  const usable=row.lots.length&&row.lots.every(l=>l.quantity!==null&&l.total_basis!==null&&l.pnl!==null&&l.currency===row.currency);
  if(!usable||!equal(total(row.lots.map(l=>l.quantity??'0')),row.quantity)||!equal(total(row.lots.map(l=>l.total_basis??'0')),row.basis))reasons.push('Lot quantity, basis and currency must reconcile to the position before term allocation.');
  if(reasons.length)return {short:'0',long:'0',unresolved:row.pnl,reasons,lots:[]};
  const lots=row.lots.map(l=>({...l,classification:lotTerm(l,termDate,date(row.lotDate),ordinaryPurchase)}));
  return {short:total(lots.filter(l=>l.classification.term==='short').map(l=>l.pnl)),long:total(lots.filter(l=>l.classification.term==='long').map(l=>l.pnl)),unresolved:total(lots.filter(l=>l.classification.term==='unknown').map(l=>l.pnl)),reasons:[...new Set(lots.filter(l=>l.classification.term==='unknown').map(l=>l.classification.reason))],lots};
}
function summarize(rows,cash){
  const currencies=[...new Set([...rows.map(r=>r.currency??'Unknown'),...cash.map(c=>c.currency??'Unknown')])].sort();
  return currencies.map(currency=>{
    const items=rows.filter(r=>(r.currency??'Unknown')===currency),cashRows=cash.filter(c=>(c.currency??'Unknown')===currency),known=items.filter(r=>r.pnl!==null),valued=items.filter(r=>r.marketValue!==null),basis=items.filter(r=>r.basis!==null&&!r.reasons.includes('Reported and confirmed currencies conflict')),cashKnown=cashRows.filter(c=>c.usable),canSum=currency!=='Unknown';
    return {currency,positions:items.length,priced:valued.length,knownPnl:known.length,unavailablePnl:items.length-known.length,basisKnown:basis.length,
      marketValue:canSum?knownSum(valued.map(r=>r.marketValue)):null,basis:canSum?knownSum(basis.map(r=>r.basis)):null,pnl:canSum?knownSum(known.map(r=>r.pnl)):null,
      short:canSum?knownSum(known.map(r=>r.terms.short)):null,long:canSum?knownSum(known.map(r=>r.terms.long)):null,unresolved:canSum?knownSum(known.map(r=>r.terms.unresolved)):null,
      cash:canSum?knownSum(cashKnown.map(c=>c.amount)):null,cashKnown:cashKnown.length,cashReported:cashRows.length,
      lotComplete:items.filter(r=>r.lotCoverage==='complete').length,review:items.filter(r=>r.issues.length||r.reasons.length||r.terms.reasons.length).length};
  });
}
export function buildDashboard({state,prices,asOf,termDate,ordinaryPurchase=false,portfolioId='',accountId=''}){
  if(!validDate(termDate))throw new Error('Choose a valid holding-period date.');
  const accounts=state.accounts.filter(a=>(!portfolioId||(a.portfolioId??'unassigned')===portfolioId)&&(!accountId||a.id===accountId));
  const ids=new Set(accounts.map(a=>a.id));
  const rows=buildValuation(state,prices,asOf).filter(r=>ids.has(r.accountId)).map(r=>({...r,terms:decompose(r,termDate,ordinaryPurchase)}));
  const cash=accounts.flatMap(a=>{
    const c=state.cash[a.id];if(!c)return [];
    const conflict=!!(c.currency&&c.confirmedCurrency&&c.currency!==c.confirmedCurrency),currency=conflict?null:c.currency??c.confirmedCurrency??null;
    return [{accountId:a.id,label:a.label,amount:c.amount,currency,usable:!conflict&&!!currency&&c.amount!==null,date:c.effective_at??c.effective_date??null,reason:conflict?'Cash currency conflict':!currency?'Cash currency unknown':c.amount===null?'Cash amount unknown':null}];
  });
  const details=accounts.map(a=>{
    const holdings=rows.filter(r=>r.accountId===a.id),dates=holdings.map(r=>date(r.positionDate)).filter(Boolean).sort();
    return {...a,positions:holdings.length,priced:holdings.filter(r=>r.marketValue!==null).length,lotComplete:holdings.filter(r=>r.lotCoverage==='complete').length,
      positionOldest:dates[0]??null,positionNewest:dates.at(-1)??null,positionUnknown:holdings.filter(r=>!r.positionDate).length,lotTimeUnknown:holdings.filter(r=>r.lots.length&&!r.lotDate).length,
      prices:Object.fromEntries(['missing','invalid','future','stale','time-unknown','recent','daily-close'].map(s=>[s,holdings.filter(r=>r.priceStatus===s).length])),scenario:holdings.filter(r=>r.price?.kind==='user-scenario').length,
      totals:summarize(holdings,cash.filter(c=>c.accountId===a.id))};
  });
  return {rows,cash,accounts:details,totals:summarize(rows,cash),asOf,termDate,ordinaryPurchase,positions:rows.length,priced:rows.filter(r=>r.marketValue!==null).length,lotComplete:rows.filter(r=>r.lotCoverage==='complete').length,cashMissing:accounts.filter(a=>!cash.some(c=>c.accountId===a.id)).length};
}

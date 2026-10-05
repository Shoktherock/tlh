import {ReviewError} from '../review-error.mjs';
import {transactionReconciliation} from './transaction-reconciliation.mjs';
import {validDate,projectInputs,validateInputs} from './inputs.mjs';
import {buildValuation,multiply,subtract,total} from '../valuation/engine.mjs';
import {correctionView} from '../import/corrections.mjs';
import {activityView,activityCoverage} from '../activity/engine.mjs';

export const taxSources=[
  {title:'IRS Publication 550 — Holding Period and Wash Sales',url:'https://www.irs.gov/publications/p550'},
  {title:'IRS Revenue Ruling 2008-5 — IRA acquisitions',url:'https://www.irs.gov/irb/2008-03_IRB'},
];
const check=(ok,message)=>{if(!ok)throw new ReviewError(message);};
const cmp=(a,b)=>{const d=subtract(a,b);return /^-/.test(d)?-1:d==='0'?0:1;};
const positive=n=>n!==null&&n!==undefined&&cmp(n,'0')>0;
export function shiftDate(date,days){
  check(validDate(date),'A valid analysis date is required.');
  const result=new Date(Date.parse(`${date}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);
  check(validDate(result),'Analysis window is outside supported calendar dates.');return result;
}
// Ordinary purchased securities only; inherited, gifted, adjusted and special-rule
// holding periods require evidence this application does not currently capture.
export function ordinaryHoldingTerm(acquired,sale){
  if(!validDate(acquired)||!validDate(sale)||acquired>sale)return 'unknown';
  const year=Number(acquired.slice(0,4))+1;
  let anniversary=`${String(year).padStart(4,'0')}${acquired.slice(4)}`;
  if(!validDate(anniversary)&&acquired.endsWith('-02-29'))anniversary=`${year}-02-28`;
  return sale>anniversary?'long':'short';
}
export function lotTerm(lot,sale,effectiveDate,ordinaryPurchase){
  if(!ordinaryPurchase)return {term:'unknown',reason:'Ordinary-purchase holding-period assumption is not confirmed.'};
  const term=ordinaryHoldingTerm(lot.acquisition_date,sale);
  if(term==='unknown')return {term,reason:'Acquisition date is missing or after the proposed sale.'};
  const label=(lot.broker_holding_period??'').trim().toLowerCase();
  if(label&&!['long term','short term','long-term','short-term','long','short'].includes(label))return {term:'unknown',reason:'Broker holding-period label needs review.'};
  if(label&&validDate(effectiveDate)&&ordinaryHoldingTerm(lot.acquisition_date,effectiveDate)!==(label.startsWith('long')?'long':'short'))return {term:'unknown',reason:'Broker holding period conflicts with the acquisition date at the lot snapshot date.'};
  return {term,reason:'Date-based ordinary-purchase scenario; adjusted holding periods are not established.'};
}
function screenLot(candidate,valuations,transactions,accounts,input,window,today,coverage){
  const evidence=[],uncertainties=[],excludedOriginal=[];
  const add=(record)=>evidence.push(record);
  for(const t of transactions){
    if(t.symbol!==null&&t.symbol!==candidate.symbol)continue;
    if(t.date!==null&&(t.date<window.start||t.date>window.end))continue;
    const record={kind:'activity',accountId:t.accountId,accountLabel:accounts.find(a=>a.id===t.accountId)?.label??t.accountId,accountType:accounts.find(a=>a.id===t.accountId)?.type??'unknown',batchId:t.batchId,rowRef:t.rowRef,id:t.id,date:t.date,quantity:t.quantity,symbol:t.symbol,action:t.action,reference:t.reference};
    if(['buy','reinvest'].includes(t.action)){
      if(t.quantity!==null&&!positive(t.quantity))continue;
      // A matching acquisition date is not proof that a transaction is the original
      // acquisition of this lot. Keep it as ambiguous evidence, never silently net it.
      const possibleOriginal=t.accountId===candidate.accountId&&t.date===candidate.acquired;
      add({...record,possibleOriginal,reason:possibleOriginal?'May describe the candidate’s original acquisition; no transaction-to-lot link exists.':'Possible acquisition within the inclusive window.'});
    }else if(['transfer_in','transfer_out','adjustment','other','sell'].includes(t.action)){
      uncertainties.push({...record,reason:t.action==='sell'?'Disposal is not linked to a specific lot or replacement acquisition.':'Transfer or unclassified activity needs review; acquisition identity is unresolved.'});
    }
  }
  for(const holding of valuations){
    if(holding.symbol!==candidate.symbol)continue;
    for(const lot of holding.lots){
      const record={kind:'snapshot',accountId:holding.accountId,accountLabel:holding.accountLabel,accountType:holding.accountType,symbol:holding.symbol,rowRef:lot.row_ref,index:lot.index,date:lot.acquisition_date,quantity:lot.quantity,sourceId:holding.lotSourceId,reference:holding.lotDate??'Snapshot effective date unknown'};
      if(holding.accountId===candidate.accountId&&lot.index===candidate.index){excludedOriginal.push({...record,reason:'The candidate lot itself is not a replacement acquisition.'});continue;}
      if(lot.acquisition_date&& (lot.acquisition_date<window.start||lot.acquisition_date>window.end))continue;
      if(lot.quantity!==null&&!positive(lot.quantity))continue;
      add({...record,reason:'Other held lot with a matching symbol; snapshot evidence, not an imported transaction.'});
    }
  }
  const gaps=[];
  if(input.household!=='all_known_listed')gaps.push('Household account inventory is unreviewed or has unlisted accounts.');
  if(window.end>=today)gaps.push(`Forward activity remains open through ${window.end}; current/future days cannot establish completed coverage.`);
  for(const a of accounts){
    if(a.type==='unknown'||a.type==='other')gaps.push(`${a.label}: account classification is unresolved.`);
    const c=coverage.find(c=>c.accountId===a.id);
    if(c.status!=='covered_in_supplied_records')gaps.push(`${a.label}: ${c.status.replaceAll('_',' ')}${c.gaps.length?` (${c.gaps.map(g=>`${g.start} to ${g.end}`).join('; ')})`:''}.`);
  }
  if(uncertainties.length)gaps.push('Relevant disposals, transfers or unclassified rows cannot be matched to lots.');
  // Quantity is shown per record. Snapshot and transaction evidence can describe
  // the same acquisition, so adding them would invent a matched wash-sale amount.
  const status=evidence.length?'possible_acquisition':gaps.length?'insufficient_history':'no_same_symbol_acquisition_observed';
  return {status,window,evidence,uncertainties,excludedOriginal,gaps,coverage,matchedQuantity:null,disallowedLoss:null};
}
export function buildCandidates({state,prices,asOf,input:rawInput,activity,today,ordinaryPurchase=false}){
  check(validDate(today),'Current calendar date is required.');
  const input=validateInputs(projectInputs(rawInput,state.accounts),state.accounts);
  const valuations=buildValuation(state,prices,asOf),effective=correctionView(state);
  for(const h of valuations)h.lotSourceId=effective.holdings[h.accountId][h.symbol].lotScope?.source_id??null;
  const sale=input.analysisDate,window=sale?{start:shiftDate(sale,-30),end:shiftDate(sale,30)}:null;
  const coverage=window?activityCoverage(activity,state.accounts,window.start,window.end):[];
  const transactions=activityView(activity).transactions;
  const reconciliation=transactionReconciliation(state,activity);
  const rows=[];
  for(const holding of valuations){
    const scope=input.accounts.find(a=>a.accountId===holding.accountId)?.scope;
    const h=effective.holdings[holding.accountId][holding.symbol];
    for(const lot of holding.lots.length?holding.lots:[null]){
      const excluded=[],warnings=[...holding.issues.map(i=>i.title),...(lot?.reasons??holding.reasons)];
      const pending=reconciliation.find(r=>r.accountId===holding.accountId&&r.symbol===holding.symbol);
      if(pending)excluded.push(pending.message);
      if(scope!=='include')excluded.push(scope==='omit'?'Account omitted from candidates.':'Account inclusion is not reviewed.');
      if(holding.accountType!=='taxable')excluded.push('Only accounts classified taxable supply loss candidates.');
      if(!lot)excluded.push('No lot rows; position totals cannot substitute for lot evidence.');
      if(holding.lotCoverage!=='complete')excluded.push('A complete current lot snapshot is required.');
      if(holding.issues.some(i=>['Totals','Source conflicts'].includes(i.category)))excluded.push('Reconcile conflicting totals or source evidence before using this lot as a candidate.');
      if(!sale)excluded.push('Set the analysis date in Analysis inputs.');
      if(lot&&!positive(lot.quantity))excluded.push('Lot quantity must be known and positive.');
      if(lot?.total_basis!==null&&lot?.total_basis!==undefined&&cmp(lot.total_basis,'0')<0)excluded.push('Negative basis requires separate review.');
      if(lot?.pnl==null)excluded.push('Lot loss cannot be calculated from the supplied price, currency and basis.');
      const loss=lot?.pnl!=null&&cmp(lot.pnl,'0')<0?subtract('0',lot.pnl):null;
      if(lot?.pnl!=null&&!loss)excluded.push('No unrealized loss at the supplied price.');
      if(input.minLoss.amount===null)excluded.push('Set the minimum lot loss threshold.');
      else if(lot&&lot.currency!==input.minLoss.currency)excluded.push('Lot currency differs from the minimum-loss threshold currency.');
      else if(loss&&cmp(loss,input.minLoss.amount)<0)excluded.push('Loss is below the per-lot threshold.');
      if(lot?.acquisition_date&&sale&&lot.acquisition_date>sale)excluded.push('Lot acquisition is after the analysis date.');
      if(sale&&[holding.positionDate,holding.lotDate].some(d=>d&&d.slice(0,10)>sale))excluded.push('Holding evidence is after the analysis date; historical holdings are not reconstructed.');
      if(sale&&asOf.slice(0,10)!==sale)warnings.push('Valuation UTC date differs from analysis date; this is a mixed-date scenario.');
      if(sale&&holding.lotDate?.slice(0,10)!==sale)warnings.push('Lot snapshot is not dated on the proposed sale day; current ownership is not independently verified.');
      const term=lot?lotTerm(lot,sale,holding.lotDate?.slice(0,10),ordinaryPurchase):{term:'unknown',reason:'No lot evidence.'};
      const row={key:JSON.stringify([holding.accountId,holding.symbol,lot?.index??null]),accountId:holding.accountId,accountLabel:holding.accountLabel,symbol:holding.symbol,index:lot?.index??null,rowRef:lot?.row_ref??null,acquired:lot?.acquisition_date??null,quantity:lot?.quantity??null,basis:lot?.total_basis??null,currency:lot?.currency??holding.currency,loss,marketValue:lot?.marketValue??null,price:holding.price,priceStatus:holding.priceStatus,positionDate:holding.positionDate,lotDate:holding.lotDate,sourceId:h.lotScope?.source_id??null,sourceRef:h.lotScope?.source_ref??null,brokerTerm:lot?.broker_holding_period??null,term,excluded,warnings:[...new Set(warnings)],candidate:excluded.length===0,screen:null,scenarioSavings:null,savingsReason:''};
      if(lot&&loss&&window)row.screen=screenLot(row,valuations,transactions,state.accounts,input,window,today,coverage);
      const rate=term.term==='long'?input.rates.federalLong:term.term==='short'?input.rates.federalShort:null;
      if(row.candidate&&term.term!=='unknown'&&rate!==null&&input.rates.state!==null&&row.warnings.length===0){row.scenarioSavings=multiply(multiply(loss,total([rate,input.rates.state])),'0.01');row.savingsReason='Conditional loss × (federal term rate + state rate), before wash-sale adjustments, netting, limits, fees and special rules. Not deductible loss or an expected refund.';}
      else row.savingsReason='Unavailable: requires an included loss candidate, usable reconciled evidence, ordinary-purchase term and both rate assumptions.';
      rows.push(row);
    }
  }
  rows.sort((a,b)=>Number(b.candidate)-Number(a.candidate)||Number(b.scenarioSavings!==null)-Number(a.scenarioSavings!==null)||(a.scenarioSavings!==null&&b.scenarioSavings!==null?-cmp(a.scenarioSavings,b.scenarioSavings):0)||(a.loss&&b.loss?-cmp(a.loss,b.loss):0)||a.key.localeCompare(b.key));
  return {rows,reconciliation,input,window,coverage,asOf,today,ordinaryPurchase,positionCount:valuations.length,candidateCount:rows.filter(r=>r.candidate).length,excludedCount:rows.filter(r=>!r.candidate).length,sources:taxSources};
}

import {activityView} from '../activity/engine.mjs';
import {correctionView} from '../import/corrections.mjs';
// Observation dates locate the capture relative to trades; they do not establish
// a broker effective date or transaction-to-lot allocation. Same-day remains ambiguous.
const evidenceDate=v=>v?.effective_at?.slice(0,10)??v?.effective_date??v?.observed_at?.slice(0,10)??null;
export function transactionReconciliation(raw,activity){
 const state=correctionView(raw),sales=activityView(activity).transactions.filter(t=>t.action==='sell'),result=[];
 for(const account of state.accounts)for(const [symbol,h] of Object.entries(state.holdings[account.id]??{})){
  if(!h.active)continue;
  const positionDate=evidenceDate(h.position),lotDate=evidenceDate(h.lotScope);
  const pending=sales.filter(s=>s.accountId===account.id&&s.symbol===symbol&&(!s.date||!positionDate||!lotDate||s.date>=positionDate||s.date>=lotDate));
  if(pending.length)result.push({accountId:account.id,symbol,sales:pending.map(s=>({date:s.date,quantity:s.quantity,rowRef:s.rowRef})),positionDate,lotDate,message:'Holdings need reconciliation: imported sales are not followed by dated position and lot evidence. Import a complete updated positions export and lots; same-day evidence needs timing review.'});
 }
 return result;
}

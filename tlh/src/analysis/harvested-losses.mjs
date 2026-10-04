import {activityView} from '../activity/engine.mjs';
export function harvestedLossSummary(activity,accounts,today){
 if(!activity)return null;
 const taxable=new Set(accounts.filter(a=>a.type==='taxable').map(a=>a.id));
 const sales=activityView(activity).transactions.filter(t=>t.action==='sell'&&taxable.has(t.accountId));
 const dated=sales.filter(s=>s.date&&s.date<=today),dates=dated.map(s=>s.date).sort();
 // The accepted Activity contract has no realized basis or gain/loss fields.
 // Neither sale proceeds nor current/previous snapshot P/L establishes realized loss.
 return {saleCount:dated.length,unresolvedCount:dated.length,amount:null,start:dates[0]??null,end:dates.at(-1)??null,undated:sales.filter(s=>!s.date).length,future:sales.filter(s=>s.date&&s.date>today).length};
}

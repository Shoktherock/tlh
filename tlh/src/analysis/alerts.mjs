import {transactionReconciliation} from './transaction-reconciliation.mjs';
import {buildValuation,subtract,total} from '../valuation/engine.mjs';
import {previousWeekday} from '../../server/massive-service.mjs';
export const defaultAlertPreferences={opportunities:true,dataQuality:true,tracking:true,minLoss:'100'};
export function validateAlertPreferences(p){
 if(!p||Object.keys(p).sort().join(',')!=='dataQuality,minLoss,opportunities,tracking'||['opportunities','dataQuality','tracking'].some(k=>typeof p[k]!=='boolean')||typeof p.minLoss!=='string'||!/^\d{1,9}(?:\.\d{1,2})?$/.test(p.minLoss))throw Error('Choose alert categories and a USD loss threshold from 0 to 999,999,999.99.');
 return {...p};
}
export function alertConditions({state,quotes,tracking,preferences,now,activityRevision,activity}){
 const p=validateAlertPreferences(preferences),alerts=[],today=now.slice(0,10),prices=quotes.items.filter(i=>i.valid&&i.quote).map(i=>i.quote),rows=buildValuation(state,prices,now);
 const add=(key,category,title,message,target,evidence,signal)=>alerts.push({key,category,title,message,target,evidence,signal});
 const pending=activity?transactionReconciliation(state,activity):[];
 const latest=previousWeekday(now),fresh=Boolean(quotes.priceDate&&quotes.priceDate>=latest),evaluated={opportunity:!p.opportunities||fresh,data: true,tracking:true};
 if(p.dataQuality){
  if(pending.length)add('transaction-reconciliation','data','Holdings need reconciliation after sales',`${pending.length} holdings have sales not followed by dated position and lot evidence.`,{view:'Loss candidates'},{holdings:pending},[state.revision,activityRevision]);
  if(!fresh)add('prices','data','Daily prices need attention',quotes.priceDate?`Saved closes are dated ${quotes.priceDate}; check for a more recent trading session.`:'No saved daily prices are available.',{view:'Valuation'},{priceDate:quotes.priceDate,expectedWeekday:latest},[quotes.priceDate??null]);
  const missing=rows.filter(r=>['missing','invalid','future'].includes(r.priceStatus));
  if(missing.length)add('missing-prices','data','Some holdings have no usable price',`${missing.length} holdings cannot be valued with the saved daily summary.`,{view:'Valuation'},{holdings:missing.map(r=>({accountId:r.accountId,symbol:r.symbol,status:r.priceStatus}))},missing.map(r=>r.key).sort());
  const gaps=rows.filter(r=>r.lotCoverage!=='complete'||r.issues.some(i=>['Totals','Source conflicts'].includes(i.category)));
  if(gaps.length)add('holding-evidence','data','Holding evidence needs reconciliation',`${gaps.length} holdings have incomplete lots or conflicting evidence.`,{view:'Reconciliation'},{holdings:gaps.map(r=>({accountId:r.accountId,symbol:r.symbol,coverage:r.lotCoverage,issues:r.issues}))},[state.revision,gaps.map(r=>r.key).sort()]);
 }
 if(p.opportunities&&fresh)for(const r of rows){
  if(pending.some(p=>p.accountId===r.accountId&&p.symbol===r.symbol))continue;
  if(r.accountType!=='taxable'||r.currency!=='USD'||r.lotCoverage!=='complete'||r.issues.some(i=>['Totals','Source conflicts'].includes(i.category))||['missing','invalid','future'].includes(r.priceStatus)||[r.positionDate,r.lotDate].some(d=>d&&d.slice(0,10)>today))continue;
  const lots=r.lots.filter(l=>l.pnl?.startsWith('-')&&l.currency==='USD'&&l.quantity&& subtract(l.quantity,'0')!=='0'&&!l.quantity.startsWith('-')&&l.total_basis&&!l.total_basis.startsWith('-')&&(!l.acquisition_date||l.acquisition_date<=today));
  if(!lots.length)continue;const loss=total(lots.map(l=>subtract('0',l.pnl)));if(subtract(loss,p.minLoss).startsWith('-'))continue;
  add(`opportunity:${r.key}`,'opportunity',`${r.symbol}: potential loss to review`,`Losing lots total $${loss}, before fees or tax adjustments. Daily close ${quotes.priceDate}.`,{view:'Loss candidates',symbol:r.symbol,accountId:r.accountId},{accountId:r.accountId,symbol:r.symbol,loss,priceDate:quotes.priceDate,lotRows:lots.map(l=>l.index),holdingsRevision:state.revision},[p.minLoss]);
 }
 if(p.tracking)for(const s of tracking.sales){
  if(!s.active||s.accountType!=='taxable'||['review closed','review recorded'].includes(s.reviewStatus))continue;
  add(`sale:${s.id}`,'tracking',`${s.symbol??'Unknown symbol'}: sale review needed`,s.phase==='window_elapsed'?'The inclusive review window has elapsed. Review evidence and gaps before closing.':s.reviewStatus==='evidence changed — review again'?'Evidence changed since the last review. Inspect acquisitions and coverage again.':'Imported sale evidence is ready for review.',{view:'Tracking',saleId:s.id},{saleId:s.id,date:s.date,window:s.window,source:s.source,rowRef:s.rowRef,activityRevision,holdingsRevision:state.revision,phase:s.phase},[activityRevision,state.revision,s.phase,s.reviewStatus]);
 }
 return {alerts,evaluated};
}

import {ReviewError} from '../src/review-error.mjs';
import {databaseError} from './database-error.mjs';
import {planningEnvelope,inspectPlanning,mapPlanning,canonical} from '../src/analysis/planning-backup.mjs';
import {hashText} from '../src/activity/engine.mjs';
const result=async p=>{const r=await p;if(r.error)throw databaseError(r.error);return r.data;};
export async function planningRecovery(db,user,body){
 if(body.action==='planning-export'){
  const data=await result(db.rpc('export_planning',{p_user:user}));
  const backup=await planningEnvelope(data);await inspectPlanning(backup);return {backup};
 }
 const data=await inspectPlanning(body.backup),targets=await result(db.rpc('export_planning',{p_user:user}));
 const mapping=mapPlanning(data,body.mapping,targets);
 const strategyState=targets.strategies.map(s=>({portfolio_id:s.portfolio_id,revision:s.revision,universe_id:s.universe_id,exclusions:s.exclusions}));
 const previewHash=await hashText(canonical({checksum:body.backup.checksum,mapping,strategyState,accounts:targets.accounts,portfolios:targets.portfolios}));
 const payload={...data,universes:data.universes.map(u=>({...u,name:u.document.name,benchmark:u.document.benchmark,provenance:u.document.provenance,as_of:u.document.asOf,valid_through:u.document.validThrough,member_count:u.document.members.length}))};
 for(const s of data.strategies){const current=targets.strategies.find(t=>t.portfolio_id===mapping.portfolios[s.portfolio_id]);if(current){const source=data.universes.find(u=>u.id===s.universe_id),existing=targets.universes.find(u=>u.id===current.universe_id);if(source.hash!==existing?.hash||canonical(s.exclusions)!==canonical(current.exclusions))throw new ReviewError('A destination has a different active strategy. Choose another portfolio; restore never overwrites it.');}}
 for(const draft of data.drafts){const existing=targets.drafts.find(d=>d.evidence_hash===draft.evidence_hash);if(existing&&(existing.account_id!==mapping.accounts[draft.account_id]||existing.portfolio_id!==mapping.portfolios[draft.portfolio_id]||canonical(existing.evidence)!==canonical(draft.evidence)))throw new ReviewError('A matching draft already exists under different evidence or destinations. Choose its existing destination.');}
 if(body.action==='planning-preview')return {preview:{hash:previewHash,counts:{universes:data.universes.length,strategies:data.strategies.length,drafts:data.drafts.length,saleReviews:data.saleReviews?.length??0},portfolios:data.portfolios.map(p=>({source:p.name,destination:targets.portfolios.find(t=>t.id===mapping.portfolios[p.id]).name}))}};
 if(body.action!=='planning-restore'||body.reviewed!==true||body.hash!==previewHash)throw new ReviewError('Destination evidence changed or review is missing. Build and review a new preview.');
 return {restore:await result(db.rpc('restore_planning',{p_user:user,p_checksum:body.backup.checksum,p_data:payload,p_mapping:mapping,p_expected:strategyState}))};
}

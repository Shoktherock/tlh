import {saleInventory,saleEvidence} from '../src/analysis/sale-tracking.mjs';
import {canonical} from '../src/analysis/planning-backup.mjs';
import {hashText} from '../src/activity/engine.mjs';
const value=async p=>{const r=await p;if(r.error)throw Error(r.error.message);return r.data;};
export async function trackingService(db,user,body){
 const [activity,holdings,reviews]=await Promise.all([value(db.rpc('read_activity',{p_user:user})),value(db.rpc('read_import_state',{p_user:user})),value(db.from('sale_reviews').select('id,sale_id,disposition,note,created_at,restored_from,evidence_hash,revision:evidence->revision').eq('user_id',user).order('created_at',{ascending:false}).limit(1001))]);
 if(reviews.length>1000)throw Error('Tracking review limit reached (1,000). Export planning evidence before continuing.');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date());
 if(canonical(activity.accounts.map(a=>[a.id,a.type]).sort())!==canonical(holdings.accounts.map(a=>[a.id,a.type]).sort()))throw Error('Accounts changed during loading. Refresh tracking.');
 const inventory=await hashText(canonical(holdings.accounts)),revision={activity:activity.revision,holdings:holdings.revision,inventory,policy:1};
 const sales=saleInventory(activity.state,holdings.accounts,today);
 const stamp=sale=>({...revision,phase:sale.phase});
 const latest=sale=>reviews.find(r=>!r.restored_from&&r.sale_id===sale.id);
 const current=(sale,r)=>r&&canonical(r.revision)===canonical(stamp(sale));
 if(body.action==='tracking-read')return {today,sales:sales.map(s=>{const r=latest(s);return {...s,reviewStatus:!s.active?'source inactive':!r?'needs review':current(s,r)?r.disposition==='closed'?'review closed':'review recorded':'evidence changed — review again'};}),restoredReviews:reviews.filter(r=>r.restored_from).length,restoredHistory:reviews.filter(r=>r.restored_from).map(r=>({id:r.id,at:r.created_at,note:r.note,disposition:r.disposition}))};
 const sale=sales.find(s=>s.id===body.saleId);if(!sale)throw Error('Choose a sale from your imported activity.');
 const evidence={version:1,revision:stamp(sale),...saleEvidence({sale,activity:activity.state,holdings,accounts:holdings.accounts,today})};
 const hash=await hashText(canonical(evidence));
 if(body.action==='tracking-detail')return {evidence,hash,reviews:reviews.filter(r=>!r.restored_from&&r.sale_id===sale.id)};
 if(body.action!=='tracking-review'||!sale.active||sale.accountType!=='taxable'||body.reviewed!==true||body.hash!==hash)throw Error('Evidence changed, source is inactive, or review is missing. Refresh and review again.');
 if(!['reviewed','closed'].includes(body.disposition)||typeof body.note!=='string'||body.note.trim().length<3||body.note.length>1000)throw Error('Choose a review result and provide a note (3–1,000 characters).');
 if(body.disposition==='closed'&&sale.phase!=='window_elapsed')throw Error('The inclusive sale window must elapse before closing a review.');
 // RPC checks revisions again under the same state locks used by activity/import commits.
 return {review:await value(db.rpc('record_sale_review',{p_user:user,p_sale:sale.id,p_hash:hash,p_evidence:evidence,p_disposition:body.disposition,p_note:body.note.trim(),p_activity:activity.revision,p_holdings:holdings.revision}))};
}

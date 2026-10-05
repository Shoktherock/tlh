import {ReviewError} from '../src/review-error.mjs';
import {previewActivity,emptyActivity,activityView,checkActivityLimits,restoreActivity,hashText} from '../src/activity/engine.mjs';
const check=(ok,message)=>{if(!ok)throw new ReviewError(message);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const value=async request=>{const {data,error}=await request;if(error)throw new ReviewError(/stale|inventory/.test(error.message)?'This activity review is stale. Reload and review again.':/expired/.test(error.message)?'This activity review expired. Preview again.':'Activity storage or review is unavailable. Reload to check the result.');return data;};
export async function activityService(db,user,body){
  check(uuid(user),'Sign in to continue.');const read=()=>value(db.rpc('read_activity',{p_user:user}));
  if(body?.action==='read')return read();
  if(body?.action==='accept'){
    check(uuid(body.preparedId)&&body.reviewed===true,'Review the source, overlaps and coverage before accepting.');
    const receipt=await value(db.rpc('commit_activity',{p_user:user,p_prepared:body.preparedId}));return {receipt,saved:await read()};
  }
  const saved=await read();saved.state??=emptyActivity();
  if(body?.action==='export'){
    const used=new Set(activityView(saved.state).batches.map(b=>b.accountId));const backup={format:'tlh-activity-backup',version:1,exportedAt:new Date().toISOString(),accounts:saved.accounts.filter(a=>used.has(a.id)),state:saved.state};
    check(new TextEncoder().encode(JSON.stringify(backup)).length<=8*1024*1024,'Activity backup exceeds 8 MB.');return {backup};
  }
  check(['prepare','prepare-withdraw','prepare-restore'].includes(body?.action),'Unknown activity action.');
  check(body.baseRevision===saved.revision,'This activity review is stale. Reload and review again.');
  let after,review,reason,kind;
  if(body.action==='prepare'){
    const account=saved.accounts.find(a=>a.id===body.accountId);check(account,'Choose one of your accounts.');
    review=await previewActivity(saved.state,account.id,body.source,body.decisions??{});
    if(review.duplicate)return {duplicate:review.duplicate};
    if(review.unresolved.length)return {preview:{...review,preparedId:null}};
    after={version:1,events:[...saved.state.events,review.batch]};reason=review.document.reason;kind='batch';
    review={...review,accountLabel:account.label};
  }else{
    check(typeof body.reason==='string'&&body.reason.trim().length>=3&&body.reason.length<=1000,'Give a review reason (3–1000 characters).');reason=body.reason.trim();
    if(body.action==='prepare-withdraw'){
      const view=activityView(saved.state),batch=view.batches.find(b=>b.id===body.batchId&&!view.withdrawn.has(b.id));check(batch,'Choose an available activity source.');
      after={version:1,events:[...saved.state.events,{kind:'withdraw',id:crypto.randomUUID(),batchId:batch.id,reason}]};kind='withdraw';
      const next=activityView(after);review={kind,source:batch.source.name,removedRows:view.transactions.length-next.transactions.length,suspendedSources:next.suspended.length,warnings:['Withdrawal removes this source from current activity and coverage; dependent overlap sources are suspended. Original evidence remains in history.']};
    }else{
      after=await restoreActivity(body.backup,body.mapping,saved.accounts,saved.state);kind='restore';review={kind,restoredEvents:after.events.length-saved.state.events.length,mapping:body.mapping,sourceAccounts:body.backup.accounts,warnings:['Historical actors and timestamps are from the supplied backup. This restore is separately attributed to your sign-in.']};
    }
  }
  checkActivityLimits(after);
  const plan={baseRevision:saved.revision,accounts:saved.accounts,after,kind,reason,review,restoredHash:kind==='restore'?await hashText(JSON.stringify(body.backup)):null};
  const preparedId=await value(db.rpc('prepare_activity',{p_user:user,p_plan:plan}));return {preview:{...review,kind,reason,preparedId}};
}

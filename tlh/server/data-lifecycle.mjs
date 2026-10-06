import {ReviewError} from '../src/review-error.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
async function result(p){const r=await p;if(r.error){const allowed=['Deletion preview unavailable. Preview again.','Data changed or preview expired. Preview deletion again.','Original files remain. Retry deletion.','Deletion has not started.','Finish deletion before starting again.'];throw new ReviewError(r.error.code==='P0001'&&allowed.includes(r.error.message)?r.error.message:'Data privacy operation could not complete. Retry to check its status.');}return r.data;}
export async function dataLifecycle(db,user,body,{lastSignIn,passwordVerifiedAt,now=Date.now()}={}){
 if(body.action==='data-preview')return result(db.rpc('prepare_data_deletion',{p_user:user}));
 if(!Number.isFinite(passwordVerifiedAt)||now-passwordVerifiedAt>5*60*1000||passwordVerifiedAt>now+60000||!lastSignIn||!Number.isFinite(Date.parse(lastSignIn))||now-Date.parse(lastSignIn)>5*60*1000||Date.parse(lastSignIn)>now+60000)throw new ReviewError('Sign in again before deleting data or starting an empty workspace.');
 if(body.action==='data-reopen'){if(body.confirmation!=='START EMPTY')throw new ReviewError('Type START EMPTY to continue.');await result(db.rpc('reopen_financial_workspace',{p_user:user}));return {status:'ready'};}
 if(body.action!=='data-delete'||!uuid(body.token)||body.confirmation!=='DELETE MY DATA'||body.reviewed!==true)throw new ReviewError('Review the deletion scope and type DELETE MY DATA.');
 const job=await result(db.rpc('begin_data_deletion',{p_user:user,p_token:body.token}));
 if(job.status==='complete')return {status:'complete'};
 // Remove physical objects first. A failure leaves the workspace frozen and safely retryable.
 for(let i=0;i<job.paths.length;i+=50){const paths=job.paths.slice(i,i+50);if(paths.some(p=>typeof p!=='string'||!p.startsWith(user+'/')))throw new Error('Invalid deletion scope');await result(db.storage.from('import-sources').remove(paths));}
 return result(db.rpc('finish_data_deletion',{p_user:user,p_token:body.token}));
}

import {databaseError} from './database-error.mjs';
import {alertService} from './alert-service.mjs';
const value=async p=>{const r=await p;if(r.error)throw databaseError(r.error);return r.data;};
// Claims are database leases, so concurrent workers cannot pick the same user.
export async function runScheduledAlert(db,{scan=alertService}={}){
 const [job]=await value(db.rpc('claim_alert_schedule'));
 if(!job)return false;
 let success=false;
 try{
  const current=await value(db.from('alert_schedules').select('enabled,lease_id').eq('user_id',job.user_id).single());
  if(!current.enabled||current.lease_id!==job.lease_id)return true;
  await scan(db,job.user_id,{action:'alerts-scan'});success=true;
 }catch{/* Do not persist provider errors, account identifiers or tokens in worker logs. */}
 await value(db.rpc('finish_alert_schedule',{p_user:job.user_id,p_lease:job.lease_id,p_success:success}));
 return true;
}

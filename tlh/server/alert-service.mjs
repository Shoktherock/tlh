import {alertConditions,defaultAlertPreferences,validateAlertPreferences} from '../src/analysis/alerts.mjs';
import {canonical} from '../src/analysis/planning-backup.mjs';
import {hashText} from '../src/activity/engine.mjs';
import {quoteRepository} from './quote-service.mjs';
import {massiveService} from './massive-service.mjs';
import {trackingService} from './tracking-service.mjs';
const value=async p=>{const r=await p;if(r.error)throw Error(r.error.message);return r.data;};
export async function alertService(db,user,body){
 const settings=await value(db.from('alert_preferences').select('*').eq('user_id',user).maybeSingle()),preferences=settings?.preferences??defaultAlertPreferences,revision=settings?.revision??0;
 if(body.action==='alerts-schedule'){if(typeof body.enabled!=='boolean'||!Number.isInteger(body.revision))throw Error('Choose a valid schedule.');return {revision:await value(db.rpc('save_alert_schedule',{p_user:user,p_revision:body.revision,p_enabled:body.enabled}))};}
 if(body.action==='alerts-preferences'){const p=validateAlertPreferences(body.preferences);return {revision:await value(db.rpc('save_alert_preferences',{p_user:user,p_revision:body.revision,p_preferences:p}))};}
 if(body.action==='alerts-action'){
  if(!['acknowledge','snooze','reopen'].includes(body.choice)||!Number.isInteger(body.version))throw Error('Choose an alert action.');
  return {saved:await value(db.rpc('act_on_alert',{p_user:user,p_id:body.id,p_version:body.version,p_choice:body.choice}))};
 }
 if(body.action==='alerts-scan'){
  const now=new Date().toISOString(),[state,activity,quotes,tracking]=await Promise.all([value(db.rpc('read_import_state',{p_user:user})),value(db.rpc('read_activity',{p_user:user})),massiveService(quoteRepository(db),user,{action:'read'}),trackingService(db,user,{action:'tracking-read'})]);
  const inventory=a=>canonical(a.map(x=>[x.id,x.type]).sort());if(inventory(state.accounts)!==inventory(activity.accounts))throw Error('Accounts changed. Retry the alert check.');
  const result=alertConditions({state,quotes,tracking,preferences,now,activityRevision:activity.revision,activity:activity.state});
  if(result.alerts.length>2000)throw Error('More than 2,000 alert conditions. Narrow the categories or increase the loss threshold.');
  for(const a of result.alerts){a.fingerprint=await hashText(canonical(a.signal));delete a.signal;}
  return {scan:await value(db.rpc('commit_alert_scan',{p_user:user,p_preferences_revision:revision,p_holdings:state.revision,p_activity:activity.revision,p_alerts:result.alerts,p_evaluated:result.evaluated}))};
 }
 if(body.action!=='alerts-read')throw Error('Unknown alert action.');
 const [alerts,scans]=await Promise.all([value(db.from('alert_inbox').select('*').eq('user_id',user).order('last_seen',{ascending:false}).limit(2001)),value(db.from('alert_scans').select('*').eq('user_id',user).order('at',{ascending:false}).limit(10))]);
 if(alerts.length>2000)throw Error('Alert inbox exceeds the supported 2,000-record limit.');
 const schedule=await value(db.from('alert_schedules').select('*').eq('user_id',user).maybeSingle());
 const worker=await value(db.from('alert_worker_health').select('last_seen').eq('id',true).maybeSingle());
 return {preferences,revision,alerts,scans,schedule,worker,now:new Date().toISOString()};
}

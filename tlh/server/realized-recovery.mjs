import {ReviewError} from '../src/review-error.mjs';
import {databaseError} from './database-error.mjs';
import {parseRealized} from '../src/realized/engine.mjs';
import {canonical} from '../src/analysis/planning-backup.mjs';
import {hashText} from '../src/activity/engine.mjs';
const value=async p=>{const r=await p;if(r.error)throw databaseError(r.error);return r.data;};
const check=(v,m)=>{if(!v)throw new ReviewError(m);};
export async function realizedRecovery(db,user,body){
 const accounts=await value(db.from('accounts').select('id,label,account_type').eq('user_id',user));
 if(body.action==='realized-backup'){
  const reports=await value(db.from('realized_reports').select('id,account_id,name,source_text,source_hash,fingerprint,document,active,accepted_at,retired_at,retirement_reason,provenance').eq('user_id',user).order('id').limit(101));
  check(reports.length<=100,'Report history limit exceeded.');
  const payload={version:1,kind:'tlh-realized-history',exportedAt:new Date().toISOString(),accounts:accounts.filter(a=>reports.some(r=>r.account_id===a.id)),reports};
  check(JSON.stringify(payload).length<=10000000,'Backup exceeds 10 MB.');
  return {backup:{...payload,checksum:await hashText(canonical(payload))}};
 }
 check(['realized-restore-preview','realized-restore'].includes(body.action),'Unknown recovery action.');
 const backup=body.backup;check(backup&&JSON.stringify(backup).length<=10000000,'Choose a backup below 10 MB.');
 const {checksum,...payload}=backup;
 check(payload.version===1&&payload.kind==='tlh-realized-history'&&await hashText(canonical(payload))===checksum,'Backup checksum or format mismatch.');
 check(Array.isArray(payload.reports)&&payload.reports.length>0&&payload.reports.length<=100&&Array.isArray(payload.accounts),'Invalid report history.');
 const mapping=body.mapping??{},sources=[...new Set(payload.reports.map(r=>r.account_id))].sort();
 const targets=sources.map(id=>accounts.find(a=>a.id===mapping[id]&&a.account_type==='taxable'));
 check(targets.every(Boolean)&&new Set(targets.map(a=>a.id)).size===sources.length,'Map each source to a different owned taxable account.');
 check(new Set(payload.reports.map(r=>r.id)).size===payload.reports.length,'Duplicate report IDs.');
 const records=[];
 for(const r of payload.reports){
  check(typeof r.name==='string'&&r.name.length>0&&r.name.length<=240&&typeof r.active==='boolean','Invalid report metadata.');
  check(typeof r.accepted_at==='string'&&Number.isFinite(Date.parse(r.accepted_at)),'Invalid acceptance date.');
  check(r.active?r.retired_at===null&&r.retirement_reason===null:typeof r.retirement_reason==='string'&&r.retirement_reason.length>=3&&Number.isFinite(Date.parse(r.retired_at))&&Date.parse(r.retired_at)>=Date.parse(r.accepted_at),'Invalid retirement history.');
  check(await hashText(r.source_text)===r.source_hash,'Original checksum mismatch.');
  const document=parseRealized(r.source_text),fingerprint=await hashText(canonical({start:document.start,end:document.end,sourceAccount:document.sourceAccount,rows:document.rows.map(({row,...fields})=>fields).map(canonical).sort()}));
  check(canonical(document)===canonical(r.document)&&fingerprint===r.fingerprint,'Report does not match its original CSV.');
  check(!records.some(x=>x.account_id===mapping[r.account_id]&&(x.fingerprint===fingerprint||(x.active&&r.active&&x.document.start<=document.end&&x.document.end>=document.start))),'Duplicate or overlapping active reports in backup.');
  records.push({...r,account_id:mapping[r.account_id],document,provenance:{restoredFromReport:r.id,sourceAccount:payload.accounts.find(a=>a.id===r.account_id)??{id:r.account_id},backupChecksum:checksum,previous:r.provenance??null}});
 }
 const destinations=targets.map(a=>a.id).sort(),key=await hashText(canonical({checksum,mapping:sources.map(s=>[s,mapping[s]])}));
 const existing=await value(db.from('realized_restore_receipts').select('id').eq('user_id',user).eq('restore_key',key).maybeSingle());
 const occupied=await value(db.from('realized_reports').select('id').eq('user_id',user).in('account_id',destinations).limit(1));
 check(existing||occupied.length===0,'Restore requires accounts with no realized report history. Choose new destination accounts to preserve existing evidence.');
 const hash=await hashText(canonical({key,targets})),preview={hash,duplicate:!!existing,count:records.length,active:records.filter(r=>r.active).length,accounts:sources.map((s,i)=>({source:payload.accounts.find(a=>a.id===s)?.label??s,destination:targets[i].label}))};
 if(body.action==='realized-restore-preview')return {preview};
 check(body.reviewed===true&&body.hash===hash,'Review the backup and account mapping again.');
 return {restore:await value(db.rpc('restore_realized_history',{p_user:user,p_key:key,p_records:records}))};
}


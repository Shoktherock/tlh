import {ReviewError} from '../src/review-error.mjs';
import {databaseError} from './database-error.mjs';
import {realizedRecovery} from './realized-recovery.mjs';
import {parseRealized} from '../src/realized/engine.mjs';
import {canonical} from '../src/analysis/planning-backup.mjs';
import {hashText} from '../src/activity/engine.mjs';
const value=async p=>{const r=await p;if(r.error)throw databaseError(r.error);return r.data;};
const check=(v,m)=>{if(!v)throw new ReviewError(m);};
export async function realizedService(db,user,body){
 if(['realized-backup','realized-restore-preview','realized-restore'].includes(body.action))return realizedRecovery(db,user,body);
 const reports=await value(db.from('realized_reports').select('id,account_id,name,source_hash,fingerprint,document,active,accepted_at,retired_at,retirement_reason,provenance').eq('user_id',user).order('accepted_at',{ascending:false}).limit(101));check(reports.length<=100,'Realized report history exceeds supported limit.');
 if(body.action==='realized-read')return {reports};
 if(body.action==='realized-original'){const r=await value(db.from('realized_reports').select('name,source_text,source_hash').eq('user_id',user).eq('id',body.id).single());check(await hashText(r.source_text)===r.source_hash,'Original checksum mismatch');return r;}
 if(body.action==='realized-withdraw'){check(typeof body.reason==='string','Provide a reason.');return {withdrawn:await value(db.rpc('withdraw_realized',{p_user:user,p_id:body.id,p_reason:body.reason}))};}
 check(['realized-preview','realized-accept'].includes(body.action),'Unknown realized action');
 const account=await value(db.from('accounts').select('id,label,account_type').eq('user_id',user).eq('id',body.accountId).single());check(account.account_type==='taxable','Choose a taxable account.');
 check(typeof body.name==='string'&&body.name.length>0&&body.name.length<=240,'Choose a named report.');
 const document=parseRealized(body.text),fingerprint=await hashText(canonical({start:document.start,end:document.end,sourceAccount:document.sourceAccount,rows:document.rows.map(({row,...r})=>r).map(canonical).sort()})),sourceHash=await hashText(body.text),active=reports.filter(r=>r.account_id===account.id&&r.active),duplicate=active.find(r=>r.fingerprint===fingerprint);
 const overlap=active.filter(r=>r.document.start<=document.end&&r.document.end>=document.start);
 check(duplicate||overlap.every(r=>document.start<=r.document.start&&document.end>=r.document.end),'Overlapping reports require a replacement covering their entire date ranges. Export the full year to date.');
 const expected=active.map(r=>r.id).sort(),replace=overlap.map(r=>r.id).sort(),hash=await hashText(canonical({account,sourceHash,fingerprint,expected,replace}));
 const preview={document,account,hash,duplicate:!!duplicate,replaces:overlap.map(r=>({id:r.id,name:r.name,start:r.document.start,end:r.document.end}))};
 if(body.action==='realized-preview')return {preview};
 check(body.reviewed===true&&body.hash===hash,'Evidence changed or review missing. Preview and confirm account, USD and complete report range.');
 return {id:await value(db.rpc('commit_realized',{p_user:user,p_account:account.id,p_expected:expected,p_name:body.name,p_source:body.text,p_hash:sourceHash,p_fingerprint:fingerprint,p_document:document,p_replace:replace})),duplicate:!!duplicate};
}

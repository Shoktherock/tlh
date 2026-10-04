import { readSource, decodeSourceBytes, hash } from '../src/import/sources.mjs';
import { previewImport, acceptPreview } from '../src/import/engine.mjs';
import { validateBackup, restorePlan, canonical } from '../src/import/recovery.mjs';
import {previewCorrection} from '../src/import/corrections.mjs';

const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function requireValue(test,message){if(!test)throw new Error(message);}
async function value(request){const {data,error}=await request;if(error)throw new Error(error.message.includes('stale') ? 'This preview is stale. Refresh it before accepting.' : 'Database operation failed. Refresh the preview and try again.');return data;}
const snapshot=async(db,user)=>{
  const state=await value(db.rpc('read_import_state',{p_user:user}));
  state.imports.sort((a,b)=>a.baseRevision-b.baseRevision);
  return state;
};
function sourceMeta(s){const {text,data,...meta}=s;return meta;}
const restoreReview=(plan,preparedId)=>({preparedId,summary:plan.summary,targets:plan.targets,corrections:plan.corrections??[],
  history:plan.imports.map(b=>({acceptedAt:b.acceptedAt,acceptedBy:b.acceptedBy??null,accountId:b.accountId,decisions:b.decisions,options:b.options,sources:b.sources.map(s=>({name:s.name,id:s.id}))}))});
async function uploadedText(db,record){
  const blob=await value(db.storage.from('import-sources').download(record.path));
  requireValue(blob.size===record.bytes,'Uploaded file size changed. Upload it again.');
  const text=decodeSourceBytes(await blob.arrayBuffer());
  requireValue(await hash(text)===record.hash,'Uploaded file checksum does not match.');
  return text;
}

export async function importService(db,user,body){
  requireValue(uuid(user),'Sign in to continue.');
  switch(body?.action){
    case 'read': return {state:await snapshot(db,user)};
    case 'prepare-correction': {
      const plan=previewCorrection(await snapshot(db,user),body.request,user);
      const preparedId=await value(db.rpc('prepare_correction',{p_user:user,p_plan:plan}));
      return {preview:{...plan,preparedId}};
    }
    case 'accept-correction': {
      requireValue(uuid(body.preparedId)&&body.reviewed===true,'Review the original value, replacement, and reason before accepting.');
      const result=await value(db.rpc('commit_correction',{p_user:user,p_prepared:body.preparedId}));
      return {...result,state:await snapshot(db,user)};
    }
    case 'reserve': {
      requireValue(Array.isArray(body.files) && body.files.length>0 && body.files.length<=30,'Choose 1–30 files per import.');
      requireValue(body.files.reduce((n,f)=>n+f.bytes,0)<=52428800,'Limit each import to 50 MB.');
      const rows=body.files.map(f=>{
        requireValue(typeof f.name==='string' && f.name.length>0 && f.name.length<=240 && /^[a-f0-9]{64}$/.test(f.hash) && Number.isInteger(f.bytes) && f.bytes>0 && f.bytes<=26214400,'Invalid source file metadata.');
        const id=crypto.randomUUID();return {id,user_id:user,path:`${user}/${id}/source`,name:f.name,hash:f.hash,bytes:f.bytes};
      });
      const reserved=[];
      for(const row of rows){
        const existing=body.reuse===true ? await value(db.from('import_sources').select('id,path,name,hash,bytes').eq('user_id',user).eq('status','staged').eq('hash',row.hash).eq('bytes',row.bytes).eq('name',row.name).order('created_at',{ascending:false}).limit(1)) : [];
        reserved.push(existing[0] ?? await value(db.from('import_sources').insert(row).select('id,path,name,hash,bytes').single()));
      }
      return {sources:reserved};
    }
    case 'prepare': {
      requireValue(body.options && uuid(body.options.accountId) && typeof body.options.completeAccount==='boolean' && typeof body.options.sourceAccountRef==='string','Invalid account or coverage decisions.');
      requireValue(Array.isArray(body.sourceIds) && body.sourceIds.length>0 && body.sourceIds.length<=30 && body.sourceIds.every(uuid) && new Set(body.sourceIds).size===body.sourceIds.length,'Invalid source selection.');
      const records=await value(db.from('import_sources').select('*').eq('user_id',user).in('id',body.sourceIds).eq('status','staged'));
      requireValue(records.length===body.sourceIds.length,'Uploads are unavailable. Build a new preview.');
      records.sort((a,b)=>body.sourceIds.indexOf(a.id)-body.sourceIds.indexOf(b.id));
      const sources=[];
      for(const record of records){
        const source=await readSource({name:record.name,text:await uploadedText(db,record)});
        requireValue(source.id===record.hash,'Uploaded file checksum does not match.');
        sources.push({...source,objectId:record.id,path:record.path});
      }
      const state=await snapshot(db,user);
      const account=state.accounts.find(a=>a.id===body.options?.accountId);
      requireValue(account,'Choose one of your existing accounts.');
      requireValue(account.broker.toLowerCase()==='schwab','These import adapters support Schwab accounts.');
      const options={...body.options,accountLabel:account.label,accountType:account.type};
      const plan=await previewImport(state,sources,options);
      const preparedId=await value(db.rpc('prepare_import',{p_user:user,p_plan:plan,p_sources:body.sourceIds}));
      return {preview:{...plan,preparedId}};
    }
    case 'accept': {
      requireValue(uuid(body.preparedId),'Build a preview first.');
      const job=await value(db.from('prepared_imports').select('*').eq('id',body.preparedId).eq('user_id',user).maybeSingle());
      requireValue(job,'Preview unavailable.');
      if(job.result)return {...job.result,state:await snapshot(db,user)};
      const decision=body.decision;
      requireValue(decision && Array.isArray(decision.symbols) && decision.symbols.every(s=>typeof s==='string') && typeof decision.includeCash==='boolean' && typeof decision.mappingReviewed==='boolean' && typeof decision.timingReviewed==='boolean' && typeof decision.reason==='string' && decision.reason.length<=4000,'Invalid acceptance decisions.');
      const state=await snapshot(db,user);
      // The plan was computed by this service from immutable uploaded originals.
      // No client-provided holdings, totals, source data or preview rows are trusted.
      const result=acceptPreview(state,job.plan,decision);
      const record=result.duplicate ? null : result.state.imports.find(i=>i.id===result.importId);
      if(record&&job.plan.sources.some(s=>s.kind==='manual'))record.acceptedBy=user;
      if(record)record.sources=record.sources.map(sourceMeta);
      const holdings=Object.fromEntries(decision.symbols.map(symbol=>[symbol,result.state.holdings[job.account_id][symbol]]));
      const summary={duplicate:result.duplicate,importId:result.importId};
      const committed=await value(db.rpc('commit_import',{p_user:user,p_prepared:job.id,p_revision:state.revision,p_record:record,
        p_holdings:holdings,p_cash:decision.includeCash && job.plan.cash ? result.state.cash[job.account_id] : null,p_result:summary}));
      return {...committed,state:await snapshot(db,user)};
    }
    case 'recovery': {
      const uploads=await value(db.from('import_sources').select('id,name,bytes,status,created_at').eq('user_id',user).in('status',['staged','prepared']).order('created_at',{ascending:false}));
      const imports=await value(db.from('prepared_imports').select('id,account_id,created_at,source_ids').eq('user_id',user).is('result',null).gt('created_at',new Date(Date.now()-86400000).toISOString()));
      const restores=await value(db.from('prepared_restores').select('id,source_id,created_at').eq('user_id',user).is('result',null).gt('created_at',new Date(Date.now()-86400000).toISOString()));
      return {uploads,imports:imports.filter(r=>r.source_ids.every(id=>uploads.some(s=>s.id===id))),restores:restores.filter(r=>uploads.some(s=>s.id===r.source_id))};
    }
    case 'resume': {
      requireValue(uuid(body.preparedId),'Choose a saved preview.');
      const table=body.kind==='restore'?'prepared_restores':'prepared_imports';
      const job=await value(db.from(table).select('*').eq('user_id',user).eq('id',body.preparedId).maybeSingle());
      requireValue(job && !job.result && !job.plan.discarded && Date.parse(job.created_at)>Date.now()-86400000,'Preview unavailable or expired. Reselect the source files and build it again.');
      const current=await snapshot(db,user);
      requireValue(job.plan.baseRevision===current.revision,'This preview is stale. Reselect the source files and build a new preview.');
      return body.kind==='restore' ? {preview:restoreReview(job.plan,job.id)} : {preview:{...job.plan,preparedId:job.id}};
    }
    case 'prepare-restore': {
      requireValue(uuid(body.sourceId),'Choose a backup file.');
      const record=await value(db.from('import_sources').select('*').eq('user_id',user).eq('id',body.sourceId).eq('status','staged').maybeSingle());
      requireValue(record,'Backup upload is unavailable.');
      let backup;try{backup=JSON.parse(await uploadedText(db,record));}catch(error){throw new Error(`Backup could not be read: ${error.message}`);}
      const verified=await validateBackup(backup);
      const fingerprint=await hash(canonical([verified.fingerprint,body.mapping]));
      const receipt=await value(db.from('restore_receipts').select('result').eq('user_id',user).eq('fingerprint',fingerprint).maybeSingle());
      if(receipt)return {...receipt.result,duplicate:true};
      const plan=await restorePlan(verified,await snapshot(db,user),body.mapping,record);
      const preparedId=await value(db.rpc('prepare_restore',{p_user:user,p_source:record.id,p_plan:plan}));
      return {preview:restoreReview(plan,preparedId)};
    }
    case 'accept-restore': {
      requireValue(uuid(body.preparedId) && body.reviewed===true,'Review the backup, account mapping, and restored history before accepting.');
      const result=await value(db.rpc('commit_restore',{p_user:user,p_prepared:body.preparedId}));
      return {...result,state:await snapshot(db,user)};
    }
    case 'discard': {
      const records=await value(db.rpc('discard_import_sources',{p_user:user}));
      for(const record of records){
        await value(db.storage.from('import-sources').remove([record.path]));
        // Keep a tombstone so concurrent acceptance cannot resurrect discarded sources.
      }
      return {discarded:records.length};
    }
    default: throw new Error('Unsupported import request.');
  }
}

import {ReviewError} from '../src/review-error.mjs';
import {validateInputs,projectInputs,inputChanges,inputWarnings,exportInputsBackup,restoreInputsBackup} from '../src/analysis/inputs.mjs';
const check=(ok,message)=>{if(!ok)throw new ReviewError(message);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const value=async request=>{const {data,error}=await request;if(error)throw new ReviewError(/stale|classification|inventory/.test(error.message)?'This review is stale. Reload the saved inputs and preview again.':/expired/.test(error.message)?'This review expired. Build a new preview.':'Analysis input storage is unavailable or the review cannot be accepted. Reload and try again.');return data;};
export async function analysisInputService(db,user,body){
  check(uuid(user),'Sign in to continue.');
  const read=()=>value(db.rpc('read_analysis_inputs',{p_user:user}));
  if(body?.action==='read')return read();
  if(body?.action==='export'){const saved=await read();return {backup:exportInputsBackup(saved.input,saved.accounts)};}
  if(['prepare','prepare-restore'].includes(body?.action)){
    const saved=await read();check(Number.isSafeInteger(body.baseRevision)&&body.baseRevision===saved.revision,'This review is stale. Reload saved inputs before previewing.');
    check(typeof body.reason==='string'&&body.reason.trim().length>=3&&body.reason.length<=1000,'Describe why you are saving these inputs (3–1000 characters).');
    const after=body.action==='prepare-restore'?restoreInputsBackup(body.backup,body.mapping,saved.accounts):validateInputs(body.input,saved.accounts);
    const plan={baseRevision:saved.revision,accounts:saved.accounts,before:projectInputs(saved.input,saved.accounts),after,reason:body.reason.trim(),kind:body.action==='prepare-restore'?'restore':'save',provenance:body.action==='prepare-restore'?{exportedAt:body.backup.exportedAt,accounts:body.backup.accounts,mapping:body.mapping}:null,changes:inputChanges(saved.input,after,saved.accounts),warnings:inputWarnings(after,saved.accounts)};
    check(plan.changes.length>0,'These inputs match the saved values. Nothing needs to be saved.');
    const preparedId=await value(db.rpc('prepare_analysis_inputs',{p_user:user,p_plan:plan}));
    return {preview:{...plan,preparedId}};
  }
  if(body?.action==='accept'){
    check(uuid(body.preparedId)&&body.reviewed===true,'Review the changes and confirm before saving.');
    const receipt=await value(db.rpc('commit_analysis_inputs',{p_user:user,p_prepared:body.preparedId}));
    return {receipt,saved:await read()};
  }
  throw new ReviewError('Unknown analysis input action.');
}

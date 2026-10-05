import {ReviewError} from '../review-error.mjs';
import { readSource, hash } from './sources.mjs';
import { emptyState, previewImport, acceptPreview } from './engine.mjs';
import {previewCorrection,acceptCorrection,correctionView} from './corrections.mjs';

const check = (condition, message) => { if (!condition) throw new ReviewError(message); };
const safeKey = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !['__proto__','constructor','prototype'].includes(value);
export const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}

// Backups carry evidence and decisions. Replaying them is mandatory: client-provided
// holdings are only a cross-check, never a database write plan.
export async function validateBackup(input) {
  const saved = input?.format === 'tlh-portfolio-backup' && input.version === 1 ? input.state : input;
  check(saved?.version === 1 && Array.isArray(saved.accounts) && Array.isArray(saved.imports), 'Unsupported portfolio backup. Choose a TLH backup, not a brokerage export.');
  check(saved.accounts.length > 0 && saved.accounts.length <= 100 && saved.imports.length > 0 && saved.imports.length <= 100, 'A backup must contain 1–100 accounts and 1–100 accepted imports.');
  check(new Set(saved.accounts.map(a=>a.id)).size === saved.accounts.length && saved.accounts.every(a=>safeKey(a.id) && typeof a.label==='string' && a.label.trim() && a.label.length<=100 && ['taxable','traditional_ira','roth_ira','other','unknown'].includes(a.type) && a.broker?.toLowerCase()==='schwab'), 'Invalid backup accounts.');
  const corrections=saved.corrections??[];
  check(Array.isArray(corrections)&&corrections.length<=500,'A backup supports up to 500 correction events.');
  const ordered = [...saved.imports,...corrections].sort((a,b)=>a.baseRevision-b.baseRevision);
  check(new Set(ordered.map(b=>b.id)).size===ordered.length && new Set(ordered.map(b=>b.baseRevision)).size===ordered.length, 'Duplicate backup history identifiers or revisions.');
  let state = {...emptyState(),accounts:saved.accounts.map(({id,label,type,broker})=>({id,label,type,broker}))};
  const originalFiles = new Map();
  for (const batch of ordered) {
    if(corrections.includes(batch)){
      check(safeKey(batch.id)&&Number.isInteger(batch.baseRevision)&&batch.baseRevision>=0&&typeof batch.actor==='string'&&batch.actor.length>0&&batch.actor.length<=100&&typeof batch.at==='string'&&Number.isFinite(Date.parse(batch.at)),'Invalid correction audit metadata.');
      const plan=previewCorrection(state,{...batch,baseRevision:state.revision},batch.actor);
      check(canonical(plan.record.basis)===canonical(batch.basis)&&canonical(plan.record.before)===canonical(batch.before)&&canonical(plan.record.effectiveBefore)===canonical(batch.effectiveBefore)&&canonical(plan.record.value)===canonical(batch.value),'Correction audit does not match its historical source evidence.');
      state=acceptCorrection(state,plan,{reviewed:true},{id:()=>batch.id,now:()=>batch.at}).state;
      continue;
    }
    check(safeKey(batch.id) && Number.isInteger(batch.baseRevision) && batch.baseRevision>=0 && typeof batch.acceptedAt==='string' && Number.isFinite(Date.parse(batch.acceptedAt)), 'Invalid backup history metadata.');
    check(state.accounts.some(a=>a.id===batch.accountId) && batch.options && typeof batch.options.sourceAccountRef==='string' && typeof batch.options.completeAccount==='boolean', 'Invalid saved account mapping.');
    const d = batch.decisions;
    check(d && Array.isArray(d.symbols) && d.symbols.every(safeKey) && new Set(d.symbols).size===d.symbols.length && typeof d.includeCash==='boolean' && d.mappingReviewed===true && d.timingReviewed===true && typeof d.reason==='string' && d.reason.length<=4000, 'Invalid saved review decisions.');
    check(Array.isArray(batch.sources) && batch.sources.length>0 && batch.sources.length<=30, 'Backup history is missing original source files.');
    const sources = [];
    for (const file of batch.sources) {
      check(typeof file.name==='string' && file.name.length>0 && file.name.length<=240 && typeof file.text==='string', 'Backup is missing original source bytes. Export a full backup first.');
      const parsed = await readSource(file);
      check(parsed.id===file.id, `Backup source checksum mismatch: ${file.name}.`);
      sources.push(parsed); originalFiles.set(parsed.id,parsed);
    }
    const options = {...batch.options,accountId:batch.accountId};
    const plan = await previewImport(state,sources,options,{legacyTiming:batch.options.timingPolicy!==2});
    const result = acceptPreview(state,plan,d,{id:()=>batch.id,now:()=>batch.acceptedAt});
    check(!result.duplicate,'Backup contains duplicate history that cannot be replayed.');
    state = result.state;
    if(batch.acceptedBy!==undefined){
      check(typeof batch.acceptedBy==='string'&&batch.acceptedBy.length>0&&batch.acceptedBy.length<=100,'Invalid saved acceptance actor.');
      state.imports.at(-1).acceptedBy=batch.acceptedBy;
    }
  }
  check(canonical(state.holdings)===canonical(saved.holdings) && canonical(state.cash)===canonical(saved.cash), 'Backup holdings or cash do not match replayed source evidence and decisions. No restore was prepared.');
  // Ignore export time, storage paths, and derived source parsing when identifying a
  // repeated migration. Original evidence, historical decisions and identities count.
  const identity = {accounts:state.accounts,imports:state.imports.map(b=>({id:b.id,accountId:b.accountId,acceptedAt:b.acceptedAt,...(b.acceptedBy?{acceptedBy:b.acceptedBy}:{}),options:b.options,decisions:b.decisions,sources:b.sources.map(s=>({id:s.id,name:s.name}))})),...(corrections.length?{corrections:state.corrections}:{})};
  return {state,files:[...originalFiles.values()],fingerprint:await hash(canonical(identity)),summary:backupSummary(state)};
}

export function backupSummary(state) {
  const view=correctionView(state);
  return state.accounts.filter(a=>state.imports.some(b=>b.accountId===a.id)).map(a=>{
    const holdings=Object.values(view.holdings[a.id]??{});
    return {...a,holdings:holdings.filter(h=>h.active).length,closed:holdings.filter(h=>!h.active).length,lots:holdings.reduce((n,h)=>n+(h.lotScope?.lots.length??0),0),imports:state.imports.filter(b=>b.accountId===a.id).length,corrections:(state.corrections??[]).filter(c=>c.accountId===a.id).length,cash:state.cash[a.id]?.amount??null};
  });
}

export async function exportBackup(state, readOriginal) {
  const saved=structuredClone(state);const originals=new Map();
  for(const batch of saved.imports) for(const source of batch.sources) {
    if(!originals.has(source.id))originals.set(source.id,source.text??await readOriginal(source));
    source.text=originals.get(source.id);
  }
  const backup={format:'tlh-portfolio-backup',version:1,exportedAt:new Date().toISOString(),state:saved};
  await validateBackup(backup);
  const text=JSON.stringify(backup);
  check(new TextEncoder().encode(text).length<=26214400,'Backup exceeds the current 25 MB recovery limit. No file was exported.');
  return text;
}

export async function restorePlan(verified,current,mapping,source) {
  const summary=verified.summary;
  check(mapping && Object.keys(mapping).length===summary.length && summary.every(a=>safeKey(mapping[a.id])) && new Set(Object.values(mapping)).size===summary.length,'Map every source account to a distinct destination account.');
  const targets=summary.map(a=>{
    const target=current.accounts.find(t=>t.id===mapping[a.id]);
    check(target && target.broker?.toLowerCase()==='schwab' && target.type===a.type,'Choose an owned Schwab destination with the same account type.');
    check(!Object.keys(current.holdings[target.id]??{}).length && !current.cash[target.id] && !current.imports.some(b=>b.accountId===target.id),'Restore requires empty destination accounts. Existing holdings and history are never overwritten.');
    return {sourceId:a.id,id:target.id,type:target.type,label:target.label};
  });
  const ids=new Map(verified.state.imports.map(b=>[b.id,crypto.randomUUID()]));
  const correctionIds=new Map((verified.state.corrections??[]).map(c=>[c.id,crypto.randomUUID()]));
  const remapHolding = h => ({...structuredClone(h),lastImportId:ids.get(h.lastImportId)});
  const holdings=Object.fromEntries(targets.map(t=>[t.id,Object.fromEntries(Object.entries(verified.state.holdings[t.sourceId]??{}).map(([s,h])=>[s,remapHolding(h)]))]));
  const cash=Object.fromEntries(targets.filter(t=>verified.state.cash[t.sourceId]).map(t=>[t.id,remapHolding(verified.state.cash[t.sourceId])]));
  const restoredAt=new Date().toISOString();
  const imports=verified.state.imports.map(b=>({...b,id:ids.get(b.id),accountId:mapping[b.accountId],baseRevision:current.revision+b.baseRevision,
    options:{...b.options,accountId:mapping[b.accountId]},
    priorHoldings:Object.fromEntries(Object.entries(b.priorHoldings).map(([s,h])=>[s,remapHolding(h)])),
    sources:b.sources.map(s=>({id:s.id,name:s.name,kind:s.kind,objectId:source.id,path:source.path,backupSourceId:s.id})),
    restoration:{restoredAt,originalImportId:b.id,originalAccountId:b.accountId,backupFingerprint:verified.fingerprint}}));
  const restoredCorrections=(verified.state.corrections??[]).map(c=>({...c,id:correctionIds.get(c.id),previousId:correctionIds.get(c.previousId)??null,accountId:mapping[c.accountId],baseRevision:current.revision+c.baseRevision,
    restoration:{restoredAt,originalCorrectionId:c.id,originalAccountId:c.accountId,backupFingerprint:verified.fingerprint}}));
  return {baseRevision:current.revision,targets,holdings,cash,imports,corrections:restoredCorrections,summary,
    fingerprint:await hash(canonical([verified.fingerprint,mapping]))};
}

import {hashText} from '../activity/engine.mjs';
import {validateUniverse} from './replacements.mjs';
export const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v??null);
const check=(v,m)=>{if(!v)throw Error(m);};
const id=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
const hash=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
export async function planningEnvelope(data){return {format:'tlh-planning-backup',version:1,data,checksum:await hashText(canonical(data))};}
export async function inspectPlanning(raw){
 check(raw?.format==='tlh-planning-backup'&&raw.version===1,'Choose a version 1 planning backup.');
 check(new TextEncoder().encode(JSON.stringify(raw)).length<=10000000,'Planning backup limit is 10 MB.');
 const d=raw.data;check(d&&hash(raw.checksum)&&await hashText(canonical(d))===raw.checksum,'Planning backup checksum mismatch.');
 for(const key of ['portfolios','accounts','universes','strategies','events','drafts','restores']){
  check(Array.isArray(d[key])&&d[key].length<=1000,`Invalid or oversized ${key} list.`);
 }
 const unique=(rows,key)=>{const values=rows.map(r=>r[key]);check(values.every(id)&&new Set(values).size===values.length,'Invalid or duplicate record IDs.');};
 unique(d.portfolios,'id');unique(d.accounts,'id');unique(d.universes,'id');unique(d.drafts,'id');unique(d.strategies,'portfolio_id');
 for(const p of d.portfolios)check(typeof p.name==='string'&&p.name.length<=500,'Invalid portfolio label.');
 for(const a of d.accounts)check(typeof a.label==='string'&&a.label.length<=500&&typeof a.account_type==='string','Invalid account label or type.');
 const portfolios=new Set(d.portfolios.map(p=>p.id)),accounts=new Map(d.accounts.map(a=>[a.id,a])),universes=new Map(d.universes.map(u=>[u.id,u]));
 for(const a of d.accounts)check(portfolios.has(a.portfolio_id),'Account portfolio missing.');
 for(const u of d.universes){check(typeof u.source_text==='string'&&u.source_text.length<=2097152&&await hashText(u.source_text)===u.hash,'Universe source checksum mismatch.');const original=JSON.parse(u.source_text);if(original.originalCsv)check(await hashText(original.originalCsv.text)===original.originalCsv.hash,'Embedded source checksum mismatch.');check(canonical(validateUniverse(original))===canonical(validateUniverse(u.document)),'Universe document differs from source.');}
 for(const s of [...d.strategies,...d.events])check(portfolios.has(s.portfolio_id)&&universes.has(s.universe_id)&&Number.isSafeInteger(s.revision)&&s.revision>0&&Array.isArray(s.exclusions)&&s.exclusions.length<=5000&&s.exclusions.every(x=>typeof x==='string'&&/^[A-Z0-9][A-Z0-9./-]{0,24}$/.test(x)),'Invalid strategy references or exclusions.');
 for(const draft of d.drafts){const e=draft.evidence;check(hash(draft.evidence_hash)&&e?.version===1&&e.kind==='unexecuted-draft'&&e.comparison&&Array.isArray(e.selected?.lots)&&e.selected.lots.length>0&&e.selected.lots.length<=500&&typeof e.selected.quantity==='string'&&/^\d+(?:\.\d+)?$/.test(e.selected.quantity)&&typeof e.selected.amount==='string'&&/^\d+(?:\.\d+)?$/.test(e.selected.amount)&&typeof e.comparison.symbol==='string'&&typeof e.replacement?.symbol==='string'&&typeof e.price?.date==='string'&&typeof e.account?.label==='string','Invalid draft evidence.');const a=accounts.get(draft.account_id);check(a&&a.portfolio_id===draft.portfolio_id,'Draft destination references are missing.');check(draft.saved_at&&Number.isFinite(Date.parse(draft.saved_at)),'Invalid draft date.');}
 if(d.saleReviews!==undefined){check(Array.isArray(d.saleReviews)&&d.saleReviews.length<=1000,'Invalid sale review history.');for(const r of d.saleReviews)check(id(r.id)&&id(r.sale_id)&&hash(r.evidence_hash)&&r.evidence?.version===1&&r.evidence.sale&&['reviewed','closed'].includes(r.disposition)&&typeof r.note==='string'&&r.note.length>=3&&r.note.length<=1000&&Number.isFinite(Date.parse(r.created_at)),'Invalid sale review record.');}
 return d;
}
export function mapPlanning(data,mapping,targets){
 const pm=mapping?.portfolios??{},am=mapping?.accounts??{};
 check(new Set(Object.values(pm)).size===data.portfolios.length&&Object.keys(pm).length===data.portfolios.length,'Map each portfolio to a distinct destination.');
 check(new Set(Object.values(am)).size===data.accounts.length&&Object.keys(am).length===data.accounts.length,'Map each account to a distinct destination.');
 for(const p of data.portfolios)check(targets.portfolios.some(t=>t.id===pm[p.id]),'Choose owned destination portfolios.');
 for(const a of data.accounts)check(targets.accounts.some(t=>t.id===am[a.id]&&t.portfolio_id===pm[a.portfolio_id]&&t.account_type===a.account_type),'Destination account must have the same type and belong to the mapped portfolio.');
 return {portfolios:pm,accounts:am};
}

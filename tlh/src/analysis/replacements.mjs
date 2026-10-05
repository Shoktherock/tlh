import {ReviewError} from '../review-error.mjs';
import {validDate} from './inputs.mjs';
import {shiftDate} from './candidates.mjs';
import {correctionView} from '../import/corrections.mjs';
import {activityView,activityCoverage} from '../activity/engine.mjs';
import {sameReplacementIssuer} from './replacement-identity.mjs';
const check=(ok,message)=>{if(!ok)throw new ReviewError(message);};
const text=(v,max=200)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
export function validateUniverse(raw){
  check(raw?.format==='tlh-replacement-universe'&&raw.version===1,'Unsupported universe format/version.');
  check(text(raw.name)&&text(raw.benchmark)&&text(raw.source,1000),'Provide universe name, benchmark and source reference.');
  check(['official','curated','fund-proxy','synthetic'].includes(raw.provenance),'Choose explicit source provenance.');
  check(validDate(raw.asOf)&&validDate(raw.validThrough)&&raw.asOf<=raw.validThrough,'Provide a valid dated membership range.');
  check(Array.isArray(raw.members)&&raw.members.length>0&&raw.members.length<=5000,'Provide 1–5,000 universe members.');
  const symbols=new Set();
  const members=raw.members.map(m=>{
    check(m&&typeof m==='object','Provide a valid member object.');
    check(typeof m.symbol==='string'&&/^[A-Z0-9][A-Z0-9./-]{0,24}$/.test(m.symbol)&&!symbols.has(m.symbol),'Member symbols must be unique and exact.');symbols.add(m.symbol);
    check(text(m.name)&&['stock','etf','mutual-fund'].includes(m.type)&&/^[A-Z]{3}$/.test(m.currency),'Provide each member name, type and currency.');
    for(const field of ['sector','industry','sizeBand','benchmark','relatedGroup'])check(m[field]==null||text(m[field]),`Invalid ${field}. Use null when unknown.`);
    check(m.benchmarkWeight==null||typeof m.benchmarkWeight==='number'&&Number.isFinite(m.benchmarkWeight)&&m.benchmarkWeight>=0&&m.benchmarkWeight<=1,'Invalid benchmark weight.');
    return Object.fromEntries(['symbol','name','type','currency','sector','industry','sizeBand','benchmark','relatedGroup','benchmarkWeight'].map(k=>[k,m[k]??null]));
  });
  return {format:raw.format,version:1,name:raw.name.trim(),benchmark:raw.benchmark.trim(),source:raw.source.trim(),provenance:raw.provenance,asOf:raw.asOf,validThrough:raw.validThrough,members};
}
export function universeTemplate(){return {format:'tlh-replacement-universe',version:1,name:'Synthetic Russell 3000 workflow example — replace with reviewed data',benchmark:'Russell 3000',source:'Synthetic example only; not real index membership',provenance:'synthetic',asOf:'2026-09-01',validThrough:'2026-09-30',members:[{symbol:'EXAMPLE',name:'Synthetic source company',type:'stock',currency:'USD',sector:'Technology',industry:'Software',sizeBand:null,benchmark:null,relatedGroup:null},{symbol:'EXAMPLEB',name:'Synthetic candidate company',type:'stock',currency:'USD',sector:'Technology',industry:'Software',sizeBand:null,benchmark:null,relatedGroup:null}]};}
export function compareReplacements({universe,state,portfolioId,accountId,symbol,date,excluded=[],activity,daily,today}){
  const u=validateUniverse(universe),effective=correctionView(state);
  check(validDate(date)&&validDate(today),'Choose a valid comparison date.');
  check(u.asOf<=date&&date<=u.validThrough,'Universe snapshot is outside its review date range. Import a current version.');
  const account=state.accounts.find(a=>a.id===accountId&&a.portfolioId===portfolioId),holding=effective.holdings[accountId]?.[symbol];
  check(account?.type==='taxable'&&holding?.active,'Choose an active holding in a taxable account in this portfolio.');
  const source=u.members.find(m=>m.symbol===symbol);check(source,'Source symbol is not in this universe. Review membership or use another universe.');
  check(source.currency===(holding.position.currency??holding.confirmedCurrency)&&!(holding.position.currency&&holding.confirmedCurrency&&holding.position.currency!==holding.confirmedCurrency),'Resolve source currency before comparing.');
  const warnings=['Similarity does not establish substantially-identical treatment. No tax clearance or trades are provided.'];
  if(u.provenance!=='official')warnings.push(`Universe is ${u.provenance}; membership is supplied evidence, not verified official index membership.`);
  if(date>u.asOf)warnings.push(`Membership was observed on ${u.asOf}; use through ${u.validThrough} is a review cutoff, not proof that membership has stayed unchanged.`);
  if(Date.parse(date)-Date.parse(u.asOf)>30*86400000)warnings.push('Membership snapshot is more than 30 days old.');
  const window={start:shiftDate(date,-30),end:shiftDate(date,30)};
  const coverage=activityCoverage(activity,state.accounts,window.start,window.end),transactions=activityView(activity).transactions;
  warnings.push('Household accounts outside the app are not screened.');
  if(window.end>=today)warnings.push(`Future acquisition window remains open through ${window.end}.`);
  const gaps=coverage.filter(c=>c.status!=='covered_in_supplied_records').map(c=>c.accountId);
  if(gaps.length)warnings.push(`${gaps.length} listed accounts have incomplete supplied activity coverage.`);
  const held=new Set(state.accounts.filter(a=>a.portfolioId===portfolioId).flatMap(a=>Object.entries(effective.holdings[a.id]??{}).filter(([,h])=>h.active).map(([s])=>s)));
  const memberBySymbol=new Map(u.members.map(m=>[m.symbol,m]));
  const related=s=>{const group=memberBySymbol.get(s)?.relatedGroup;return new Set(group?u.members.filter(m=>m.symbol===s||m.relatedGroup===group).map(m=>m.symbol):[s]);};
  const evidenceFor=s=>{
    const symbols=related(s),evidence=[];
    for(const t of transactions)if((t.symbol===null||symbols.has(t.symbol))&&(t.date===null||t.date>=window.start&&t.date<=window.end))evidence.push({kind:'activity',accountId:t.accountId,symbol:t.symbol,date:t.date,quantity:t.quantity,action:t.action,reference:`${t.batchId} / ${t.rowRef}`});
    for(const a of state.accounts)for(const [sym,h] of Object.entries(effective.holdings[a.id]??{}))if(symbols.has(sym))for(const l of h.lotScope?.lots??[])if(!l.acquisition_date||l.acquisition_date>=window.start&&l.acquisition_date<=window.end)evidence.push({kind:'snapshot',accountId:a.id,symbol:sym,date:l.acquisition_date,quantity:l.quantity,action:'held-lot',reference:`${h.lotScope.source_id} / ${l.row_ref}`});
    return evidence;
  };
  const sourceEvidence=evidenceFor(symbol),rows=[];
  for(const m of u.members){
    if(m.symbol===symbol)continue;
    const reasons=[],flags=[],omit=[];let score=0,known=0;
    if(excluded.includes(m.symbol))omit.push('Excluded by user.');
    const issuerExclusion=sameReplacementIssuer(source,m);if(issuerExclusion)omit.push(issuerExclusion);
    if(m.currency!==source.currency)omit.push('Different currency.');
    if((source.type==='stock')!==(m.type==='stock'))omit.push('A constituent stock is not equivalent to a diversified fund.');
    for(const [field,points] of [['sector',40],['industry',30],['sizeBand',20]]){
      if(!source[field]||!m[field])flags.push(`${field} comparison is unknown.`);
      else{known+=points;if(source[field]===m[field]){score+=points;reasons.push(`Same ${field}: ${m[field]} (+${points}).`);}else reasons.push(`Different ${field}: ${m[field]} (+0).`);}
    }
    if(held.has(m.symbol))flags.push('Already held in this portfolio; increasing concentration needs review.');else{score+=10;reasons.push('Not currently held in this portfolio (+10).');}known+=10;
    if(source.type!=='stock'&&m.type!=='stock'){
      if(!source.benchmark||!m.benchmark)flags.push('Fund benchmark is unknown.');
      else if(source.benchmark===m.benchmark)flags.push('Same tracked index: explicit substantially-identical review required.');
      else reasons.push(`Different tracked index: ${m.benchmark}; compare exposure separately.`);
    }
    if(source.relatedGroup&&source.relatedGroup===m.relatedGroup)flags.push('Same reviewed related-security group as source; do not assume this avoids a wash sale.');
    if(!source.relatedGroup||!m.relatedGroup)flags.push('Issuer/share-class relationships have not been reviewed.');
    const p=daily?.prices?.[m.symbol],priceUsable=m.currency==='USD'&&daily?.price_date<=date&&p;
    if(!priceUsable)flags.push('No usable saved USD daily price.');
    else if(daily.price_date!==date)flags.push(`Price is a daily close from ${daily.price_date}, not the analysis date.`);
    const evidence=evidenceFor(m.symbol);if(evidence.length)flags.push('Acquisition or other activity evidence needs review; quantities are not netted.');
    if(known===10)flags.push('No exposure-similarity metrics available; only existing-holding status is known.');
    rows.push({symbol:m.symbol,name:m.name,type:m.type,score,knownPoints:known,reasons,flags,excluded:omit,evidence,price:priceUsable?{price:p.price,currency:'USD',date:daily.price_date}:null});
  }
  rows.sort((a,b)=>Boolean(a.excluded.length)-Boolean(b.excluded.length)||b.score-a.score||a.symbol.localeCompare(b.symbol));
  return {source,portfolioId,accountId,date,window,warnings,coverage,sourceEvidence,rows,universe:{name:u.name,benchmark:u.benchmark,source:u.source,provenance:u.provenance,asOf:u.asOf,validThrough:u.validThrough},holdingsRevision:state.revision};
}

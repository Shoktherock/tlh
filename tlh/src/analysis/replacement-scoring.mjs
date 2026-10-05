import {ReviewError} from '../review-error.mjs';
// Scenario scores only: floating point is used for ranking, never ledger amounts.
import {sameReplacementIssuer} from './replacement-identity.mjs';
export const STOCK_WEIGHTS={returns:35,industry:25,size:15,volatility:15,concentration:10};
export const INDEX_WEIGHTS={constituents:50,sectors:30,stockFit:20};
const clamp=n=>Math.max(0,Math.min(1,n));
const positive=n=>Number.isFinite(Number(n))&&Number(n)>0;
const variance=a=>{const mean=a.reduce((s,x)=>s+x,0)/a.length;return a.reduce((s,x)=>s+(x-mean)**2,0)/a.length;};
function correlation(a,b){const ma=a.reduce((s,x)=>s+x,0)/a.length,mb=b.reduce((s,x)=>s+x,0)/b.length,den=Math.sqrt(variance(a)*variance(b));return den?clamp((a.reduce((s,x,i)=>s+(x-ma)*(b[i]-mb),0)/a.length/den+1)/2):null;}
export function returnMetrics(a,b){
  if(!a?.length||!b?.length)return {returns:null,volatility:null,observations:0};
  // Match return intervals, not only their end dates, so missing bars cannot pair
  // a multi-day return with a one-day return.
  const intervals=bars=>new Map((bars??[]).slice(1).map((x,i)=>[`${bars[i].date}/${x.date}`,Math.log(x.close/bars[i].close)]));
  const aa=intervals(a),bb=intervals(b),pairs=[...aa].filter(([k,v])=>bb.has(k)&&Number.isFinite(v)&&Number.isFinite(bb.get(k))).sort(([x],[y])=>x.localeCompare(y));
  if(pairs.length<126)return {returns:null,volatility:null,observations:pairs.length};
  const x=pairs.map(([,v])=>v),y=pairs.map(([k])=>bb.get(k)),long=correlation(x,y),short=correlation(x.slice(-63),y.slice(-63)),va=variance(x),vb=variance(y);
  return {returns:long===null||short===null?null:(long+short)/2,volatility:va>0&&vb>0?Math.exp(-Math.abs(Math.log(Math.sqrt(va/vb)))):null,observations:pairs.length};
}
export function candidatePool(universe,symbol,limit=20){
  const source=universe.members.find(m=>m.symbol===symbol);if(!source)return [];
  return universe.members.filter(m=>m.symbol!==symbol&&m.type===source.type&&m.currency===source.currency&&m.sector===source.sector).sort((a,b)=>{
    const distance=m=>positive(m.benchmarkWeight)&&positive(source.benchmarkWeight)?Math.abs(Math.log(m.benchmarkWeight/source.benchmarkWeight)):Infinity;
    return distance(a)-distance(b)||a.symbol.localeCompare(b.symbol);
  }).slice(0,limit).map(m=>m.symbol);
}
export function scoreReplacements(report,{universe,state,daily,metrics={},mode='stock',amount,poolLimit=20}){
  if(!['stock','index'].includes(mode))throw new ReviewError('Choose stock or index scoring.');
  if(![20,50,150].includes(poolLimit))throw new ReviewError('Choose a supported candidate pool.');
  if(!positive(amount))throw new ReviewError('Enter a positive proposed replacement amount in USD.');
  const trade=Number(amount),source=report.source,members=new Map(universe.members.map(m=>[m.symbol,m])),values=new Map();let omitted=0;
  if(source.type!=='stock')throw new ReviewError('Weighted strategies currently compare individual stocks. Fund comparisons require a separate exposure model.');
  for(const a of state.accounts.filter(a=>a.portfolioId===report.portfolioId))for(const [s,h] of Object.entries(state.holdings[a.id]??{})){
    if(!h.active)continue;const p=daily?.prices?.[s]?.price,q=h.position?.quantity,currency=h.position?.currency??h.confirmedCurrency;
    if(!members.has(s)||members.get(s).type!=='stock'||currency!=='USD'||!positive(p)||!positive(q)||h.position?.currency&&h.confirmedCurrency&&h.position.currency!==h.confirmedCurrency){omitted++;continue;}
    values.set(s,(values.get(s)??0)+Number(p)*Number(q));
  }
  const sourceHolding=state.holdings[report.accountId]?.[source.symbol],sourceValue=Number(sourceHolding?.position?.quantity)*Number(daily?.prices?.[source.symbol]?.price);
  if(!Number.isFinite(sourceValue)||trade>sourceValue)throw new ReviewError('Trade amount exceeds the selected holding value or its saved price is unavailable.');
  const total=[...values.values()].reduce((a,b)=>a+b,0);if(!positive(total))throw new ReviewError('No valued USD stock sleeve available.');
  if(!values.has(source.symbol))throw new ReviewError('Source holding is outside the valued USD stock sleeve.');
  const fraction=trade/total,weights=new Map([...values].map(([s,v])=>[s,v/total])),targetTotal=universe.members.reduce((s,m)=>s+(positive(m.benchmarkWeight)?Number(m.benchmarkWeight):0),0);
  const target=new Map(universe.members.map(m=>[m.symbol,targetTotal?Number(m.benchmarkWeight??0)/targetTotal:0]));
  const sectorWeight=new Map(),sectorTarget=new Map();for(const [s,w] of weights){const sector=members.get(s)?.sector??'Unknown';sectorWeight.set(sector,(sectorWeight.get(sector)??0)+w);}for(const m of universe.members)sectorTarget.set(m.sector??'Unknown',(sectorTarget.get(m.sector??'Unknown')??0)+(target.get(m.symbol)??0));
  if(mode==='index'&&(!targetTotal||universe.members.some(m=>m.type!=='stock'||m.benchmarkWeight==null||!m.sector)))throw new ReviewError('Index scoring requires reviewed stock constituent weights and sectors. Import an updated universe.');
  const excludedSymbols=new Set(report.rows.filter(r=>r.excluded.length).map(r=>r.symbol));
  const pool=new Set(candidatePool({...universe,members:universe.members.filter(m=>!excludedSymbols.has(m.symbol))},source.symbol,poolLimit)),sourceMetric=metrics[source.symbol]??{},baseSector=source.sector??'Unknown';
  const squared=(actual,desired)=>[...new Set([...actual.keys(),...desired.keys()])].reduce((s,k)=>s+((actual.get(k)??0)-(desired.get(k)??0))**2,0);
  const beforeConstituents=squared(weights,target),beforeSectors=squared(sectorWeight,sectorTarget);
  // A swap only changes two weights. Update those terms in the baseline sum
  // instead of copying and rescanning every constituent for every candidate.
  const swapDelta=(actual,desired,from,to)=>from===to?0:2*fraction*((actual.get(to)??0)-(desired.get(to)??0)-(actual.get(from)??0)+(desired.get(from)??0))+2*fraction*fraction;
  const rows=report.rows.map(row=>{
    const m=members.get(row.symbol),metric=metrics[row.symbol]??{},history=returnMetrics(sourceMetric.history?.bars,metric.history?.bars);
    const identityExclusion=sameReplacementIssuer(source,m,sourceMetric.profile,metric.profile);
    if(identityExclusion)row={...row,excluded:[...new Set([...row.excluded,identityExclusion])]};
    const industry=sourceMetric.profile?.industry&&metric.profile?.industry?(sourceMetric.profile.industry===metric.profile.industry?1:0):null;
    const capA=sourceMetric.profile?.marketCap,capB=metric.profile?.marketCap,size=positive(capA)&&positive(capB)?Math.exp(-Math.abs(Math.log(capA/capB))):null;
    // Smaller resulting position earns more concentration points; existing positions
    // are measured continuously, rather than receiving a binary held/not-held penalty.
    const concentration=clamp(1-((values.get(row.symbol)??0)+trade)/total);
    const components={returns:history.returns,industry,size,volatility:history.volatility,concentration};
    const stockScore=Object.entries(STOCK_WEIGHTS).reduce((s,[k,w])=>s+(components[k]??0)*w,0),coverage=Object.entries(STOCK_WEIGHTS).reduce((s,[k,w])=>s+(components[k]===null?0:w),0);
    const afterConstituents=Math.max(0,beforeConstituents+swapDelta(weights,target,source.symbol,row.symbol)),afterSectors=Math.max(0,beforeSectors+swapDelta(sectorWeight,sectorTarget,baseSector,m.sector??'Unknown'));
    // Absolute closeness, not min/max stretching: equal outcomes remain ties.
    const indexComponents={constituents:Math.exp(-5*Math.sqrt(afterConstituents)),sectors:Math.exp(-5*Math.sqrt(afterSectors)),stockFit:stockScore/100};
    const score=mode==='stock'?stockScore:Object.entries(INDEX_WEIGHTS).reduce((s,[k,w])=>s+indexComponents[k]*w,0);
    const inPool=mode==='index'||pool.has(row.symbol),complete=coverage===100;
    const evidenceErrors=[sourceMetric.profile,sourceMetric.history,metric.profile,metric.history].filter(m=>m?.error).map(m=>m.error);
    return {...row,score,knownPoints:mode==='stock'?coverage:80+coverage*.2,components:mode==='stock'?components:indexComponents,stockComponents:components,observations:history.observations,inPool,complete,rankable:inPool&&complete&&!row.excluded.length,scoreStatus:!inPool?'Outside stock comparison pool':complete?'Scored':'Insufficient evidence',indexChange:{constituents:afterConstituents-beforeConstituents,sectors:afterSectors-beforeSectors},reasons:[],flags:[...row.flags.filter(f=>!f.includes('industry comparison')&&!f.includes('sizeBand comparison')),...evidenceErrors]};
  });
  if(mode==='index'){
    pool.clear();rows.filter(r=>!r.excluded.length).sort((a,b)=>a.indexChange.constituents+0.6*a.indexChange.sectors-b.indexChange.constituents-0.6*b.indexChange.sectors||a.symbol.localeCompare(b.symbol)).slice(0,poolLimit).forEach(r=>pool.add(r.symbol));
    for(const r of rows){r.inPool=pool.has(r.symbol);r.rankable=r.inPool&&r.complete&&!r.excluded.length;r.scoreStatus=!r.inPool?'Outside index comparison pool':r.complete?'Scored':'Insufficient evidence';}
  }
  rows.sort((a,b)=>Number(b.rankable)-Number(a.rankable)||Number(b.inPool)-Number(a.inPool)||Boolean(a.excluded.length)-Boolean(b.excluded.length)||b.score-a.score||a.symbol.localeCompare(b.symbol));
  const ranked=rows.filter(r=>r.rankable),cutoff=ranked[4]?.score;
  return {...report,rows,scoring:{version:1,mode,amount:trade,weights:mode==='stock'?STOCK_WEIGHTS:INDEX_WEIGHTS,pool:[...pool],poolLimit,valuedSleeve:total,omittedHoldings:omitted,priceDate:daily?.price_date,ranked:ranked.length,top:ranked.slice(0,5).map(r=>r.symbol),nearCutoff:cutoff!==undefined?ranked.filter(r=>Math.abs(r.score-cutoff)<1).length:0,scope:'Valued, mapped USD stock sleeve; excludes cash, funds and unavailable prices. Index target is normalized supported IWV equity holdings, not official index tracking error.'}};
}

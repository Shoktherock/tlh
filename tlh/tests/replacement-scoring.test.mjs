import {test} from 'node:test';
import assert from 'node:assert/strict';
import {returnMetrics,scoreReplacements} from '../src/analysis/replacement-scoring.mjs';
import {fetchReplacementMetric} from '../server/replacement-market.mjs';
import {sameReplacementIssuer} from '../src/analysis/replacement-identity.mjs';
const bars=Array.from({length:151},(_,i)=>({date:new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10),close:100*Math.exp(i*.001+Math.sin(i)*.01)}));
test('reviewed share classes and normalized issuer IDs exclude symmetrically without ticker guessing',()=>{
  for(const [a,b] of [['GOOG','GOOGL'],['GOOGL','GOOG']])assert.match(sameReplacementIssuer({symbol:a},{symbol:b}),/Same issuer/);
  assert.equal(sameReplacementIssuer({symbol:'A'},{symbol:'AA'}),null);
  assert.match(sameReplacementIssuer({symbol:'A'},{symbol:'B'},{cik:'123'},{cik:'0000000123'}),/CIK/);
  assert.equal(sameReplacementIssuer({symbol:'A'},{symbol:'B'},{cik:null},{cik:null}),null);
});
function fixture(){
  const members=[['A',.5,'Tech'],['B',.1,'Tech'],['C',.4,'Finance']].map(([symbol,benchmarkWeight,sector])=>({symbol,benchmarkWeight,sector,type:'stock',currency:'USD'}));
  const report={source:members[0],portfolioId:'p',accountId:'a',rows:members.slice(1).map(m=>({...m,excluded:[],flags:[],reasons:[]}))};
  const args={universe:{members},state:{accounts:[{id:'a',portfolioId:'p'}],holdings:{a:{A:{active:true,position:{quantity:'100',currency:'USD'}}}}},daily:{price_date:'2026-06-01',prices:{A:{price:'1'},B:{price:'1'},C:{price:'1'}}},metrics:Object.fromEntries(members.map(m=>[m.symbol,{profile:{industry:'1000',marketCap:1000000},history:{bars}}])),amount:'20',poolLimit:20};
  return {report,args};
}
test('return evidence matches intervals, requires sufficient history and handles zero variance',()=>{
  assert.equal(returnMetrics(bars,bars).returns,1);assert.equal(returnMetrics(bars,bars).volatility,1);
  assert.equal(returnMetrics(bars.slice(0,126),bars).returns,null);
  assert.equal(returnMetrics(bars,bars.filter((_,i)=>i%2===0)).observations,0);
  assert.equal(returnMetrics(bars.map(b=>({...b,close:1})),bars).returns,null);
});
test('strategy choice changes the shortlist and uses post-swap index exposures',()=>{
  const {report,args}=fixture(),stock=scoreReplacements(report,args),index=scoreReplacements(report,{...args,mode:'index'});
  assert.deepEqual(stock.scoring.top,['B']);assert.equal(index.scoring.top[0],'C');
  assert.equal(stock.rows.find(r=>r.symbol==='B').score,98);assert(index.rows[0].indexChange.sectors<0);
  assert.equal(args.state.holdings.a.A.position.quantity,'100');assert.equal(index.scoring.valuedSleeve,100);
  // Independent full-sum reference: before = .5² + (-.1)² + (-.4)².
  for(const [symbol,expectedConstituents,expectedSectors] of [['B',-.16,0],['C',-.28,-.24]]){
    const delta=index.rows.find(r=>r.symbol===symbol).indexChange;
    assert(Math.abs(delta.constituents-expectedConstituents)<1e-12);
    assert(Math.abs(delta.sectors-expectedSectors)<1e-12);
  }
});
test('missing data never promotes an incomplete candidate, and invalid trade sizes fail',()=>{
  const {report,args}=fixture();delete args.metrics.B.profile;
  const result=scoreReplacements(report,args);assert.equal(result.scoring.top.length,0);assert.equal(result.rows[0].knownPoints,60);
  assert.throws(()=>scoreReplacements(report,{...args,amount:101}),/exceeds/);
  assert.throws(()=>scoreReplacements(report,{...args,mode:'guess'}),/Choose/);
  args.universe.members[1].benchmarkWeight=null;assert.throws(()=>scoreReplacements(report,{...args,mode:'index'}),/weights/);
});
test('same issuer cannot enter either shortlist even with perfect similarity',()=>{
  const {report,args}=fixture();args.metrics.A.profile.cik='123';args.metrics.B.profile.cik='0000000123';
  for(const mode of ['stock','index']){const r=scoreReplacements(report,{...args,mode});assert(!r.scoring.top.includes('B'));assert.match(r.rows.find(r=>r.symbol==='B').excluded.join(' '),/matching SEC CIK/);}
  assert.equal(report.rows[0].excluded.length,0);
});
test('provider history rejects incomplete pages, wrong identity and unadjusted bars',async()=>{
  const base={status:'OK',ticker:'A',adjusted:true,resultsCount:151,results:bars.map(b=>({t:Date.parse(b.date+'T12:00:00Z'),c:b.close}))};
  const fetchImpl=async()=>({ok:true,text:async()=>JSON.stringify(base)});
  const result=await fetchReplacementMetric('A','2026-06-01','history',{apiKey:'synthetic',fetchImpl});assert.equal(result.bars.length,151);
  base.adjusted=false;await assert.rejects(fetchReplacementMetric('A','2026-06-01','history',{apiKey:'synthetic',fetchImpl}),/invalid/);
  base.adjusted=true;base.next_url='https://example.test';await assert.rejects(fetchReplacementMetric('A','2026-06-01','history',{apiKey:'synthetic',fetchImpl}),/Incomplete/);
});

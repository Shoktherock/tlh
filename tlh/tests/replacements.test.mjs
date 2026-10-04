import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateUniverse,universeTemplate,compareReplacements} from '../src/analysis/replacements.mjs';
const account='a',portfolio='p';
function fixture(){const universe=universeTemplate(),state={revision:1,accounts:[{id:account,portfolioId:portfolio,type:'taxable',label:'test'}],holdings:{[account]:{EXAMPLE:{active:true,position:{security:{symbol:'EXAMPLE'},currency:'USD'},lotScope:{lots:[]}}}}},activity={version:1,events:[]};return {universe,state,portfolioId:portfolio,accountId:account,symbol:'EXAMPLE',date:'2026-09-23',today:'2026-09-23',activity,daily:null};}
test('universe validates unique identities, provenance and dates without filling unknown metrics',()=>{
  assert.equal(validateUniverse(universeTemplate()).members[0].sizeBand,null);
  for(const alter of [u=>u.members.push(u.members[0]),u=>u.provenance='verified',u=>u.asOf='2026-02-30',u=>u.members[0].currency=''] ) {const u=universeTemplate();alter(u);assert.throws(()=>validateUniverse(u));}
});
test('replacement comparisons are deterministic, explain unknown metrics and preserve holdings',()=>{
  const f=fixture(),before=JSON.stringify(f.state),r=compareReplacements(f);assert.equal(r.rows[0].score,80);assert.equal(r.rows[0].knownPoints,80);assert(r.rows[0].flags.some(x=>x.includes('sizeBand')));assert(r.warnings.some(x=>x.includes('Future')));assert.equal(JSON.stringify(f.state),before);
  assert.deepEqual(compareReplacements(f),r);
  f.excluded=['EXAMPLEB'];assert.equal(compareReplacements(f).rows[0].excluded.length,1);
  f.date='2026-10-01';assert.throws(()=>compareReplacements(f),/review date/);
});
test('fund-to-stock comparisons are excluded and same-index funds require explicit review',()=>{
  const f=fixture();f.universe.members[0].type='etf';f.universe.members[0].benchmark='Russell 3000';
  assert(compareReplacements(f).rows[0].excluded.length);
  f.universe.members[1].type='etf';f.universe.members[1].benchmark='Russell 3000';assert(compareReplacements(f).rows[0].flags.some(s=>s.includes('Same tracked index')));
});
test('all listed accounts contribute snapshot evidence including IRAs and unknown dates',()=>{
  const f=fixture();f.state.accounts.push({id:'ira',portfolioId:'other',type:'roth_ira',label:'IRA'});f.state.holdings.ira={EXAMPLEB:{active:true,lotScope:{source_id:'s',lots:[{acquisition_date:null,quantity:'2',row_ref:'lot'}]}}};
  const r=compareReplacements(f);assert.equal(r.rows[0].evidence[0].accountId,'ira');assert.equal(r.rows[0].evidence[0].quantity,'2');
});
test('Alphabet alternate share classes are excluded even with legacy cached profiles',()=>{
  for(const [symbol,other] of [['GOOG','GOOGL'],['GOOGL','GOOG']]){
    const f=fixture();f.universe.members[0].symbol=symbol;f.universe.members[1].symbol=other;f.symbol=symbol;
    f.state.holdings[account][symbol]=f.state.holdings[account].EXAMPLE;delete f.state.holdings[account].EXAMPLE;
    const r=compareReplacements(f);assert.match(r.rows[0].excluded.join(' '),/alternate share class/);
  }
});

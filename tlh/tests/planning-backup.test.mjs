import test from 'node:test';
import assert from 'node:assert/strict';
import {planningEnvelope,inspectPlanning,mapPlanning} from '../src/analysis/planning-backup.mjs';
import {universeTemplate,validateUniverse} from '../src/analysis/replacements.mjs';
import {hashText} from '../src/activity/engine.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function sample(){const source=JSON.stringify(universeTemplate());return {portfolios:[{id:id(1),name:'Test'}],accounts:[{id:id(2),label:'Test account',portfolio_id:id(1),account_type:'taxable'}],universes:[{id:id(3),hash:await hashText(source),source_text:source,document:validateUniverse(JSON.parse(source))}],strategies:[{portfolio_id:id(1),universe_id:id(3),revision:1,exclusions:[]}],drafts:[],events:[],restores:[]};}
test('planning backup round trip and checksums reject changed data and changed source',async()=>{const d=await sample(),b=await planningEnvelope(d);assert.deepEqual(await inspectPlanning(b),d);b.data.portfolios[0].name='changed';await assert.rejects(inspectPlanning(b),/checksum/);d.universes[0].source_text+=' ';await assert.rejects(inspectPlanning(await planningEnvelope(d)),/source checksum/);});
test('planning restore mapping rejects account type and portfolio mismatch',async()=>{const d=await sample(),mapping={portfolios:{[id(1)]:id(4)},accounts:{[id(2)]:id(5)}},targets={portfolios:[{id:id(4)}],accounts:[{id:id(5),portfolio_id:id(4),account_type:'taxable'}]};assert.deepEqual(mapPlanning(d,mapping,targets),mapping);targets.accounts[0].account_type='roth_ira';assert.throws(()=>mapPlanning(d,mapping,targets),/same type/);assert.throws(()=>mapPlanning(d,{portfolios:{},accounts:{}},targets),/distinct/);});

test('legacy universe documents with omitted optional fields remain restorable',async()=>{const d=await sample();for(const m of d.universes[0].document.members)delete m.benchmarkWeight;await inspectPlanning(await planningEnvelope(d));d.universes[0].document.members[0].sector='Changed';await assert.rejects(inspectPlanning(await planningEnvelope(d)),/differs/);});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyBatch} from '../src/import/upload-routing.mjs';
import {sampleFiles} from '../src/sample.mjs';
import {csv} from './fixtures/schwab-activity.mjs';
import {realizedFixture} from './local/realized-fixture.mjs';
test('upload routing validates content and keeps report families separate',async()=>{
 assert.equal(await classifyBatch(sampleFiles()),'holdings');
 assert.equal(await classifyBatch([{name:'anything.csv',text:csv}]),'activity');
 assert.equal(await classifyBatch([{name:'anything.csv',text:realizedFixture()}]),'realized');
 await assert.rejects(classifyBatch([{name:'Transactions.csv',text:'not a supported export'}]));
 await assert.rejects(classifyBatch([{name:'a.csv',text:csv},{name:'b.csv',text:realizedFixture()}]),/Nothing was staged/);
 await assert.rejects(classifyBatch([{name:'a.csv',text:csv},{name:'b.csv',text:csv}]),/one file at a time/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readJsonLimited,enforceRequestQuota,errorReply} from '../../supabase/functions/_common/request.mjs';
import {databaseError} from '../server/database-error.mjs';
import {ReviewError} from '../src/review-error.mjs';
test('bounded reader counts bytes, cancels streams, rejects claimed lengths and malformed JSON',async()=>{
 let cancelled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(9));c.enqueue(new Uint8Array(9));},cancel(){cancelled=true;}});
 await assert.rejects(readJsonLimited(new Request('https://test',{method:'POST',body:stream,duplex:'half'}),10),e=>e.status===413);assert.ok(cancelled);
 await assert.rejects(readJsonLimited(new Request('https://test',{method:'POST',headers:{'content-length':'999'},body:'{}'}),10),e=>e.status===413);
 await assert.rejects(readJsonLimited(new Request('https://test',{method:'POST',body:'{"a":"éé"}'}),10),e=>e.status===413);
 await assert.rejects(readJsonLimited(new Request('https://test',{method:'POST',body:'PRIVATE_INVALID_DATA'}),99),e=>e.status===400&&!e.message.includes('PRIVATE'));
 assert.deepEqual(await readJsonLimited(new Request('https://test',{method:'POST',body:'{}'}),2),{});
});
test('quota fails closed and masks failures',async()=>{
 await assert.rejects(enforceRequestQuota({rpc:async()=>({error:{message:'SECRET'}})},'x'),e=>e.status===503&&!e.message.includes('SECRET'));
 await assert.rejects(enforceRequestQuota({rpc:async()=>({data:false})},'x'),e=>e.status===429);
});
test('only reviewed validation messages are exposed',()=>{
 for(const error of [new Error('PRIVATE row data'),new TypeError('PRIVATE token'),{message:'PRIVATE'}])assert.ok(!errorReply(error).message.includes('PRIVATE'));
 assert.equal(errorReply(new ReviewError('Review first')).message,'Review first');
 assert.ok(!databaseError({code:'23505',message:'PRIVATE row data'}).message.includes('PRIVATE'));
 assert.equal(databaseError({code:'P0001',message:'Reports changed. Preview again.'}).message,'Reports changed. Preview again.');
 assert.ok(!databaseError({code:'P0001',message:'PRIVATE'}).message.includes('PRIVATE'));
});

test('early responses consume finite unread bodies without changing the response',async()=>{
 const {finishRequest}=await import('../../supabase/functions/_common/request.mjs');let bytes=0;
 const body=new ReadableStream({pull(c){if(bytes===1048577){c.close();return;}const n=Math.min(8192,1048577-bytes);bytes+=n;c.enqueue(new Uint8Array(n));}});
 const req=new Request('https://test',{method:'POST',body,duplex:'half'}),response=new Response('denied',{status:401});
 assert.equal(await finishRequest(req,response),response);assert.equal(bytes,1048577);assert.equal(await response.text(),'denied');
});
test('cleanup bounds bytes and does not await a stalled cancellation',async()=>{
 const {finishRequest}=await import('../../supabase/functions/_common/request.mjs');let pulls=0,cancelled=false;
 const body=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(8));},cancel(){cancelled=true;return new Promise(()=>{});}});
 const req=new Request('https://test',{method:'POST',body,duplex:'half'});
 await finishRequest(req,new Response(),{maxDiscard:16,timeoutMs:50});assert.ok(pulls<=5);assert.ok(cancelled);
});
test('cleanup deadline also bounds a stalled body read',async()=>{
 const {finishRequest}=await import('../../supabase/functions/_common/request.mjs');let cancelled=false;
 const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
 const req=new Request('https://test',{method:'POST',body,duplex:'half'});const started=Date.now();
 await finishRequest(req,new Response(),{timeoutMs:20});assert.ok(Date.now()-started<1000);assert.ok(cancelled);
});

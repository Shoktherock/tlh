import {syntheticLotsCsv} from '../../../browser-helper/tests/fixtures/schwab-lots.synthetic.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { supabaseStore } from '../../src/import/supabase-store.ts';
import { assemble, readSource } from '../../src/import/sources.mjs';
import { sampleFiles } from '../../src/sample.mjs';

test('overlapping lots name both files and fail before reservation or upload; removing overlap allows preview', async () => {
  const files = await Promise.all(sampleFiles().map(readSource));
  const text = (syntheticLotsCsv).replace('DEMO Lot Details', 'EXAMPLE Lot Details');
  const lots = await readSource({name:'Lot-Details.csv',text});
  const calls = [];
  const client = {
    functions: {invoke: async (_name, {body}) => {
      calls.push(body.action);
      return {data:body.action === 'reserve' ? {sources:body.files.map((_,i)=>({id:String(i),path:`source/${i}`}))} : {preview:{preparedId:'prepared'}},error:null};
    }},
    storage: {from: () => ({download:async()=>({error:new Error('Missing')}),upload:async () => {calls.push('upload');return {error:null};}})},
  };
  const store = supabaseStore(client);
  const options = {sourceAccountRef:'synthetic-account'};
  for (const staged of [[...files,lots],[lots,...files]]) {
    await expect(store.buildPreview({},staged,options)).rejects.toThrow(`EXAMPLE: lot details overlap between "${files[0].name}" and "Lot-Details.csv"`);
    expect(calls).toEqual([]);
  }
  const another = await readSource({name:'other-lots.csv',text:text.replace('09/06/2026','09/07/2026')});
  expect(()=>assemble([lots,another],null)).toThrow('"Lot-Details.csv" and "other-lots.csv"');
  expect(assemble([files[1],lots],null).scopes).toHaveLength(1);
  expect(await store.buildPreview({},files,options)).toEqual({preparedId:'prepared'});
  expect(calls).toEqual(['reserve','upload','upload','prepare']);
});

test('upload retry reuses valid bytes, isolates damaged objects, and verifies an ambiguous upload response',async()=>{
  const sources=await Promise.all(sampleFiles().map(readSource));
  for(const mode of ['valid','damaged','lost-response']){
    const calls=[];const objects=new Map();
    if(mode!=='lost-response')objects.set('old',new Blob([mode==='valid'?sources[0].text:'damaged']));
    const client={functions:{invoke:async(_,{body})=>{
      calls.push(body.action);
      if(body.action==='reserve')return {data:{sources:[{id:body.reuse?'old':'fresh',path:body.reuse?'old':'fresh'}]}};
      return {data:{preview:{preparedId:'prepared'}}};
    }},storage:{from:()=>({download:async path=>objects.has(path)?{data:objects.get(path)}:{error:new Error('Missing')},upload:async(path,blob)=>{calls.push(`upload:${path}`);objects.set(path,blob);return mode==='lost-response'?{error:new Error('Response lost')}:{error:null};}})}};
    const result=await supabaseStore(client).buildPreview({},[sources[0]],{sourceAccountRef:'synthetic-account'});
    expect(result.preparedId).toBe('prepared');
    expect(calls).toEqual(mode==='valid'?['reserve','prepare']:mode==='damaged'?['reserve','reserve','upload:fresh','prepare']:['reserve','upload:old','prepare']);
    if(mode==='damaged')expect(await objects.get('old').text()).toBe('damaged');
  }
});

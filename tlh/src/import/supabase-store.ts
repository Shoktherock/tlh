import type { SupabaseClient } from '@supabase/supabase-js';
import { assemble, decodeSourceBytes, hash } from './sources.mjs';
import { exportBackup } from './recovery.mjs';

export function supabaseStore(client:SupabaseClient) {
  async function invoke(body:any){
    const {data,error}=await client.functions.invoke('imports',{body});
    if(error){
      let message='Could not reach the import service. Nothing was confirmed; retry to check the result.';
      try {const result=await error.context.json();if(typeof result.error==='string')message=result.error;}catch{}
      throw new Error(message);
    }
    return data;
  }
  async function original(source:any){
    const {data,error}=await client.storage.from('import-sources').download(source.path);
    if(error)throw new Error('Original source could not be loaded.');
    const text=decodeSourceBytes(await data.arrayBuffer());
    if(!source.backupSourceId)return text;
    const backup=JSON.parse(text);const saved=backup.format==='tlh-portfolio-backup'?backup.state:backup;
    const file=saved.imports.flatMap(b=>b.sources).find(s=>s.id===source.backupSourceId);
    if(!file || await hash(file.text)!==source.id)throw new Error('Backup original source checksum does not match.');
    return file.text;
  }
  async function uploadSources(sources:any[]){
    const {sources:uploads}=await invoke({action:'reserve',reuse:true,files:sources.map(s=>({name:s.name,hash:s.id,bytes:new TextEncoder().encode(s.text).length}))});
    for(let i=0;i<sources.length;i++){
      const bucket=client.storage.from('import-sources');
      const inspect=async()=>{
        const {data,error}=await bucket.download(uploads[i].path);
        if(error)return {exists:false,matches:false};
        try{return {exists:true,matches:data.size===new TextEncoder().encode(sources[i].text).length && await hash(decodeSourceBytes(await data.arrayBuffer()))===sources[i].id};}
        catch{return {exists:true,matches:false};}
      };
      const saved=await inspect();
      if(saved.matches)continue;
      if(saved.exists){
        // Never overwrite an object, even a damaged staged upload. Reserve a clean
        // path and leave the failed object available for explicit staged cleanup.
        const fresh=await invoke({action:'reserve',files:[{name:sources[i].name,hash:sources[i].id,bytes:new TextEncoder().encode(sources[i].text).length}]});
        uploads[i]=fresh.sources[0];
      }
      const {error}=await bucket.upload(uploads[i].path,new Blob([sources[i].text],{type:'application/octet-stream'}),{upsert:false,contentType:'application/octet-stream'});
      if(error && !(await inspect()).matches)throw new Error('Upload interrupted. Reselect the same files and retry to reuse completed uploads. Open Recovery to resume a saved preview or discard abandoned uploads.');
    }
    return uploads;
  }
  return {
    async replacements(body:any){
      const {data,error}=await client.functions.invoke('replacements',{body});
      if(error){let message='Replacement service is unavailable. Reload and retry.';try{const result=await error.context.json();if(typeof result.error==='string')message=result.error;}catch{}throw new Error(message);}
      return data;
    },
    async activity(body:any){
      const {data,error}=await client.functions.invoke('activity',{body});
      if(error){let message='Activity service is unavailable. Reload to check the saved state.';try{const result=await error.context.json();if(typeof result.error==='string')message=result.error;}catch{}throw new Error(message);}
      return data;
    },
    async analysis(body:any){
      const {data,error}=await client.functions.invoke('analysis-inputs',{body});
      if(error){let message='Could not reach analysis inputs. Reload to check whether a save completed.';try{const result=await error.context.json();if(typeof result.error==='string')message=result.error;}catch{}throw new Error(message);}
      return data;
    },
    async quotes(body:any){
      const {data,error}=await client.functions.invoke('get-quotes',{body});
      if(error){let message='Could not reach the quote service. Existing prices are retained.';try{const result=await error.context.json();if(typeof result.error==='string')message=result.error;}catch{}throw new Error(message);}
      return data;
    },
    async readState(){return (await invoke({action:'read'})).state;},
    async prepareCorrection(request:any){return (await invoke({action:'prepare-correction',request})).preview;},
    async acceptCorrection(preparedId:string,reviewed:boolean){return invoke({action:'accept-correction',preparedId,reviewed});},
    async buildPreview(_state:any,sources:any[],options:any){
      // Catch incompatible file combinations before reserving or uploading originals.
      // The server still reparses and validates the uploaded files independently.
      assemble(sources,options.sourceAccountRef);
      const uploads=await uploadSources(sources);
      return (await invoke({action:'prepare',sourceIds:uploads.map(s=>s.id),options})).preview;
    },
    async commitImport(preview:any,decision:any){return invoke({action:'accept',preparedId:preview.preparedId,decision});},
    readSource:original,
    async exportBackup(){return exportBackup((await invoke({action:'read'})).state,original);},
    async prepareRestore(text:string,mapping:any){
      const uploads=await uploadSources([{name:'tlh-portfolio-backup.json',id:await hash(text),text}]);
      return invoke({action:'prepare-restore',sourceId:uploads[0].id,mapping});
    },
    async acceptRestore(preparedId:string,reviewed:boolean){return invoke({action:'accept-restore',preparedId,reviewed});},
    async recovery(){return invoke({action:'recovery'});},
    async resume(preparedId:string,kind='import'){return (await invoke({action:'resume',preparedId,kind})).preview;},
    async discard(){return invoke({action:'discard'});},
  };
}

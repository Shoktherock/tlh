export class RequestError extends Error { constructor(message,status){super(message);this.status=status;} }
export async function readJsonLimited(request,limit){
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw new RequestError('Request is too large.',413);
 const reader=request.body?.getReader();let size=0;const chunks=[];
 if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await discardReader(reader);throw new RequestError('Request is too large.',413);}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!body||typeof body!=='object'||Array.isArray(body))throw Error();return body;}catch{throw new RequestError('Send a valid JSON object.',400);}
}
export async function enforceRequestQuota(db,user){
 const {data,error}=await db.rpc('consume_api_quota',{p_user:user});
 if(error)throw new RequestError('Service temporarily unavailable. Please retry.',503);
 if(!data)throw new RequestError('Request limit reached. Wait one minute and retry.',429);
}
export function errorReply(error){
 if(error instanceof RequestError)return {status:error.status,message:error.message};
 // Only explicitly marked review guidance crosses the boundary; runtime errors stay private.
 if(error instanceof Error && error.name==='ReviewError')return {status:400,message:error.message};
 return {status:500,message:'Request failed. Reload to check the result before retrying.'};
}

// Supabase's forwarding layer can stall early responses while unread bytes remain.
// Discard only a bounded amount, never buffer it, and never wait indefinitely on cancellation.
async function discardReader(reader,{maxDiscard=12*1024*1024,timeoutMs=2000}={}){
 let discarded=0,timer;
 const expired=new Promise(resolve=>{timer=setTimeout(()=>resolve({expired:true}),timeoutMs);});
 try{
  for(;;){
   const part=await Promise.race([reader.read(),expired]);
   if(part.expired)break;
   if(part.done)return;
   discarded+=part.value.byteLength;if(discarded>maxDiscard)break;
  }
 }catch{/* Do not log submitted content or transport errors. */}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export async function finishRequest(request,response,options){
 if(!request.body||request.body.locked)return response;
 const reader=request.body.getReader();
 try{await discardReader(reader,options);}finally{reader.releaseLock();}
 return response;
}

import {readJsonLimited,enforceRequestQuota,errorReply,finishRequest} from '../_common/request.mjs';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { importService } from '../_shared/import-service.mjs';

async function handle(req:Request){
  const headers={'Access-Control-Allow-Origin':Deno.env.get('APP_ORIGIN') || 'http://127.0.0.1:4180','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
  if(req.method==='OPTIONS')return new Response('ok',{headers});
  if(req.method!=='POST')return new Response(JSON.stringify({error:'Use POST.'}),{status:405,headers});
  const url=Deno.env.get('SUPABASE_URL')!;
  const client=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  const token=req.headers.get('Authorization')?.replace(/^Bearer /i,'');
  if(!token)return new Response(JSON.stringify({error:'Sign in to continue.'}),{status:401,headers});
  try{
  const {data,error}=await client.auth.getUser(token);
  if(error || !data.user)return new Response(JSON.stringify({error:'Sign in again to continue.'}),{status:401,headers});
    const db=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    await enforceRequestQuota(db,data.user.id);
    const body=await readJsonLimited(req,1048576);
    // Token identity was verified by getUser above; bind confirmation to this session's password proof.
    const claims=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    const passwordVerifiedAt=Math.max(0,...(Array.isArray(claims.amr)?claims.amr:[]).filter((item:any)=>item.method==='password'&&Number.isFinite(item.timestamp)).map((item:any)=>item.timestamp*1000));
    const result=await importService(db,data.user.id,body,{lastSignIn:data.user.last_sign_in_at,passwordVerifiedAt});
    return new Response(JSON.stringify(result),{headers});
  }catch(error){
    const failure=errorReply(error);
    return new Response(JSON.stringify({error:failure.message}),{status:failure.status,headers:{...headers,...(failure.status===429?{'Retry-After':'60'}:{})}});
  }
}
Deno.serve(async(req:Request)=>finishRequest(req,await handle(req)));

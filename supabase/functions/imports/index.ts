import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { importService } from '../_shared/import-service.mjs';

Deno.serve(async(req:Request)=>{
  const headers={'Access-Control-Allow-Origin':'http://127.0.0.1:4180','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
  if(req.method==='OPTIONS')return new Response('ok',{headers});
  if(req.method!=='POST')return new Response(JSON.stringify({error:'Use POST.'}),{status:405,headers});
  const url=Deno.env.get('SUPABASE_URL')!;
  const client=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  const token=req.headers.get('Authorization')?.replace(/^Bearer /i,'');
  if(!token)return new Response(JSON.stringify({error:'Sign in to continue.'}),{status:401,headers});
  const {data,error}=await client.auth.getUser(token);
  if(error || !data.user)return new Response(JSON.stringify({error:'Sign in again to continue.'}),{status:401,headers});
  try{
    const text=await req.text();if(text.length>1048576)throw new Error('Import request is too large.');
    const db=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    const result=await importService(db,data.user.id,JSON.parse(text));
    return new Response(JSON.stringify(result),{headers});
  }catch(error){
    // Do not log request bodies, source contents, tokens or account data.
    const message=error instanceof Error ? error.message : 'Import failed. No acceptance was confirmed.';
    return new Response(JSON.stringify({error:message}),{status:400,headers});
  }
});

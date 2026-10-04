import {createClient} from 'npm:@supabase/supabase-js@2.116.0';
import {replacementService} from '../_shared/replacement-service.mjs';

Deno.serve(async(req:Request)=>{
  const headers={'Access-Control-Allow-Origin':'http://127.0.0.1:4180','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(req.method==='OPTIONS')return new Response('ok',{headers});
  if(req.method!=='POST')return reply({error:'Use POST.'},405);
  const url=Deno.env.get('SUPABASE_URL')!;
  const client=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  const token=req.headers.get('Authorization')?.replace(/^Bearer /i,'');
  if(!token)return reply({error:'Sign in to continue.'},401);
  const {data,error}=await client.auth.getUser(token);
  if(error||!data.user)return reply({error:'Sign in again to continue.'},401);
  try{
    const text=await req.text();if(new TextEncoder().encode(text).length>11000000)return reply({error:'Replacement request is too large.'},400);
    const db=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    return reply(await replacementService(db,data.user.id,JSON.parse(text),{apiKey:Deno.env.get('MASSIVE_API_KEY')}));
  }catch(error){
    return reply({error:error instanceof Error?error.message:'Replacement request failed.'},400);
  }
});

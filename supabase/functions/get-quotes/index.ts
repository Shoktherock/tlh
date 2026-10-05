import {readJsonLimited,enforceRequestQuota,errorReply} from '../_common/request.mjs';
import {createClient} from 'npm:@supabase/supabase-js@2.116.0';
import {quoteRepository,quoteService} from '../_shared/quote-service.mjs';

Deno.serve(async(req:Request)=>{
  const headers={'Access-Control-Allow-Origin':Deno.env.get('APP_ORIGIN') || 'http://127.0.0.1:4180','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(req.method==='OPTIONS')return new Response('ok',{headers});
  if(req.method!=='POST')return reply({error:'Use POST.'},405);
  const url=Deno.env.get('SUPABASE_URL')!;
  const client=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  const token=req.headers.get('Authorization')?.replace(/^Bearer /i,'');
  if(!token)return reply({error:'Sign in to continue.'},401);
  try{
  const {data,error}=await client.auth.getUser(token);
  if(error||!data.user)return reply({error:'Sign in again to continue.'},401);
    const db=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    await enforceRequestQuota(db,data.user.id);
    const body=await readJsonLimited(req,16384);
    return reply(await quoteService(quoteRepository(db),data.user.id,body,{apiKey:Deno.env.get('TWELVE_DATA_API_KEY'),massiveApiKey:Deno.env.get('MASSIVE_API_KEY'),defaultProvider:'massive'}));
  }catch(error){
    const failure=errorReply(error);
    return new Response(JSON.stringify({error:failure.message}),{status:failure.status,headers:{...headers,...(failure.status===429?{'Retry-After':'60'}:{})}});
  }
});


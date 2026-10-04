import {parseIwv,IWV_URL} from './iwv-source.mjs';
import {hashText} from '../src/activity/engine.mjs';
const value=async p=>{const r=await p;if(r.error)throw Error(r.error.message);return r.data;};
export function validateIwvUpdate(next,old,today){
 if(next.asOf>today||next.validThrough<today)throw Error('Publisher holdings are future-dated or older than seven days. Previous benchmark retained.');
 if(next.members.length<2000||next.members.length>3500||next.members.some(m=>!m.sector))throw Error('Unusual constituent count or missing sectors; review required.');
 if(old.asOf>next.asOf)throw Error('Publisher snapshot predates the saved benchmark; review required.');
 const before=new Map(old.members.map(m=>[m.symbol,m.benchmarkWeight??0])),after=new Map(next.members.map(m=>[m.symbol,m.benchmarkWeight??0]));
 const union=new Set([...before.keys(),...after.keys()]),changed=[...union].filter(s=>!before.has(s)||!after.has(s)).length,weightChange=[...union].reduce((sum,s)=>sum+Math.abs((before.get(s)??0)-(after.get(s)??0)),0);
 if(changed/Math.max(1,before.size)>.1||weightChange>.2)throw Error('Unusual membership or weight changes; manual review required. Previous benchmark retained.');
 if(next.asOf===old.asOf&&JSON.stringify(next.members)!==JSON.stringify(old.members))throw Error('Publisher revised an existing snapshot date; manual review required.');
}
export async function refreshIwv(db,{fetchImpl=fetch,now=new Date()}={}){
 const strategies=await value(db.from('replacement_strategies').select('*')),states=await value(db.from('iwv_refresh_status').select('*'));
 const due=strategies.filter(s=>{const st=states.find(x=>x.portfolio_id===s.portfolio_id);return !st||Date.parse(st.next_check_at)<=+now;});
 if(!due.length)return {updated:0};
 const universes=await value(db.from('replacement_universes').select('id,document').in('id',[...new Set(due.map(s=>s.universe_id))]));
 const eligible=due.filter(s=>{const u=universes.find(u=>u.id===s.universe_id)?.document;return u?.provenance==='fund-proxy'&&u.benchmark==='Russell 3000'&&u.source.includes(IWV_URL);});
 if(!eligible.length)return {updated:0};
 let next,error;
 try{const response=await fetchImpl(IWV_URL,{signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok)throw Error('Official holdings download failed. Previous benchmark retained.');const reader=response.body.getReader();let size=0,chunks=[];for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1500000){await reader.cancel();throw Error('Official holdings file exceeds supported size.');}chunks.push(r.value);}const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}next=await parseIwv(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(e){error=e.message;}
 let updated=0;
 for(const s of eligible){let status='current',message='',snapshot=universes.find(u=>u.id===s.universe_id).document.asOf;
 try{
  if(error)throw Error(error);const old=universes.find(u=>u.id===s.universe_id).document;validateIwvUpdate(next,old,now.toISOString().slice(0,10));
  if(next.asOf!==old.asOf){const text=JSON.stringify(next);if(new TextEncoder().encode(text).length>2097152)throw Error('Universe exceeds evidence storage limit.');const hash=await hashText(text);
   let u=await value(db.from('replacement_universes').select('id').eq('user_id',s.user_id).eq('hash',hash).maybeSingle());
   if(!u){const insert=await db.from('replacement_universes').insert({user_id:s.user_id,hash,name:next.name,benchmark:next.benchmark,provenance:next.provenance,as_of:next.asOf,valid_through:next.validThrough,member_count:next.members.length,source_name:'automatic-iwv-holdings.json',source_text:text,document:next}).select('id').single();if(insert.error?.code==='23505')u=await value(db.from('replacement_universes').select('id').eq('user_id',s.user_id).eq('hash',hash).single());else if(insert.error)throw Error(insert.error.message);else u=insert.data;}
   await value(db.rpc('save_replacement_strategy',{p_user:s.user_id,p_portfolio:s.portfolio_id,p_universe:u.id,p_revision:s.revision,p_exclusions:s.exclusions}));updated++;status='updated';snapshot=next.asOf;
  }
  message=`IWV benchmark current through source snapshot ${snapshot}. Automatic check runs daily while the local worker is running.`;
 }catch(e){status='review-needed';message=e.message;}
 await value(db.from('iwv_refresh_status').upsert({portfolio_id:s.portfolio_id,user_id:s.user_id,checked_at:now.toISOString(),next_check_at:new Date(+now+(status==='review-needed'?3600000:86400000)).toISOString(),status,message,snapshot_date:snapshot}));
 }
 return {updated,checked:eligible.length};
}

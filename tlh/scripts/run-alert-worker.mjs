import {refreshIwv} from '../server/iwv-refresh.mjs';
import {createClient} from '@supabase/supabase-js';
import {execFileSync} from 'node:child_process';
import {runScheduledAlert} from '../server/alert-worker.mjs';
const status=JSON.parse(execFileSync(process.platform==='win32'?'supabase.exe':'supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
if(status.API_URL!=='http://127.0.0.1:55321')throw Error('Expected the tlh2 local Supabase stack.');
const db=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(60000)})}});
console.log('Local daily alert worker started. Only opted-in users are checked; no email or quote requests.');
let stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
do{
 try{await refreshIwv(db);}catch{console.error('IWV refresh poll failed; previous benchmarks retained.');}
 try{const beat=async()=>{const r=await db.rpc('alert_worker_heartbeat');if(r.error)throw Error('Heartbeat failed');};await beat();let count=0;while(!stopping&&count++<100&&await runScheduledAlert(db)){await beat();}} catch{console.error('Alert worker could not complete its poll; retrying in one minute.');}
 if(process.argv.includes('--once')||stopping)break;
 await new Promise(resolve=>setTimeout(resolve,60000));
}while(!stopping);

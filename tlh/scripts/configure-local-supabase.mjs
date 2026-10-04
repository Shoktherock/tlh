import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { accountConfig } from '../src/accounts/config.mjs';

export function localSupabase() {
  let status;
  try {
    status=JSON.parse(execFileSync(process.platform==='win32' ? 'supabase.exe' : 'supabase', ['status','-o','json'],
      {cwd:new URL('../../',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  } catch { throw new Error('Start this project’s local Supabase stack before configuring the app.'); }
  if (status.API_URL !== 'http://127.0.0.1:55321') throw new Error('Expected the tlh2 local API on 127.0.0.1:55321. No configuration was changed.');
  return accountConfig(status.API_URL, status.PUBLISHABLE_KEY || status.ANON_KEY);
}

if (process.argv.includes('--write')) {
  const config=localSupabase();
  const target=new URL('../.env.local',import.meta.url);
  let existing='';try{existing=await readFile(target,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  const urlLine=existing.match(/^VITE_SUPABASE_URL=(.*)$/m)?.[1]?.trim();
  if(urlLine && urlLine!==config.url)throw new Error('An existing project URL is configured. Review it before switching environments.');
  const remaining=existing.split(/\r?\n/).filter(line=>!/^VITE_SUPABASE_(URL|PUBLISHABLE_KEY)=/.test(line)).join('\n').trim();
  await writeFile(target,`${remaining ? remaining+'\n' : ''}VITE_SUPABASE_URL=${config.url}\nVITE_SUPABASE_PUBLISHABLE_KEY=${config.key}\n`);
  console.log('Configured the local API and public key in tlh/.env.local. Rebuild the app to apply.');
}

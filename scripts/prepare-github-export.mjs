import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),dest=path.join(root,'github-export');
const exact=new Set(['package.json','package-lock.json','tlh/index.html','tlh/tsconfig.json','tlh/vite.config.ts','supabase/config.toml','browser-helper/manifest.json','browser-helper/snapshot.schema.json']);
const directories=['tlh/src/','tlh/server/','tlh/scripts/','tlh/tests/','browser-helper/src/','browser-helper/scripts/','browser-helper/tests/','browser-helper/demo/','supabase/migrations/','supabase/functions/','scripts/'];
const ext=new Set(['.mjs','.ts','.tsx','.js','.css','.html','.sql']);
const denied=/(^|\/)(node_modules|dist|generated|_shared|\.git|\.temp|\.branches)(\/|$)|\.(csv|tsv|log|png|jpg|pdf|db|zip)$/i;
const sensitive=/Living[ _]Trust|\bLT1\b|67,362\.62|67362\.62|19,336\.24|19336\.24|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const files=[];
async function walk(dir=''){
 for(const ent of await fs.readdir(path.join(root,dir),{withFileTypes:true})){
  const rel=(dir?dir+'/':'')+ent.name;if(ent.isSymbolicLink())continue;
  if(denied.test(rel)||['github-export','Export-CSV','test-results','output','tmp','.codex','.agents','.git'].includes(rel))continue;
  if(ent.isDirectory()){if(['tlh','browser-helper','supabase','scripts'].some(p=>rel===p||rel.startsWith(p+'/')))await walk(rel);continue;}
  if(exact.has(rel)||directories.some(p=>rel.startsWith(p))&&ext.has(path.extname(rel))||/^(tlh|browser-helper)\/playwright[^/]*\.mjs$/.test(rel)){
   const bytes=await fs.readFile(path.join(root,rel));if(sensitive.test(bytes.toString('utf8')))throw Error('Private content detected in '+rel);
   files.push({rel,bytes});
  }
 }
}
await walk();
// Never overlay an old export: stale files must not sneak into a later publication.
try{await fs.mkdir(dest);}catch{throw Error('github-export already exists. Review or move it before producing a new clean export.');}
for(const {rel,bytes} of files){await fs.mkdir(path.dirname(path.join(dest,rel)),{recursive:true});await fs.writeFile(path.join(dest,rel),bytes);}
await fs.writeFile(path.join(dest,'.gitignore'),'node_modules/\ndist/\n.env*\n*.csv\n*.tsv\n*.CSV\n*.TSV\n*.log\ntest-results/\nplaywright-report/\nsupabase/.temp/\nsupabase/.branches/\nsupabase/functions/_shared/\nbrowser-helper/generated/\ngithub-export/\n');
await fs.writeFile(path.join(dest,'README.md'),'# TLH\n\nSource-only development export. No production readiness claim.\n\nRun `npm ci`, `npm run test:tlh`, `npm test`, `npm run build:tlh`, and `npm run build:imports`. Local integration tests require Docker and Supabase CLI. Configure local credentials with `npm run supabase:configure`; never commit generated environment files.\n\nFinancial exports, credentials, databases, runtime artifacts, private notes, and the original Git history are excluded. Test fixtures are synthetic source-code literals. Never add real brokerage files to this repository.\n');
await fs.writeFile(path.join(dest,'SOURCE-MANIFEST.json'),JSON.stringify(files.map(({rel,bytes})=>({path:rel,sha256:createHash('sha256').update(bytes).digest('hex')})),null,2));
console.log(`Prepared ${files.length} allowlisted source files in github-export. No Git initialization or upload performed.`);

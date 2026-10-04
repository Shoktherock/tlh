import {execFileSync} from 'node:child_process';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=/(^|\/)(\.env[^/]*|test-results|playwright-report|Export-CSV|output|tmp|node_modules|dist|\.temp|\.branches)(\/|$)|\.(csv|tsv|xlsx?|db|sqlite\w*|dump|bak|log|png|jpe?g|webp|pdf|zip)$/i;
const secret=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{30,})|(?:eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;
for(const file of files){
 if(forbidden.test(file))throw Error('Forbidden publication path: '+file);
 const content=execFileSync('git',['show',':'+file],{encoding:'utf8',maxBuffer:5000000});
 if(secret.test(content))throw Error('Possible credential in: '+file);
}
console.log(`Publication guard passed for ${files.length} tracked files. Automated checks supplement source review; never add real financial data.`);

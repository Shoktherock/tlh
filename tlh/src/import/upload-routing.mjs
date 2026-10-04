import {readSource} from './sources.mjs';
import {inspectSchwabActivity} from '../activity/schwab.mjs';
import {parseRealized} from '../realized/engine.mjs';
// Identify by validated content, never by the filename or inferred account.
export async function classifyUpload(file){
 const text=file.text.replace(/^\uFEFF/,'');
 if(text.replace(/^"/,'').startsWith('Realized Gain/Loss')){parseRealized(file.text);return 'realized';}
 if(/^"?Date"?,"?Action"?,/.test(text)){inspectSchwabActivity(file.text);return 'activity';}
 await readSource(file);return 'holdings';
}
export async function classifyBatch(files){
 if(!files.length)throw Error('Choose at least one file.');
 const kinds=await Promise.all(files.map(classifyUpload));
 if(new Set(kinds).size!==1||kinds[0]!=='holdings'&&files.length!==1)throw Error('Review transactions and realized reports one file at a time. Positions and lot files can be uploaded together. Nothing was staged.');
 return kinds[0];
}

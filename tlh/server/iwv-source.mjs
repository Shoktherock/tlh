import {ReviewError} from '../src/review-error.mjs';
import {csvRows} from '../src/import/csv.mjs';
import {hashText} from '../src/activity/engine.mjs';
import {validateUniverse} from '../src/analysis/replacements.mjs';
export const IWV_URL='https://www.blackrock.com/us/individual/products/239714/ishares-russell-3000-etf/latest-holdings.csv';
export async function parseIwv(text){
if(new TextEncoder().encode(text).length>1500000)throw new ReviewError('IWV file too large.');
const rows=csvRows(text),header=rows.findIndex(r=>r[0]==='Ticker');
if(header<0||rows[0][0]!=='iShares Russell 3000 ETF')throw new ReviewError('Unexpected IWV file.');
const expected=['Ticker','Name','Sector','Asset Class','Market Value','Weight (%)','Notional Value','Shares','Price','Location','Exchange','Currency','FX Rate','Market Currency','Accrual Date'];
if(JSON.stringify(rows[header])!==JSON.stringify(expected))throw new ReviewError('IWV columns changed; review the adapter.');
const observed=rows.find(r=>r[0]==='Fund Holdings as of')?.[1],parsed=new Date(observed+' 12:00:00 UTC');
if(!Number.isFinite(+parsed))throw new ReviewError('Missing source date');
const asOf=parsed.toISOString().slice(0,10),validThrough=new Date(+parsed+7*86400000).toISOString().slice(0,10),members=[],skipped=[];
const hash=await hashText(text);
for(const row of rows.slice(header+1)){
  if(row.length!==expected.length)throw new ReviewError('Unexpected holdings row width.');
  if(row[3]!=='Equity'||row[13]!=='USD'||!/^[A-Z][A-Z0-9.-]{0,24}$/.test(row[0])||!['NASDAQ','NYSE','New York Stock Exchange Inc.','NYSE Arca','Nyse Mkt Llc','Cboe BZX'].includes(row[10])){skipped.push({symbol:row[0],type:row[3],exchange:row[10]});continue;}
  const value=Number(row[4].replaceAll(',',''));if(!Number.isFinite(value)||value<0)throw new ReviewError('Invalid constituent value.');
  members.push({symbol:row[0],name:row[1],type:'stock',currency:'USD',sector:row[2]==='-'?null:row[2],industry:null,sizeBand:null,benchmark:null,relatedGroup:null,benchmarkWeight:value});
}
const total=members.reduce((s,m)=>s+m.benchmarkWeight,0);if(!(total>0))throw new ReviewError('No constituent weight total.');for(const m of members)m.benchmarkWeight/=total;
const document=validateUniverse({format:'tlh-replacement-universe',version:1,name:`Russell 3000 — IWV holdings proxy ${asOf}`,benchmark:'Russell 3000',source:`BlackRock IWV holdings: https://www.blackrock.com/us/individual/products/239714/ishares-russell-3000-etf/latest-holdings.csv ; SHA-256 ${hash}. Seven-day review cutoff assumes unchanged holdings; not official membership. Industry/size/issuer relationships unavailable. Unsupported symbol formats, non-equities and unrecognized exchanges excluded.`,provenance:'fund-proxy',asOf,validThrough,members});
return {...document,originalCsv:{name:'iwv-holdings.csv',hash,text},excludedSourceRows:skipped};
}

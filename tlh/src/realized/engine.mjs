import {ReviewError} from '../review-error.mjs';
import {csvRows} from '../import/csv.mjs';
import {validDate} from '../analysis/inputs.mjs';
import {subtract,total} from '../valuation/engine.mjs';
export const realizedHeaders=['Symbol','Name','Closed Date','Opened Date','Quantity','Proceeds Per Share','Cost Per Share','Proceeds','Cost Basis (CB)','Gain/Loss ($)','Gain/Loss (%)','Long Term Gain/Loss','Short Term Gain/Loss','Term','Unadjusted Cost Basis','Wash Sale?','Disallowed Loss','Transaction Closed Date','Transaction Cost Basis','Total Transaction Gain/Loss ($)','Total Transaction Gain/Loss (%)','LT Transaction Gain/Loss ($)','LT Transaction Gain/Loss (%)','ST Transaction Gain/Loss ($)','ST Transaction Gain/Loss (%)'];
const check=(v,m)=>{if(!v)throw new ReviewError(m);};
const date=v=>{const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v),d=m?`${m[3]}-${m[1]}-${m[2]}`:null;check(validDate(d),'Unsupported or invalid realized-report date.');return d;};
function money(v,required=true){if(!v.trim()){check(!required,'Required realized amount is missing.');return null;}check(/^-?\$?(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,12})?$/.test(v),'Unsupported realized amount.');return subtract(v.replace(/[$,]/g,''),'0');}
export function parseRealized(text){
 check(typeof text==='string'&&new TextEncoder().encode(text).length<=1000000,'Choose a realized Details CSV below 1 MB.');
 const csv=csvRows(text),title=csv[0]?.[0]??'',m=/^Realized Gain\/Loss - Lot Details for (.+) as of (.+) from (\d{2}\/\d{2}\/\d{4}) to (\d{2}\/\d{2}\/\d{4})$/.exec(title);
 check(m&&csv[0].length===25&&csv[0].slice(1).every(v=>!v),'Choose a Schwab Realized Gain/Loss Lot Details export.');
 check(JSON.stringify(csv[1])===JSON.stringify(realizedHeaders),'Unsupported realized-report columns.');
 const start=date(m[3]),end=date(m[4]);check(start<=end,'Invalid report range.');check(csv.length>2&&csv.length<=5002,'Report requires 1–5,000 detail rows.');
 const rows=csv.slice(2).map((v,i)=>{
 check(v.length===25,`Row ${i+3}: unexpected columns.`);const r=Object.fromEntries(realizedHeaders.map((h,j)=>[h,v[j].trim()]));
 check(/^[A-Z0-9][A-Z0-9./-]{0,24}$/.test(r.Symbol),'Invalid realized security identifier.');
 const closed=date(r['Closed Date']),opened=date(r['Opened Date']);check(closed>=start&&closed<=end&&opened<=closed,'Lot dates do not fit the report.');check(date(r['Transaction Closed Date'])===closed,'Transaction and lot close dates differ; review this format.');
 const quantity=money(r.Quantity);check(!quantity.startsWith('-')&&quantity!=='0','Lot quantity must be positive.');
 const proceeds=money(r.Proceeds),basis=money(r['Cost Basis (CB)']),gainLoss=money(r['Gain/Loss ($)']),disallowed=money(r['Disallowed Loss'],false),long=money(r['Long Term Gain/Loss'],false),short=money(r['Short Term Gain/Loss'],false);
 check(['Long Term','Short Term'].includes(r.Term),'Unsupported holding-period label.');check(['Yes','No'].includes(r['Wash Sale?']),'Unsupported wash-sale status.');
 check(!proceeds.startsWith('-')&&!basis.startsWith('-')&&(!disallowed||!disallowed.startsWith('-')),'Negative proceeds, basis or disallowed loss needs review.');
 const applicable=r.Term==='Long Term'?long:short,other=r.Term==='Long Term'?short:long;
 check(applicable!==null&&subtract(applicable,gainLoss)==='0'&&(other===null||other==='0'),'Term amount does not match lot gain/loss.');
 const difference=subtract(gainLoss,subtract(proceeds,basis));
 check(difference==='0'||r['Wash Sale?']==='Yes'&&disallowed!==null&&subtract(difference,disallowed)==='0','Gain/loss does not reconcile to proceeds, basis and any reported disallowance.');
 check(r['Wash Sale?']!=='No'||disallowed===null||disallowed==='0','Disallowed loss conflicts with wash-sale status.');
 return {row:i+3,symbol:r.Symbol,name:r.Name,closed,opened,quantity,proceeds,basis,gainLoss,term:r.Term,unadjustedBasis:money(r['Unadjusted Cost Basis'],false),washSale:r['Wash Sale?'],disallowed,raw:r};
 });
 return {version:1,sourceAccount:m[1],asOfText:m[2],start,end,currency:'USD',rows,summary:summarizeRealized(rows)};
}
export function summarizeRealized(rows){
 const sum=rs=>total(rs.map(r=>r.gainLoss));
 return {lots:rows.length,loss:subtract('0',sum(rows.filter(r=>r.gainLoss.startsWith('-')))),gains:sum(rows.filter(r=>!r.gainLoss.startsWith('-'))),net:sum(rows),short:sum(rows.filter(r=>r.term==='Short Term')),long:sum(rows.filter(r=>r.term==='Long Term')),disallowed:total(rows.map(r=>r.disallowed??'0')),blankDisallowed:rows.filter(r=>r.disallowed===null).length,washRows:rows.filter(r=>r.washSale==='Yes').length};
}

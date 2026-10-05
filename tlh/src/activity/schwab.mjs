import {ReviewError} from '../review-error.mjs';
import {csvRows} from '../import/csv.mjs';
import {validDate} from '../analysis/inputs.mjs';
const headers=['Date','Action','Symbol','Description','Quantity','Price','Fees & Comm','Amount'];
const check=(ok,message)=>{if(!ok)throw new ReviewError(message);};
function number(value,label,money=false){
  if(!value)return null;
  const pattern=money?/^-?\$?(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/:/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/;
  check(pattern.test(value),`${label}: unsupported numeric format. No rows were accepted.`);
  return value.replace(/[$,]/g,'').replace(/^(-?)0+(?=\d)/,'$1');
}
// This adapter deliberately recognizes the observed eight-column export only.
// Account, currency, date meaning and collection coverage are review declarations.
export function inspectSchwabActivity(text){
  check(typeof text==='string'&&new TextEncoder().encode(text).length<=262144,'Limit each activity source to 256 KB.');
  const records=csvRows(text);
  check(JSON.stringify(records.shift())===JSON.stringify(headers),'Unsupported Schwab transaction columns. Expected Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount.');
  check(records.length>0&&records.length<=500,'Choose a Schwab CSV with 1–500 transaction rows.');
  const rows=records.map((cells,index)=>{
    const rowRef=`csv-row-${index+2}`,label=`CSV row ${index+2}`;
    check(cells.length===headers.length,`${label}: column count does not match the header.`);
    const [date,action,symbol,description,quantity,price,fees,amount]=cells.map(v=>v.trim());
    const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
    const iso=match?`${match[3]}-${match[1]}-${match[2]}`:null;
    check(validDate(iso),`${label}: expected one valid MM/DD/YYYY date. Review complex or missing dates separately.`);
    check(action.length>0,`${label}: missing action.`);
    number(price,`${label} price`,true);number(fees,`${label} fees`,true);
    const mapped=action==='Buy'?'buy':action==='Sell'?'sell':'other';
    const cashAmount=number(amount,`${label} amount`,true);
    check(!(mapped==='buy'&&cashAmount!==null&&!cashAmount.startsWith('-')&&/[1-9]/.test(cashAmount))&&!(mapped==='sell'&&cashAmount?.startsWith('-')&&/[1-9]/.test(cashAmount)),`${label}: cash sign conflicts with the reported action.`);
    return {rowRef,brokerId:null,date:iso,symbol:symbol||null,exchange:null,action:mapped,quantity:number(quantity,`${label} quantity`),cashAmount,currency:null,note:`Schwab action: ${action}; Description: ${description}; Price: ${price||'unknown'}; Fees & Comm: ${fees||'unknown'}`};
  });
  const dates=rows.map(r=>r.date).sort();
  return {rows,start:dates[0],end:dates.at(-1)};
}

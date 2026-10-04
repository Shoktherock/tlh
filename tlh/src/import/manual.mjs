import {csvRows} from './csv.mjs';
import {parseDecimal,equalDecimals} from '../../../browser-helper/src/decimal.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(`Manual evidence: ${message}`);};
const at=(label,fn)=>{try{return fn();}catch(error){throw new Error(`${label}: ${error.message}`);}};
const object=(v,keys)=>{check(v&&typeof v==='object'&&!Array.isArray(v),'expected an object.');check(Object.keys(v).every(k=>keys.includes(k)),'unexpected field; use the current template.');};
const text=(v,name,max=100)=>{check(typeof v==='string'&&v.trim().length>0&&v.length<=max,`${name} is required (up to ${max} characters).`);return v.trim();};
const date=v=>{if(v===null)return null;check(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v),'dates must be YYYY-MM-DD or unknown.');const d=new Date(`${v}T00:00:00Z`);check(Number.isFinite(+d)&&d.toISOString().slice(0,10)===v,'invalid calendar date.');return v;};
const amount=(v,unknown=true,positive=false)=>{if(v===null&&unknown)return null;check(typeof v==='string'&&v.length<=80&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v),'amounts must be nonnegative decimal strings, without commas or currency signs.');const n=parseDecimal(v);check(!positive||!equalDecimals(n,'0'),'individual lot quantities must be positive.');return n;};
const currency=v=>{check(v===null||typeof v==='string'&&/^[A-Z]{3}$/.test(v),'currency must be a three-letter code or unknown.');return v;};

// Manual evidence has its own provenance and format. It never masquerades as a
// brokerage export or helper capture, and observation time is not an effective date.
export function validateManual(input){
  object(input,['format','version','account_label','reference','reason','positions']);
  check(input.format==='tlh-manual-evidence'&&input.version===1,'unsupported format/version.');
  const account_label=text(input.account_label,'source account label'),reference=text(input.reference,'evidence reference',1000),reason=text(input.reason,'entry reason',4000);
  check(reason.length>=3,'entry reason needs at least 3 characters.');
  check(Array.isArray(input.positions)&&input.positions.length>0&&input.positions.length<=1000,'enter 1–1000 positions.');
  const symbols=new Set();let lotCount=0;
  const positions=input.positions.map((p,index)=>at(`Position ${index+1}${typeof p?.symbol==='string'?` (${p.symbol})`:''}`,()=>{
    object(p,['symbol','description','quantity','total_basis','currency','effective_date','lots']);
    const symbol=text(p.symbol,'security symbol',40).toUpperCase();check(!['__PROTO__','CONSTRUCTOR','PROTOTYPE'].includes(symbol)&&!/[\u0000-\u001f\u007f]/.test(symbol)&&!symbols.has(symbol),'duplicate or unsupported symbol.');symbols.add(symbol);
    check(typeof p.description==='string'&&p.description.length<=240,'description must be text up to 240 characters.');
    let lots=null;
    if(p.lots!==null){
      const s=p.lots;object(s,['coverage','effective_date','reported_quantity','reported_basis','rows']);
      check(['complete','partial'].includes(s.coverage),'choose complete or partial lot coverage.');
      check(Array.isArray(s.rows)&&s.rows.length>0,'a lot scope needs at least one observed row; use no lot evidence otherwise.');
      lotCount+=s.rows.length;check(lotCount<=5000,'limit each file to 5000 lot rows.');
      lots={coverage:s.coverage,effective_date:date(s.effective_date),reported_quantity:amount(s.reported_quantity),reported_basis:amount(s.reported_basis),rows:s.rows.map((l,i)=>at(`Lot row ${i+1}`,()=>{
        object(l,['acquisition_date','quantity','total_basis','cost_per_share']);
        return {acquisition_date:date(l.acquisition_date),quantity:amount(l.quantity,false,true),total_basis:amount(l.total_basis),cost_per_share:amount(l.cost_per_share)};
      }))};
    }
    return {symbol,description:p.description,quantity:amount(p.quantity,false),total_basis:amount(p.total_basis),currency:currency(p.currency),effective_date:date(p.effective_date),lots};
  }));
  return {format:input.format,version:1,account_label,reference,reason,positions};
}

export const manualHeaders=['Type','Symbol','Description','Quantity','Total basis','Currency','Effective date','Acquired','Cost per share','Coverage'];
export function parseManualCsv(text){
  const rows=csvRows(text);
  // Spreadsheet CSV writers pad short metadata rows to the table width. Only
  // genuinely empty trailing cells are accepted; nonempty extra columns reject.
  const width=(row,n)=>Array.isArray(row)&&row.length>=n&&row.slice(n).every(c=>!c.trim());
  check(width(rows[0],2)&&JSON.stringify(rows[0].slice(0,2))===JSON.stringify(['TLH Manual Evidence','1']),'use the TLH Manual Evidence version 1 template.');
  const meta={};for(const [i,key,name] of [[1,'account_label','Account'],[2,'reference','Reference'],[3,'reason','Reason']]){check(width(rows[i],2)&&rows[i][0]===name,`missing ${name} metadata row.`);meta[key]=rows[i][1];}
  check(width(rows[4],10)&&JSON.stringify(rows[4].slice(0,10))===JSON.stringify(manualHeaders),'template columns were changed.');
  const positions=new Map(),scopes=new Map(),lots=new Map();
  for(const [i,cells] of rows.slice(5).entries()){
    check(width(cells,10),`row ${i+6} must have ten columns; extra nonempty columns are unsupported.`);
    const [type,rawSymbol,description,quantity,basis,code,effective,acquired,cost,coverage]=cells.slice(0,10).map(c=>c.trim());
    const symbol=rawSymbol.toUpperCase();
    const nil=v=>v===''?null:v;
    if(type==='POSITION'){
      check(!positions.has(symbol)&&!acquired&&!cost&&!coverage,`row ${i+6}: duplicate position or unexpected lot fields.`);
      positions.set(symbol,{symbol,description,quantity,total_basis:nil(basis),currency:nil(code),effective_date:nil(effective),lots:null});
    }else if(type==='SCOPE'){
      check(!scopes.has(symbol)&&!description&&!code&&!acquired&&!cost,`row ${i+6}: duplicate scope or unexpected fields.`);
      scopes.set(symbol,{coverage,effective_date:nil(effective),reported_quantity:nil(quantity),reported_basis:nil(basis),rows:[]});
    }else if(type==='LOT'){
      check(!description&&!code&&!effective&&!coverage,`row ${i+6}: unexpected fields in lot row.`);
      const group=lots.get(symbol)??[];group.push({acquisition_date:nil(acquired),quantity,total_basis:nil(basis),cost_per_share:nil(cost)});lots.set(symbol,group);
    }else throw new Error(`Manual evidence: row ${i+6} has an unsupported Type. Use POSITION, SCOPE, or LOT.`);
  }
  for(const [symbol,scope] of scopes){check(positions.has(symbol),`${symbol}: lot scope needs a position row.`);scope.rows=lots.get(symbol)??[];positions.get(symbol).lots=scope;}
  for(const symbol of lots.keys())check(scopes.has(symbol),`${symbol}: lots need an explicit SCOPE row with coverage.`);
  return validateManual({format:'tlh-manual-evidence',version:1,...meta,positions:[...positions.values()]});
}

export function manualEvidence(data,sourceId){
  const positions=[],scopes=[];
  for(const [index,p] of data.positions.entries()){
    const security={symbol:p.symbol},timing={effective_at:null,observed_at:null};
    positions.push({security,description:p.description,quantity:p.quantity,total_basis:p.total_basis,currency:p.currency,...timing,effective_date:p.effective_date,source_ref:`manual-position-${index+1}`,source_id:sourceId});
    if(p.lots)scopes.push({security,status:p.lots.coverage,...timing,effective_date:p.lots.effective_date,source_ref:`manual-scope-${index+1}`,source_id:sourceId,
      reported_totals:{quantity:p.lots.reported_quantity,total_basis:p.lots.reported_basis},
      lots:p.lots.rows.map((l,i)=>({...l,row_ref:`manual-lot-${i+1}`,broker_lot_id:null,broker_holding_period:null,currency:p.currency})),issues:[]});
  }
  return {positions,scopes,issues:[{code:'MANUAL_EVIDENCE',message:`Manually transcribed evidence: ${data.reference}. ${data.reason}`}],labels:[`Manual entry · ${data.account_label} · ${data.reference}`],cash:null,csvSymbols:null,csvDate:null};
}

export const manualTemplate=()=>[
  ['TLH Manual Evidence','1'],['Account','Synthetic example account'],['Reference','Synthetic statement example; replace with the source you checked'],['Reason','Synthetic template; replace these rows with verified evidence'],manualHeaders,
  ['POSITION','EXAMPLE','Synthetic example','2','200','USD','2026-09-08','','',''],
  ['SCOPE','EXAMPLE','','2','200','','2026-09-08','','','complete'],
  ['LOT','EXAMPLE','','1','100','','','2025-01-10','100',''],
  ['LOT','EXAMPLE','','1','100','','','2025-01-10','100',''],
  ['POSITION','POSITION_ONLY','Synthetic holding without lots','3','','','','','','']
].map(row=>row.map(v=>`"${v.replaceAll('"','""')}"`).join(',')).join('\r\n')+'\r\n';

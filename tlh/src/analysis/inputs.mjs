const check=(ok,message)=>{if(!ok)throw new Error(message);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k));
export const validDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const note=(v,label,required=false)=>{check(typeof v==='string'&&v.length<=1000&&(!required||v.trim().length>=3),`${label} must be ${required?'3–1000':'0–1000'} characters.`);return v.trim();};
const decimal=(v,label,max=null)=>{
  if(v===null)return null;
  check(typeof v==='string'&&v.length<=24&&/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(v),`${label} must be a nonnegative decimal with up to four decimal places, or blank.`);
  if(max!==null)check(Number(v)<=max,`${label} must be between 0 and ${max}.`);
  return v.includes('.')?v.replace(/0+$/,'').replace(/\.$/,''):v;
};
export const defaultAccountInput=accountId=>({accountId,scope:'unreviewed',reason:'',history:{status:'not_reviewed',start:null,end:null,reference:'',note:''}});
export const defaultInputs=accounts=>({version:1,analysisDate:null,rates:{federalShort:null,federalLong:null,state:null},minLoss:{amount:null,currency:'USD'},household:'not_reviewed',householdNote:'',accounts:accounts.map(a=>defaultAccountInput(a.id))});
export function projectInputs(input,accounts){
  if(!input)return defaultInputs(accounts);
  return {...structuredClone(input),accounts:accounts.map(a=>structuredClone(input.accounts.find(r=>r.accountId===a.id)??defaultAccountInput(a.id)))};
}
export function validateInputs(raw,accounts){
  check(keys(raw,['version','analysisDate','rates','minLoss','household','householdNote','accounts'])&&raw.version===1,'Unsupported analysis inputs.');
  check(raw.analysisDate===null||validDate(raw.analysisDate),'Choose a valid analysis calendar date or leave it blank.');
  check(keys(raw.rates,['federalShort','federalLong','state']),'Invalid rate assumptions.');
  const rates=Object.fromEntries(['federalShort','federalLong','state'].map(k=>[k,decimal(raw.rates[k],`${k} percentage`,100)]));
  // Scale to integer ten-thousandths of a percentage point to avoid binary rounding.
  const units=v=>BigInt((v??'0').split('.')[0])*10000n+BigInt(((v??'0').split('.')[1]??'').padEnd(4,'0'));
  for(const k of ['federalShort','federalLong'])check(rates[k]===null||rates.state===null||units(rates[k])+units(rates.state)<=1000000n,'Combined federal and state assumptions cannot exceed 100%.');
  check(keys(raw.minLoss,['amount','currency'])&&typeof raw.minLoss.currency==='string'&&/^[A-Z]{3}$/.test(raw.minLoss.currency),'Choose a three-letter threshold currency.');
  const minLoss={amount:decimal(raw.minLoss.amount,'Minimum loss'),currency:raw.minLoss.currency};
  check(['not_reviewed','all_known_listed','additional_accounts'].includes(raw.household),'Choose a household account declaration.');
  const householdNote=note(raw.householdNote,'Household note',raw.household==='additional_accounts');
  check(Array.isArray(raw.accounts)&&raw.accounts.length===accounts.length&&raw.accounts.length<=500,'Review every current account (up to 500).');
  const seen=new Set();const rows=raw.accounts.map(row=>{
    check(keys(row,['accountId','scope','reason','history'])&&accounts.some(a=>a.id===row.accountId)&&!seen.has(row.accountId),'Account selection is missing, duplicated, or not owned by you.');seen.add(row.accountId);
    check(['unreviewed','include','omit'].includes(row.scope),'Choose include, omit, or not reviewed for each account.');
    const reason=note(row.reason,'Account reason',row.scope==='omit');
    const h=row.history;check(keys(h,['status','start','end','reference','note'])&&['not_reviewed','unavailable','partial_available','available'].includes(h.status),'Choose an available history status. Complete verified coverage requires activity records in a later step.');
    const available=['partial_available','available'].includes(h.status);
    check(available?(validDate(h.start)&&validDate(h.end)&&h.start<=h.end):(h.start===null&&h.end===null),'Available history needs a valid inclusive start/end range. Otherwise leave both dates blank.');
    return {accountId:row.accountId,scope:row.scope,reason,history:{status:h.status,start:h.start,end:h.end,reference:note(h.reference,'History source reference',available),note:note(h.note,'History note')}};
  });
  return {version:1,analysisDate:raw.analysisDate,rates,minLoss,household:raw.household,householdNote,accounts:accounts.map(a=>rows.find(r=>r.accountId===a.id))};
}
export function inputWarnings(input,accounts){
  const warnings=['History availability is a planning declaration. No activity rows have been imported or verified by this step.'];
  if(!input.analysisDate)warnings.push('Analysis date is not set.');
  if(Object.values(input.rates).some(v=>v===null))warnings.push('Some rate assumptions are unknown. No tax estimate is calculated.');
  if(input.minLoss.amount===null)warnings.push('Minimum loss threshold is not set.');
  if(input.household!=='all_known_listed')warnings.push('Household account coverage is unreviewed or includes additional unlisted accounts.');
  for(const row of input.accounts){const a=accounts.find(a=>a.id===row.accountId),label=a?.label??row.accountId;
    if(row.scope!=='include')warnings.push(`${label}: ${row.scope==='omit'?'omitted from the proposed analysis':'account inclusion not reviewed'}.`);
    if(row.scope==='include'&&a?.type==='unknown')warnings.push(`${label}: account type is unknown.`);
  }
  return warnings;
}
export function describeInputs(input,accounts){
  const text=v=>v===null?'Not set':v;
  const result=[['Analysis date',text(input.analysisDate)],['Federal short-term assumption',input.rates.federalShort===null?'Unknown':`${input.rates.federalShort}%`],['Federal long-term assumption',input.rates.federalLong===null?'Unknown':`${input.rates.federalLong}%`],['State assumption',input.rates.state===null?'Unknown':`${input.rates.state}%`],['Minimum loss',`${text(input.minLoss.amount)} ${input.minLoss.currency}`],['Household account declaration',({not_reviewed:'Not reviewed',all_known_listed:'All known accounts listed (user declaration)',additional_accounts:'Additional accounts are not listed'})[input.household]],['Household note',input.householdNote||'None']];
  for(const row of input.accounts){const a=accounts.find(a=>a.id===row.accountId),label=`${a?.portfolioName?`${a.portfolioName} / `:''}${a?.label??row.accountId} (${row.accountId})`,h=row.history;
    result.push([`${label} · inclusion`,({unreviewed:'Not reviewed',include:'Include',omit:'Omit'})[row.scope]], [`${label} · reason`,row.reason||'None'],[`${label} · history availability`,({not_reviewed:'Not reviewed',unavailable:'No records available',partial_available:'Some records available; not imported',available:'Records available; not imported'})[h.status]],[`${label} · stated range`,h.start?`${h.start} through ${h.end} (inclusive)`:'None'],[`${label} · source reference`,h.reference||'None'],[`${label} · history note`,h.note||'None']);
  }
  return result;
}
export function inputChanges(before,after,accounts){const old=new Map(describeInputs(projectInputs(before,accounts),accounts));return describeInputs(after,accounts).filter(([label,value])=>old.get(label)!==value).map(([label,value])=>({label,before:old.get(label),after:value}));}

export function exportInputsBackup(input,accounts,exportedAt=new Date().toISOString()){
  check(input,'Save analysis inputs before exporting.');const normalized=validateInputs(projectInputs(input,accounts),accounts);
  return {format:'tlh-analysis-inputs',version:1,exportedAt,accounts:accounts.map(a=>({id:a.id,label:a.label,type:a.type,portfolioName:a.portfolioName??null})),input:normalized};
}
export function inspectInputsBackup(raw){
  check(keys(raw,['format','version','exportedAt','accounts','input'])&&raw.format==='tlh-analysis-inputs'&&raw.version===1,'Choose a version 1 analysis-inputs backup.');
  check(typeof raw.exportedAt==='string'&&Number.isFinite(Date.parse(raw.exportedAt)),'Backup export timestamp is invalid.');
  check(Array.isArray(raw.accounts)&&raw.accounts.length<=500&&raw.accounts.every(a=>keys(a,['id','label','type','portfolioName'])&&typeof a.id==='string'&&a.id.length<=100&&typeof a.label==='string'&&a.label.length<=200&&['unknown','taxable','traditional_ira','roth_ira','other'].includes(a.type)&&(a.portfolioName===null||typeof a.portfolioName==='string'&&a.portfolioName.length<=200))&&new Set(raw.accounts.map(a=>a.id)).size===raw.accounts.length,'Backup account inventory is invalid.');
  return {...raw,input:validateInputs(raw.input,raw.accounts)};
}
export function restoreInputsBackup(raw,mapping,accounts){
  const backup=inspectInputsBackup(raw);check(object(mapping)&&Object.keys(mapping).length===backup.accounts.length,'Map every saved account.');const targets=new Set();
  for(const source of backup.accounts){const target=accounts.find(a=>a.id===mapping[source.id]);check(target&&target.type===source.type&&!targets.has(target.id),'Map each saved account to a distinct owned account of the same type.');targets.add(target.id);}
  const input={...backup.input,accounts:backup.input.accounts.map(row=>({...row,accountId:mapping[row.accountId]}))};
  return validateInputs(projectInputs(input,accounts),accounts);
}

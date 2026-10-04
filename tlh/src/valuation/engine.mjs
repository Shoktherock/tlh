import {correctionView} from '../import/corrections.mjs';
import {reconciliationIssues} from '../import/reconciliation.mjs';

const check=(v,message)=>{if(!v)throw new Error(message);};
function parts(value){
  check(typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value),'Invalid exact decimal.');
  const [whole,fraction='']=value.split('.');return {n:BigInt(whole+fraction),scale:fraction.length};
}
function decimal(n,scale){
  const negative=n<0n,digits=(negative?-n:n).toString().padStart(scale+1,'0');
  const s=scale?`${digits.slice(0,-scale)}.${digits.slice(-scale)}`:digits;
  return (negative?'-':'')+(s.includes('.')?s.replace(/0+$/,'').replace(/\.$/,''):s);
}
export function multiply(a,b){if(a==null||b==null)return null;const x=parts(a),y=parts(b);return decimal(x.n*y.n,x.scale+y.scale);}
export function subtract(a,b){if(a==null||b==null)return null;const x=parts(a),y=parts(b),s=Math.max(x.scale,y.scale);return decimal(x.n*10n**BigInt(s-x.scale)-y.n*10n**BigInt(s-y.scale),s);}
export function total(values){return values.reduce((sum,v)=>subtract(sum,subtract('0',v)),'0');}
export const holdingKey=(accountId,symbol)=>JSON.stringify([accountId,symbol]);
const security=s=>JSON.stringify([s?.symbol,s?.broker_security_id??null,s?.exchange??null]);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19);

export function prepareScenarioPrice(state,input){
  const holding=correctionView(state).holdings[input.accountId]?.[input.symbol];
  check(state.accounts.some(a=>a.id===input.accountId)&&holding?.active,'Choose an active holding in your account.');
  check(typeof input.price==='string'&&input.price.length<=80&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input.price),'Enter a nonnegative price without commas or a currency sign.');
  check(typeof input.currency==='string'&&/^[A-Z]{3}$/.test(input.currency),'Enter a three-letter price currency, such as USD.');
  check(typeof input.reference==='string'&&input.reference.trim().length>=3&&input.reference.length<=500,'Describe the test price or its source (3–500 characters).');
  check(input.observedAt===null||iso(input.observedAt),'Price time must be a valid UTC timestamp or unknown.');
  return {accountId:input.accountId,symbol:input.symbol,price:decimal(parts(input.price).n,parts(input.price).scale),currency:input.currency,
    reference:input.reference.trim(),observedAt:input.observedAt,kind:'user-scenario',security:structuredClone(holding.position.security)};
}
function priceStatus(price,asOf){
  if(!price)return 'missing';
  if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(price.price??'')||typeof price.price!=='string'||price.price.length>80||!/^[A-Z]{3}$/.test(price.currency??''))return 'invalid';
  if(price.priceType==='daily-close'){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(price.priceDate??'')||!iso(`${price.priceDate}T00:00:00Z`))return 'invalid';
    const valuationDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(asOf));
    return price.priceDate>=valuationDay?'future':'daily-close';
  }
  if(price.observedAt===null)return 'time-unknown';
  if(!iso(price.observedAt))return 'invalid';
  const age=Date.parse(asOf)-Date.parse(price.observedAt);
  return age<0?'future':age>15*60*1000?'stale':'recent';
}
const statusReason={missing:'No price available',invalid:'Invalid price evidence',future:'Price time is after valuation time',stale:'Price is older than 15 minutes','time-unknown':'Price time is unknown'};
function valueAt(quantity,basis,currency,price,status,conflictingCurrency=false){
  const reasons=[];
  if(statusReason[status])reasons.push(statusReason[status]);
  if(status==='daily-close')reasons.push(`Daily closing price for ${price.priceDate}; not a live quote.`);
  if(price?.quoteWarning)reasons.push(price.quoteWarning);
  if(price?.fallbackReason)reasons.push(price.fallbackReason);
  if(!currency)reasons.push('Evidence currency is unknown');
  if(conflictingCurrency)reasons.push('Reported and confirmed currencies conflict');
  if(price&&currency&&price.currency!==currency)reasons.push('Price and evidence currencies differ');
  if(quantity==null)reasons.push('Quantity is unknown');
  if(basis==null)reasons.push('Cost basis is unknown');
  const usable=price&&!['missing','invalid','future'].includes(status)&&currency&&price.currency===currency&&!conflictingCurrency&&quantity!=null;
  const marketValue=usable?multiply(quantity,price.price):null;
  return {marketValue,pnl:subtract(marketValue,basis),reasons};
}

export function buildValuation(raw,prices,asOf){
  check(iso(asOf),'Choose a valid valuation date and time.');
  const state=correctionView(raw),issues=reconciliationIssues(raw),byHolding=new Map();
  for(const i of issues){const key=holdingKey(i.accountId,i.symbol);byHolding.set(key,[...(byHolding.get(key)??[]),i]);}
  const priceMap=new Map(prices.map(p=>[holdingKey(p.accountId,p.symbol),p]));
  const rows=[];
  for(const account of state.accounts)for(const [symbol,h] of Object.entries(state.holdings[account.id]??{})){
    if(!h.active)continue;
    const key=holdingKey(account.id,symbol),p=h.position,price=priceMap.get(key)??null;
    let status=priceStatus(price,asOf);if(price&&security(price.security)!==security(p.security))status='invalid';
    const currency=p.currency??h.confirmedCurrency??null;
    const conflict=Boolean(p.currency&&h.confirmedCurrency&&p.currency!==h.confirmedCurrency);
    const values=valueAt(p.quantity,p.total_basis,currency,price,status,conflict);
    const rowIssues=byHolding.get(key)??[];
    const lots=(h.lotScope?.lots??[]).map((l,index)=>{
      const lotCurrency=l.currency??h.confirmedCurrency??null;
      const currencyConflict=Boolean(l.currency&&h.confirmedCurrency&&l.currency!==h.confirmedCurrency);
      return {...l,index,currency:lotCurrency,...valueAt(l.quantity,l.total_basis,lotCurrency,price,status,currencyConflict)};
    });
    rows.push({key,accountId:account.id,accountLabel:account.label,portfolioName:account.portfolioName??null,accountType:account.type,symbol,
      quantity:p.quantity,basis:p.total_basis,currency,price,priceStatus:status,...values,lots,lotCoverage:h.lotCoverage,
      positionDate:p.effective_at??p.effective_date??null,lotDate:h.lotScope?.effective_at??h.lotScope?.effective_date??null,
      issues:rowIssues.map(i=>({title:i.title,category:i.category})),corrections:state.correctionStates.filter(c=>c.accountId===account.id&&c.symbol===symbol).map(c=>({status:c.status,target:c.target}))});
  }
  return rows;
}

// These are explicitly labelled partial position subtotals. Lot values describe
// the same holdings and must never be added to position market value or P/L.
export function valuationSummary(rows){
  const groups=new Map();for(const row of rows){const key=row.currency??'Unknown';groups.set(key,[...(groups.get(key)??[]),row]);}
  return [...groups].map(([currency,items])=>{
    const valued=items.filter(r=>r.marketValue!==null),known=items.filter(r=>r.pnl!==null);
    return {currency,positions:items.length,valued:valued.length,knownPnl:known.length,marketValue:valued.length?total(valued.map(r=>r.marketValue)):null,
      pnl:known.length?total(known.map(r=>r.pnl)):null,review:items.filter(r=>r.reasons.length||r.issues.length).length};
  });
}

export function combineValuationPrices(raw,scenarios,items,asOf,mode='provider'){
  if(mode==='scenario')return scenarios;
  const result=new Map(scenarios.map(p=>[holdingKey(p.accountId,p.symbol),p]));
  const providerRows=new Map(buildValuation(raw,items.filter(i=>i.valid&&i.quote).map(i=>i.quote),asOf).map(r=>[r.key,r]));
  for(const item of items){
    const key=holdingKey(item.accountId,item.symbol),row=providerRows.get(key),scenario=result.get(key);
    const usable=item.valid&&item.quote&&row&& !['missing','invalid','future'].includes(row.priceStatus)&&row.currency===item.quote.currency;
    const warning=item.error?.message??(item.cacheStatus==='stale'?(item.quote?.priceType==='daily-close'?'Daily price predates the previous weekday. Check the closing date.':'Cached quote was retrieved more than 15 minutes ago.'):null);
    if(scenario&&(!usable||warning))result.set(key,{...scenario,fallbackReason:`Scenario fallback: ${warning??'no usable provider quote.'}`});
    else if(item.valid&&item.quote)result.set(key,{...item.quote,quoteWarning:warning});
  }
  return [...result.values()];
}

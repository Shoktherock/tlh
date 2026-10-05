import {ReviewError} from '../review-error.mjs';
import {multiply,subtract,total} from '../valuation/engine.mjs';
const valid=v=>typeof v==='string'&&v.length<=40&&/^\d+(?:\.\d{1,12})?$/.test(v);
const positive=v=>valid(v)&&!/^0(?:\.0+)?$/.test(v);
function prorate(basis,quantity,available){
  if(!valid(basis))return null;
  if(subtract(quantity,available)==='0')return basis;
  const value=multiply(basis,quantity),[n,f='']=value.split('.'),[d,g='']=available.split('.');
  const numerator=BigInt(n+f)*10n**BigInt(g.length+2),denominator=BigInt(d+g)*10n**BigInt(f.length);
  const cents=(numerator+denominator/2n)/denominator,s=cents.toString().padStart(3,'0');return `${s.slice(0,-2)}.${s.slice(-2)}`;
}
export function draftLots(holding,selections,price){
  if(!holding?.active||holding.lotCoverage!=='complete'||!positive(price)||!Array.isArray(selections)||!selections.length||selections.length>500)throw new ReviewError('Choose lots and a usable price.');
  const seen=new Set();const lots=selections.map(s=>{
    if(!Number.isInteger(s.index)||seen.has(s.index)||!positive(s.quantity))throw new ReviewError('Select each lot once with a positive quantity.');seen.add(s.index);
    const lot=holding.lotScope?.lots?.[s.index];if(!lot||!positive(lot.quantity)||subtract(lot.quantity,s.quantity).startsWith('-'))throw new ReviewError('Selected quantity exceeds the current lot.');
    const basis=prorate(lot.total_basis,s.quantity,lot.quantity),value=multiply(s.quantity,price);
    return {index:s.index,rowRef:lot.row_ref,sourceId:holding.lotScope.source_id,sourceRef:holding.lotScope.source_ref,quantity:s.quantity,available:lot.quantity,acquired:lot.acquisition_date,basis,value,potentialLoss:basis===null?null:subtract(basis,value),partial:subtract(s.quantity,lot.quantity)!=='0'};
  });
  return {lots,quantity:total(lots.map(l=>l.quantity)),amount:total(lots.map(l=>l.value)),basis:lots.some(l=>l.basis===null)?null:total(lots.map(l=>l.basis)),potentialLoss:lots.some(l=>l.potentialLoss===null)?null:total(lots.map(l=>l.potentialLoss))};
}

import {projectInputs} from './inputs.mjs';
export function browsingInputs(saved,accounts,date){
  const input=projectInputs(saved,accounts);
  input.analysisDate=date;input.minLoss={amount:'0',currency:'USD'};
  input.rates={federalShort:null,federalLong:null,state:null};
  input.accounts=input.accounts.map(a=>({...a,scope:accounts.find(x=>x.id===a.accountId)?.type==='taxable'?'include':'omit',reason:'Temporary browsing scope; not a saved account declaration.'}));
  return input;
}

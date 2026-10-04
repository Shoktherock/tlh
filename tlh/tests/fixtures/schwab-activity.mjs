// Synthetic rows matching the user's eight-column Schwab export layout.
export const csv='\uFEFF"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"\r\n'+
  '"09/16/2026","Sell","EXAMPLE","EXAMPLE CORP, CLASS A","1,234","$12.345","$0.01","$15233.72"\r\n'+
  '"09/15/2026","Buy","FUND","EXAMPLE FUND","10.25","$20.1234","","-$206.26"\r\n'+
  '"09/15/2026","Buy","FUND","EXAMPLE FUND","10.25","$20.1234","","-$206.26"\r\n';
export const review=()=>({format:'schwab-transactions-csv',version:1,sourceAccount:'Synthetic Schwab account',reference:'Synthetic export',reason:'Import transaction evidence',coverage:{start:'2026-09-15',end:'2026-09-16',status:'partial',noActivity:false},currency:'USD',tradeDatesConfirmed:true});
export const source=()=>({name:'synthetic-schwab.csv',text:csv,review:review()});

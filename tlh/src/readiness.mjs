// Evidence collection is distinct from eligibility to trade.
export function readinessSteps(report,coverage){
  const rows=report.rows,n=rows.length;
  const step=(id,title,done,detail,route,action)=>({id,title,done,detail,route,action});
  const dates=rows.map(r=>r.positionDate?.slice(0,10)).filter(Boolean).sort();
  const lots=rows.filter(r=>r.lotCoverage==='complete'&&r.lots.length).length;
  const issues=rows.filter(r=>r.issues.length).length;
  const prices=rows.filter(r=>r.price?.kind!=='user-scenario'&&['recent','daily-close'].includes(r.priceStatus)&&r.marketValue!==null);
  const priceDates=prices.map(r=>(r.price.priceDate??r.price.observedAt)?.slice(0,10)).filter(Boolean).sort();
  const history=coverage?.filter(c=>c.status==='covered_in_supplied_records').length??0;
  const marketDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(report.asOf));
  const previous=new Date(`${marketDay}T12:00:00Z`);
  do{previous.setUTCDate(previous.getUTCDate()-1);}while([0,6].includes(previous.getUTCDay()));
  const recent=prices.filter(r=>!r.price.quoteWarning&&(r.priceStatus==='recent'||r.price.priceDate>=previous.toISOString().slice(0,10))).length;
  return [
    step('accounts','Choose your accounts',report.accounts.length>0,`${report.accounts.length} account(s). Include other accounts that may contain related purchases.`,'accounts','Manage accounts'),
    step('positions','Import positions',n>0,`${n} active holding(s). Position dates: ${dates.length?`${dates[0]} through ${dates.at(-1)}`:'unknown'}. ${n-dates.length} undated. Dates do not confirm current holdings.`,'Import','Upload positions'),
    step('lots','Add lot details',n>0&&lots===n,`${lots} of ${n} holdings have complete lot collections. Use the browser helper JSON or a lot CSV; completeness does not mean reconciliation.`,'Import','Upload lots'),
    step('reconcile','Resolve evidence exceptions',n>0&&issues===0,`${issues} holding(s) have reconciliation exceptions. Review quantities, basis and dates before relying on the analysis.`,'Reconciliation','Review exceptions'),
    step('prices','Check market prices',n>0&&recent===n,`${prices.length} of ${n} holdings have provider prices usable for display. Price dates: ${priceDates.length?`${priceDates[0]} through ${priceDates.at(-1)}`:'unavailable'}. Freshness uses the previous weekday, not a holiday calendar. Verify the closing date; saved prices may be old. Scenario prices are excluded.`,'prices','Update prices'),
    step('activity','Review transaction coverage',!!coverage&&coverage.length>0&&history===coverage.length,coverage?`${history} of ${coverage.length} accounts have supplied coverage for the review window. Future dates and missing accounts still require follow-up.`:'Transaction coverage could not be loaded. Retry the check.','Activity','Review transactions'),
  ];
}

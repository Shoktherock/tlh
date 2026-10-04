import {sumDecimals,equalDecimals} from '../../../browser-helper/src/decimal.mjs';
import {correctionView,targetKey} from './corrections.mjs';

export const issueCategories=['Totals','Lot coverage','Missing fields','Source conflicts','Timing'];
const date = value => value?.effective_at?.slice(0,10) ?? value?.effective_date ?? null;
function timing(position,scope){
  if(!date(position)||!date(scope))return 'unknown';
  if(position.effective_at&&scope.effective_at)return Date.parse(position.effective_at)===Date.parse(scope.effective_at)?'same':'different';
  return date(position)===date(scope)?'same-day':'different';
}

// A read-only projection of accepted evidence. IDs include account and security so
// same-symbol holdings in separate accounts never share a review item.
export function reconciliationIssues(state){
  const rawState=state;
  state=correctionView(state);
  const issues=[];
  for(const account of state.accounts){
    const history=state.imports.filter(b=>b.accountId===account.id);
    for(const [symbol,holding] of Object.entries(state.holdings[account.id]??{})){
      const position=holding.position,scope=holding.lotScope,latest=holding.supplementalScope;
      const rows=scope?.lots??[];const relation=scope?timing(position,scope):'unknown';
      const currencies=new Set([holding.confirmedCurrency,position.currency,...rows.map(l=>l.currency)].filter(Boolean));
      const lotCurrencies=new Set(rows.map(l=>l.currency).filter(Boolean));
      const totals={position:{quantity:position.quantity,total_basis:position.total_basis},reported:scope?.reported_totals??null,
        rows:scope?{quantity:sumDecimals(rows.map(l=>l.quantity)),total_basis:lotCurrencies.size>1?null:sumDecimals(rows.map(l=>l.total_basis))}:null,timing:relation,currencyConflict:currencies.size>1};
      const original=rawState.holdings[account.id][symbol];
      const evidence=[['Position',original.position],['Accepted lots',original.lotScope],['Incoming incomplete lots',original.supplementalScope]].filter(([,v])=>v).map(([role,value])=>{
        // Retained lots can come from an older batch than lastImportId. Resolve by
        // source hash within this account, including sources embedded in backups.
        const batch=[...history].reverse().find(b=>b.sources.some(s=>s.id===value.source_id));
        return {role,source:batch?.sources.find(s=>s.id===value.source_id)??null,sourceRef:value.source_ref??null,
          effectiveAt:value.effective_at??value.effective_date??null,observedAt:value.observed_at??null,acceptedAt:batch?.acceptedAt??null};
      });
      const currentBatch=history.find(b=>b.id===holding.lastImportId);
      const seen=new Set();
      const add=(code,category,priority,title,message,nextStep,lotRows=[])=>{
        if(seen.has(code))return;seen.add(code);
        issues.push({id:JSON.stringify([account.id,symbol,code]),code,category,priority,title,message,nextStep,lotRows,
          accountId:account.id,accountLabel:account.label,portfolioName:account.portfolioName??null,symbol,active:holding.active,
          holding,totals,evidence,review:currentBatch?{acceptedAt:currentBatch.acceptedAt,reason:currentBatch.decisions.reason,restoration:currentBatch.restoration??null}:null});
      };
      if(!scope||holding.lotCoverage!=='complete')add('LOT_COVERAGE','Lot coverage','data',scope?'Previous lots retained':'No complete lot snapshot',
        scope?'The latest accepted evidence did not supply a complete replacement. Previous lots remain in the current view.':`Lot coverage is ${holding.lotCoverage??'missing'}. Position totals do not supply individual lots.`,
        'Import a complete lot snapshot for this security. Keep the holding visible while lot evidence is incomplete.');
      for(const field of ['quantity','total_basis']){
        const label=field==='quantity'?'Quantity':'Cost basis';
        if(position[field]===null)add(`POSITION_${field}_UNKNOWN`,'Missing fields','data',`${label} is unknown in the position`,'The position source does not report this value.','Obtain a source with the reported value; do not treat unknown as zero.');
        if(scope){
          const missing=rows.flatMap((l,i)=>l[field]===null?[i]:[]);
          if(missing.length)add(`LOT_${field}_UNKNOWN`,'Missing fields','data',`${label} is unknown in ${missing.length} lot row(s)`,'An exact lot total cannot be calculated with missing values.','Review the marked source rows and obtain complete lot details.',missing);
          if(scope.reported_totals[field]===null)add(`REPORTED_${field}_UNKNOWN`,'Missing fields','data',`Reported lot ${label.toLowerCase()} total is unknown`,'The lot source did not report a total for this field.','Review the lot source; unknown reported totals remain unknown.');
          const sum=totals.rows[field],reported=scope.reported_totals[field];
          if(sum!==null&&reported!==null&&!equalDecimals(sum,reported))add(`ROWS_REPORTED_${field}`,'Totals','data',`${label}: lot rows differ from the reported lot total`,'The sum of individual lot rows differs from the total reported in that same lot source.','Review the lot source rows and reported total; import corrected evidence rather than inventing a balancing lot.');
          if((field!=='total_basis'||currencies.size<=1)&&relation!=='different'&&position[field]!==null&&sum!==null&&!equalDecimals(position[field],sum))add(`ROWS_POSITION_${field}`,'Totals','data',`${label}: lot rows differ from the position`,
            relation==='unknown'?'The numeric totals differ, but an effective date is unknown. This is a difference requiring review, not a verified same-time discrepancy.':'The position and lot-row totals differ on matching reported dates. Intraday timing may still need review.',
            'Review position and lot source dates, then obtain matching complete evidence.');
        }
      }
      if(scope){
        const missing=rows.flatMap((l,i)=>!l.acquisition_date?[i]:[]);
        if(missing.length)add('ACQUISITION_UNKNOWN','Missing fields','data',`Acquisition date unknown in ${missing.length} lot row(s)`,'These rows have no usable acquisition date. Identical-looking rows remain separate lots.','Review the marked rows and obtain acquisition-date evidence.',missing);
        if(relation==='different')add('EFFECTIVE_TIMES_DIFFER','Timing','review','Position and lot effective times differ','The sources represent different effective times. Their totals are shown separately and are not treated as a simultaneous discrepancy.','Obtain aligned position and lot evidence, or keep the timing uncertainty visible.');
        if(!date(scope))add('LOT_TIME_UNKNOWN','Timing','review','Lot effective date is unknown','A capture or observation time does not establish the broker’s effective date for these lots.','Review the original lot source. Preserve the unknown date if the broker does not supply it.');
      }
      if(!date(position))add('POSITION_TIME_UNKNOWN','Timing','review','Position effective date is unknown','The position has no reported effective date.','Review the position source; an observation timestamp must not be substituted for an effective date.');
      if(!holding.confirmedCurrency&&!position.currency)add('CURRENCY_UNKNOWN','Missing fields','data','Position currency is unconfirmed','No source currency or user currency confirmation is attached to this position.','Confirm the account/source currency when building the next import preview.');
      if(currencies.size>1)add('CURRENCY_CONFLICT','Source conflicts','data','Reported and confirmed currencies differ','Accepted evidence contains different currency codes. Totals must not be combined across currencies.','Review the original sources and currency confirmation.');
      for(const warning of holding.warnings??[]){
        if(['SOURCE_CONFLICT','SOURCE_CONFLICT_REVIEWED'].includes(warning.code))add('SOURCE_CONFLICT','Source conflicts','data','Source disagreement remains unresolved',warning.message,'Review the original files and saved review note. A note records the decision but does not reconcile differing source values.');
        else if(['OLDER_LOTS','OLDER_POSITIONS','POSITION_TIME_REVIEW','LOT_TIME_REVIEW','ABSENT_FROM_UPLOAD'].includes(warning.code))add(warning.code,'Timing','review',warning.code.startsWith('OLDER')?'Older evidence was archived':warning.code==='ABSENT_FROM_UPLOAD'?'Holding absent from the latest upload':'Replacement timing required review',warning.message,'Inspect the recorded review decision and effective times before replacing current evidence.');
      }
      for(const correction of state.correctionStates.filter(c=>c.accountId===account.id&&c.symbol===symbol&&c.status==='conflict'))add(`CORRECTION_CONFLICT_${targetKey(correction.target)}`,'Source conflicts','data','Manual correction needs review','The imported evidence changed after this correction was reviewed. The correction is suspended; the imported value is shown.','Review the correction against the latest source. Reapply it with a reason or withdraw it to use imported evidence.');
      if(holding.unresolved&&!seen.size)add('UNRESOLVED_EVIDENCE','Source conflicts','data','Accepted evidence is marked unresolved','This holding retains an unresolved flag from import.','Review the import history and original sources before correcting the evidence.');
    }
  }
  return issues.sort((a,b)=>(a.priority==='data'?0:1)-(b.priority==='data'?0:1)||a.accountLabel.localeCompare(b.accountLabel)||a.symbol.localeCompare(b.symbol)||a.code.localeCompare(b.code));
}

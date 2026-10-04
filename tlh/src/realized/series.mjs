import {summarizeRealized} from './engine.mjs';
export function realizedSeries(reports,accountIds,year){
 const selected=new Set(accountIds),active=reports.filter(r=>r.active&&selected.has(r.account_id)),rows=active.flatMap(r=>r.document.rows).filter(r=>r.closed.startsWith(year+'-'));
 const dates=[...new Set(rows.map(r=>r.closed))].sort();
 let accumulated=[];
 const daily=dates.map(date=>{accumulated.push(...rows.filter(r=>r.closed===date));return {date,...summarizeRealized(accumulated)};});
 const ranges=active.filter(r=>r.document.start<=`${year}-12-31`&&r.document.end>=`${year}-01-01`);
 if(!ranges.length)return {daily:[],monthly:[]};
 const end=ranges.reduce((last,r)=>r.document.end>last?r.document.end:last,`${year}-01-01`).slice(0,4)>year?12:Number(ranges.reduce((last,r)=>r.document.end>last?r.document.end:last,`${year}-01-01`).slice(5,7));
 const monthly=Array.from({length:end},(_,i)=>{
  const month=`${year}-${String(i+1).padStart(2,'0')}`,start=month+'-01',finish=new Date(Date.UTC(Number(year),i+1,0)).toISOString().slice(0,10);
  const complete=accountIds.length>0&&accountIds.every(id=>{let cursor=start;for(const r of ranges.filter(r=>r.account_id===id).sort((a,b)=>a.document.start.localeCompare(b.document.start))){if(r.document.end<cursor)continue;if(r.document.start>cursor)return false;if(r.document.end>=finish)return true;cursor=new Date(Date.parse(r.document.end+'T00:00:00Z')+86400000).toISOString().slice(0,10);}return false;});
  const detail=rows.filter(r=>r.closed.startsWith(month));return {month,complete,observed:detail.length>0,...summarizeRealized(detail)};
 });
 return {daily,monthly};
}

export const queueKey=r=>JSON.stringify([r.accountId,r.symbol]);
export async function runQuoteQueue({rows,request,publish,progress,signal,wait=ms=>new Promise(resolve=>{const timer=setTimeout(done,ms);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});}),pace=8000}){
  const issues=[],targets=[...new Map(rows.map(r=>[queueKey(r),r])).values()];
  let result=await request({action:'read'}),calls=0,completed=0;
  publish(result);
  async function send(body){
    if(calls++)await wait(pace);
    if(signal.aborted)return null;
    let next=await request(body);publish(next);
    const status=body.action==='automap'?next.automatic:next.items.find(i=>queueKey(i)===queueKey(body.holdings[0]))?.error;
    if(['rate_limit','busy'].includes(status?.code)){
      progress('Waiting for provider allowance…',issues);
      await wait(61000);if(signal.aborted)return null;
      next=await request(body);publish(next);
      const retry=body.action==='automap'?next.automatic:next.items.find(i=>queueKey(i)===queueKey(body.holdings[0]))?.error;
      if(['rate_limit','busy'].includes(retry?.code))throw Error('Provider allowance is still exhausted. Progress is saved; resume later.');
    }
    return next;
  }
  for(const row of targets){
    if(signal.aborted)break;
    const item=result.items.find(i=>queueKey(i)===queueKey(row));
    if(item){if(!item.valid)issues.push({...row,message:'Holding changed; review mapping.'});continue;}
    progress(`Matching ${++completed} / ${targets.length}…`,issues);
    const next=await send({action:'automap',accountId:row.accountId,symbol:row.symbol});if(!next)break;result=next;
    if(!['matched','preserved'].includes(next.automatic?.code))issues.push({...row,message:next.automatic?.message??'Review mapping.'});
  }
  // Freeze the refresh list so a large portfolio never loops back as early quotes age.
  const pending=result.items.filter(i=>i.valid&&targets.some(r=>queueKey(r)===queueKey(i))&&(!i.quote||Date.now()-Date.parse(i.quote.fetchedAt)>=900000));
  const seen=new Set();completed=0;
  for(const item of pending){
    if(signal.aborted)break;
    const key=JSON.stringify(item.mapping);if(seen.has(key))continue;seen.add(key);
    progress(`Refreshing ${++completed} / ${pending.length}…`,issues);
    const next=await send({action:'refresh',holdings:[{accountId:item.accountId,symbol:item.symbol}]});if(!next)break;
    const outcome=next.items.find(i=>queueKey(i)===queueKey(item));
    if(outcome?.error)issues.push({...item,message:outcome.error.message});
  }
  progress(signal.aborted?'Stopped. Saved mappings and prices are retained.':'Finished. Review any exceptions below.',issues);
  return issues;
}

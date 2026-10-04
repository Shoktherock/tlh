// Market caches are shared across users: synthetic accounts alone do not isolate them.
// Restore the original batch on success AND failure, without overwriting a concurrent refresh.
export async function temporaryDailyBatch(db,date,syntheticPrices){
 const check=r=>{if(r.error)throw Error(r.error.message);return r.data;};
 const original=check(await db.from('massive_daily_cache').select('*').eq('price_date',date).maybeSingle());
 const row={price_date:date,fetched_at:new Date().toISOString(),prices:{...original?.prices,...syntheticPrices}};
 check(await db.from('massive_daily_cache').upsert(row));
 return async()=>{
   const query=original?db.from('massive_daily_cache').update({prices:original.prices,fetched_at:original.fetched_at}):db.from('massive_daily_cache').delete();
   check(await query.eq('price_date',date).eq('fetched_at',row.fetched_at));
 };
}

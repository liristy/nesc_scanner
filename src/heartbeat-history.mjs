import { mapConcurrent } from './concurrency.mjs';

// Read validated historical days sequentially and retain each completed day.
// Dates retain their original order in both checkpoints and final evidence.
export async function collectHeartbeatHistory(current, dates, readDay, save, {signal}={}) {
  const days=new Map();
  let writes=Promise.resolve(),writeFailure;
  const snapshot=()=>({...current,complete:false,historyComplete:false,
    historyCoverageVersion:1,
    historyDays:[...(current.complete?[current.reportDate]:[]),...dates.filter(date=>days.has(date))],
    records:[...current.records,...dates.flatMap(date=>days.get(date)?.records ?? [])]});
  const checkpoint=async()=>{
    const evidence=snapshot();
    writes=writes.then(()=>save(evidence)).catch(error=>{writeFailure ??= error;});
    await writes;
    if(writeFailure)throw writeFailure;
  };
  await checkpoint();
  // Older days cannot repair a gap in the current day. Keep its evidence and
  // error, without spending another nine daily queries or certifying coverage.
  if(!current.complete)return {...snapshot(),error:current.error || '当前日心跳读取不完整'};
  let failure;
  try {
    await mapConcurrent(dates,1,async date=>{
      let day;
      try {
        day=await readDay(date);
        if(!day?.complete || !Array.isArray(day.records))throw new Error('历史日期未完整读取');
      } catch(error) {
        // Keep the date of the first failed query; the pool drains in-flight
        // reads before returning, and never starts more after an error.
        failure ??= {date,error};
        throw error;
      }
      signal?.throwIfAborted();
      days.set(date,day);
      await checkpoint();
    },{signal});
  } catch(error) {
    signal?.throwIfAborted();
    if(writeFailure)throw writeFailure;
    if(!failure)throw error;
  }
  await writes;
  if(writeFailure)throw writeFailure;
  const result=snapshot();
  if(failure) {
    result.error=`${failure.date}历史缺口：${failure.error.message}`;
    result.errorCode=failure.error.code;
  }
  result.complete=!failure && days.size===dates.length;
  result.historyComplete=result.complete;
  return result;
}

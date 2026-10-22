import { chunk, formatLocalDateTime, identityOf, parsePlatformDateTime } from "./utils.mjs";
import { downloadAlarmRows } from "./alarm-export.mjs";

export async function refreshPreviousAlarms(platform, previousItems, currentRows, config, {stage='历史报警恢复复查',checkpoint=new Map()}={}) {
  const current = new Set(currentRows.map(identityOf));
  const days = new Map();
  const errors = [];
  for (const item of previousItems) {
    if (current.has(identityOf(item))) continue;
    const time = parsePlatformDateTime(item.alarm_time);
    if (!time || !item.bms_number) { errors.push("历史跟踪缺少有效日期或SN，保留待核实"); continue; }
    const date = formatLocalDateTime(time).slice(0, 10);
    const sns = days.get(date) ?? new Set();
    sns.add(item.bms_number);
    days.set(date, sns);
  }
  const tasks = [];
  for (const [date, sns] of days) {
    for (const batch of chunk([...sns], 45)) {
      tasks.push({date,batch});
    }
  }
  const limit=Math.max(0,Math.floor(config.maxTrackingRefreshBatches));
  if(tasks.length>limit)errors.push("历史报警复核批次达到上限，其余继续待核实；不视为恢复");
  const selected=tasks.slice(0,limit);
  // Cache only finalized batches in this invocation. Interrupted/auth-failed
  // queries never become evidence; fresh attempts resume the unfinished tasks.
  const key=task=>JSON.stringify([config.vendor,task.date,task.batch]);
  const results=new Map(selected.filter(task=>checkpoint.has(key(task))).map(task=>[key(task),checkpoint.get(key(task))]));
  const pending=selected.filter(task=>!results.has(key(task)));
  let completed=results.size,failed=[...results.values()].filter(p=>p.errors.length).length,interrupted=false;
  const active=new Map(),started=Date.now();
  const publish=(running=true)=>{
    const elapsed=Math.round((Date.now()-started)/1000);
    platform.logger?.progress?.({stage,estimated_remaining_seconds:null,recovery:{
      stage,active:running && selected.length>0,status:running?'running':interrupted?'interrupted':errors.length||failed?'incomplete':'completed',
      total:tasks.length,scheduled:selected.length,completed,succeeded:completed-failed,failed,
      skipped:tasks.length-selected.length,issues:errors.length,started_ms:started,elapsed_seconds:elapsed,
      estimated_remaining_seconds:running&&completed?Math.round(elapsed/completed*(selected.length-completed)):running?null:errors.length||failed||interrupted?null:0,
      active_batches:[...active.values()],
    }});
  };
  publish();
  const read=async(queryPlatform,task)=>{
      const {date,batch}=task,index=selected.indexOf(task);
      let result;
      config.signal?.throwIfAborted();
      active.set(index,{batch:index+1,date,sns:batch,stage:'查询并核对报警导出'});publish();
      const start = parsePlatformDateTime(date);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const query = { start, end, startDate: date, endDate: date, reportDate: `${date}_tracking_${index+1}` };
      try {
        const parsed = await downloadAlarmRows(queryPlatform, query, { vendor: config.vendor, start, end }, { bmsNumbers: batch });
        if (parsed.rows.some(r => !batch.includes(String(r["电池组编号"]).trim()))) throw new Error("历史复核返回非目标SN");
        result={rows:parsed.rows,errors:[]};
      } catch (error) {
        config.signal?.throwIfAborted();
        if(error.code==='SESSION_EXPIRED' || error.code==='AUTH_REQUIRED')throw error;
        failed++;
        result={rows:[],errors:[`${date}历史复核失败：${error.message}`]};
      } finally {
        if(result){completed++;results.set(key(task),result);checkpoint.set(key(task),result);}
        active.delete(index);publish();
      }
  };
  // Real platforms provide isolated pages; fixtures/legacy implementations
  // retain sequential execution. Never run concurrent queries on one page.
  try {
  if(platform.mapAlarmQueries)await platform.mapAlarmQueries(pending,read);
  else for(const task of pending)await read(platform,task);
  const parts=selected.map(task=>results.get(key(task)));
  return { rows:parts.flatMap(p=>p.rows), errors:[...errors,...parts.flatMap(p=>p.errors)] };
  } catch(error) {interrupted=true;throw error;}
  finally {publish(false);}
}

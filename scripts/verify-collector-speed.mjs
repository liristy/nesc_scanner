import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { JYPlatform } from '../src/platform.mjs';
import { createRunLogger } from '../src/progress.mjs';
import { atomicWriteJson, parsePlatformDateTime, identityOf } from '../src/utils.mjs';
import { downloadAlarmRows } from '../src/alarm-export.mjs';
import { refreshPreviousAlarms } from '../src/tracking-refresh.mjs';
import { beijingText, shiftDay } from '../src/calendar.mjs';
import { readOnlyCheckTargets } from './check-targets.mjs';

const targetRoot = process.env.JY_CHECK_STATE_DIR || process.env.JY_ALARM_DATA_DIR ||
  fileURLToPath(new URL('../../nesc_report/', import.meta.url));
const sns=await readOnlyCheckTargets(targetRoot, process.env.JY_CHECK_SNS || '');
const reportDate=process.env.JY_CHECK_DATE || shiftDay(beijingText(new Date()).slice(0,10),-1);
if(!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !parsePlatformDateTime(reportDate))throw new Error('验收日期无效');
const config=await loadConfig(),logger=createRunLogger(config.projectRoot);
try {
  const directory=path.join(config.projectRoot,'run','speed-check','http');
  const p=await new JYPlatform({...config,projectRoot:directory},logger).open();
  const started=Date.now();
  const summary={reportDate,transport:'http'};
  try{
    logger.progress({stage:'HTTP 小批次只读验收',completed:0,total:sns.length,succeeded:0,failed:0,pending:sns.length});
    const start=parsePlatformDateTime(reportDate),end=parsePlatformDateTime(shiftDay(reportDate,1));
    const alarm=await downloadAlarmRows(p,{startDate:reportDate,endDate:reportDate,reportDate},
      {vendor:config.vendor,start,end},{bmsNumbers:sns});
    if(alarm.rows.some(row=>!sns.includes(String(row['电池组编号']).trim())))throw new Error('只读报警验证返回非目标设备');
    summary.alarmRows=alarm.allRowCount;
    summary.alarmExportVerified=alarm.allRowCount>0;
    await p.fetchBatterySnapshots(sns,{evidenceSNs:sns,cellSNs:sns,reportDate,endText:`${reportDate} 16:00:00`});
    summary.devices=sns.map(sn=>{
      const evidence=p.heartbeatEvidence.get(sn);
      return {sn,complete:evidence?.complete,rows:evidence?.records?.length,days:evidence?.historyDays?.length||1,
        online:evidence?.detail?.online,cellsComplete:evidence?.detail?.cellsComplete,error:evidence?.error||evidence?.detail?.cellsError};
    });
    summary.seconds=(Date.now()-started)/1000;
  }finally{await p.close();}
  await atomicWriteJson(path.join(config.projectRoot,'run/speed-check/summary.json'),summary);
  if(summary.devices.some(device=>!device.complete || !(device.rows>0) || (device.online!==false && !device.cellsComplete))) {
    throw new Error('只读验收存在心跳或电芯证据缺口');
  }
  if(process.env.JY_CHECK_ALARM_REFRESH==='true') {
    const p=await new JYPlatform(config,logger).open();
    try {
      // Recovery queries verify original alarm dates in full, independently
      // of the heartbeat audit's 16:00 cutoff. No report/state is published.
      const start=parsePlatformDateTime(reportDate),end=parsePlatformDateTime(shiftDay(reportDate,1));
      const read=async(platform,sn,index)=>{
        const query={start,end,startDate:reportDate,endDate:reportDate,reportDate:`${reportDate}_readonly_${index}`};
        const parsed=await downloadAlarmRows(platform,query,{vendor:'JY',start,end},{bmsNumbers:[sn]});
        if(parsed.rows.some(r=>r['电池组编号']!==sn))throw new Error('只读报警复查出现其他SN');
        if(!parsed.rows.length)throw new Error(`${sn}在${reportDate}无报警，不能用空结果证明并发查询隔离；请选择原报警发生日期`);
        return parsed.rows.map(identityOf).sort();
      };
      logger.progress({stage:'报警复查串行对照',estimated_remaining_seconds:null});
      let started=Date.now();const sequential=[];
      for(let i=0;i<sns.length;i++)sequential.push(await read(p,sns[i],i));
      const sequentialSeconds=(Date.now()-started)/1000;
      logger.progress({stage:'报警复查 HTTP 并发对照',estimated_remaining_seconds:null});
      started=Date.now();const parallel=await p.mapAlarmQueries(sns,(worker,sn,index)=>read(worker,sn,index+sns.length));
      summary.alarmRefresh={sequentialSeconds,parallelSeconds:(Date.now()-started)/1000,
        comparisons:sns.map((sn,i)=>({sn,rows:sequential[i].length,equal:JSON.stringify(sequential[i])===JSON.stringify(parallel[i])}))};
      await atomicWriteJson(path.join(config.projectRoot,'run/speed-check/summary.json'),summary);
      if(summary.alarmRefresh.comparisons.some(c=>!c.equal))throw new Error('只读报警复查对照不一致');
      const targets=sequential.flat().map(id=>{const [sn,type,time]=id.split('\0');return {bms_number:sn,alarm_type:type,alarm_time:time};});
      const refreshed=await refreshPreviousAlarms(p,targets,[],config,{stage:'只读报警恢复复查进度验收'});
      const identities=new Set(refreshed.rows.map(identityOf));
      if(refreshed.errors.length || targets.some(t=>!identities.has(identityOf(t))))throw new Error('只读恢复复查仍有原始身份缺口');
      summary.alarmRefresh.recoveryProgressVerified=true;
      await atomicWriteJson(path.join(config.projectRoot,'run/speed-check/summary.json'),summary);
    } finally {await p.close();}
  }
  if(process.env.JY_CHECK_HISTORY==='true') {
    const p=await new JYPlatform({...config,projectRoot:path.join(config.projectRoot,'run/speed-check/history')},logger).open();
    const started=Date.now();
    try {
      logger.progress({stage:'完整历史只读验收',completed:0,total:sns.length,succeeded:0,failed:0,pending:sns.length,estimated_remaining_seconds:null});
      await p.fetchBatterySnapshots(sns,{evidenceSNs:sns,cellSNs:[],reportDate,endText:`${reportDate} 16:00:00`});
      summary.history={seconds:(Date.now()-started)/1000,results:[...p.heartbeatEvidence.values()].map(e=>({sn:e.sn,complete:e.complete,historyComplete:e.historyComplete,days:e.historyDays?.length||1,rows:e.records?.length,error:e.error}))};
      await atomicWriteJson(path.join(config.projectRoot,'run/speed-check/summary.json'),summary);
      if(summary.history.results.length!==sns.length || summary.history.results.some(e=>!e.complete))throw new Error('完整历史验收存在缺口');
    }finally{await p.close();}
  }
  console.info(JSON.stringify({reportDate,devices:sns.length,alarmExportVerified:summary.alarmExportVerified,
    alarmRows:summary.alarmRows,heartbeatRows:summary.devices.reduce((total,device)=>total+device.rows,0),
    cellsComplete:summary.devices.filter(device=>device.cellsComplete).length,seconds:summary.seconds}));
  logger.progress({status:'completed',stage:'HTTP 小批次只读验收通过'});
}catch(error){logger.progress({status:'error',stage:'HTTP 只读验收失败',error:error.message});console.error(error.message);process.exitCode=1;}
finally{await logger.close();}

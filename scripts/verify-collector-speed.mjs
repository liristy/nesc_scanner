import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { JYPlatform } from '../src/platform.mjs';
import { createRunLogger } from '../src/progress.mjs';
import { atomicWriteJson, parsePlatformDateTime, identityOf } from '../src/utils.mjs';
import { downloadAlarmRows } from '../src/alarm-export.mjs';
import { refreshPreviousAlarms } from '../src/tracking-refresh.mjs';
import { beijingText, shiftDay } from '../src/calendar.mjs';
import { readOnlyCheckTargets } from './check-targets.mjs';

const sns=await readOnlyCheckTargets(process.env.JY_ALARM_DATA_DIR || process.cwd(), process.env.JY_CHECK_SNS || '');
const reportDate=process.env.JY_CHECK_DATE || shiftDay(beijingText(new Date()).slice(0,10),-1);
if(!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !parsePlatformDateTime(reportDate))throw new Error('验收日期无效');
const config=await loadConfig(),logger=createRunLogger(config.projectRoot);
const sourceOnly=process.env.JY_CHECK_SOURCE_ONLY==='true';
const results=[];
try {
  for (const transport of sourceOnly?['source']:['source','rendered']) {
    const directory=path.join(config.projectRoot,'run','speed-check',transport);
    const p=await new JYPlatform({...config,projectRoot:directory,heartbeatTransport:transport},logger).open();
    // Compare the real worker pipeline at an identical cutoff, including ten
    // days when low voltage requires them. Worker instances use class methods.
    // No alarm export, report/state publication or customer message is performed.
    const started=Date.now();
    try{
      logger.progress({stage:`只读对照：${transport}`,completed:0,total:sns.length,succeeded:0,failed:0,pending:sns.length,estimated_remaining_seconds:null});
      await p.fetchBatterySnapshots(sns,{evidenceSNs:sns,cellSNs:[],reportDate,endText:`${reportDate} 16:00:00`});
      results.push({transport,seconds:(Date.now()-started)/1000,results:Object.fromEntries(p.heartbeatEvidence)});
    }finally{await p.close();}
  }
  const canonical=e=>(e?.records ?? []).map(r=>JSON.stringify(r)).sort();
  const comparisons=sns.map(sn=>{
    const a=results[0].results[sn],b=results[1]?.results[sn];
    return {sn,sourceComplete:a?.complete,renderedComplete:b?.complete,sourceRows:a?.records?.length,renderedRows:b?.records?.length,
      sourceDays:a?.historyDays?.length||1,renderedDays:b?.historyDays?.length||1,
      equal:sourceOnly?undefined:a?.complete&&b?.complete&&JSON.stringify(canonical(a))===JSON.stringify(canonical(b)),sourceError:a?.error,renderedError:b?.error};
  });
  const summary={reportDate,results:results.map(r=>({transport:r.transport,seconds:r.seconds})),comparisons};
  await atomicWriteJson(path.join(config.projectRoot,'run/speed-check/summary.json'),summary);
  if(comparisons.some(c=>sourceOnly?!c.sourceComplete||!(c.sourceRows>0):!c.equal||!(c.sourceRows>0)||!(c.renderedRows>0))) {
    console.info(JSON.stringify(summary,null,2));
    throw new Error(sourceOnly?'只读验收未取得非空且完整的心跳证据':'新旧心跳证据未取得非空完整且一致的结果');
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
      logger.progress({stage:'报警复查独立页面并发对照',estimated_remaining_seconds:null});
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
    const p=await new JYPlatform({...config,projectRoot:path.join(config.projectRoot,'run/speed-check/history'),heartbeatTransport:'source'},logger).open();
    const started=Date.now();
    try {
      logger.progress({stage:'完整历史只读验收',completed:0,total:sns.length,succeeded:0,failed:0,pending:sns.length,estimated_remaining_seconds:null});
      await p.fetchBatterySnapshots(sns,{evidenceSNs:sns,cellSNs:[],reportDate,endText:`${reportDate} 16:00:00`});
      summary.history={seconds:(Date.now()-started)/1000,results:[...p.heartbeatEvidence.values()].map(e=>({sn:e.sn,complete:e.complete,historyComplete:e.historyComplete,days:e.historyDays?.length||1,rows:e.records?.length,error:e.error}))};
      await atomicWriteJson(path.join(config.projectRoot,'run/speed-check/summary.json'),summary);
      if(summary.history.results.length!==sns.length || summary.history.results.some(e=>!e.complete))throw new Error('完整历史验收存在缺口');
    }finally{await p.close();}
  }
  console.info(JSON.stringify(summary,null,2));
  logger.progress({status:'completed',stage:sourceOnly?'定向只读核查通过':'新旧心跳证据一致'});
}catch(error){logger.progress({status:'error',stage:'只读对照失败',error:error.message});throw error;}
finally{await logger.close();}

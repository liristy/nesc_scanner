import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { runAudit, evidenceName } from '../src/audit-runner.mjs';
import { atomicWriteJson, readJson } from '../src/utils.mjs';
import { reportScheduleDecision } from '../scripts/report-schedule-gate.mjs';
import { collectionContinuation } from '../scripts/continue-collection.mjs';
import { prepare, finalize } from '../scripts/cloud-runtime.mjs';
import { analyzeWeek } from '../src/audit-rules.mjs';

const logger={info(){},warn(){},progress(){}};
const headers=['最早报警时间','修复时间','电池组编号','报警（级别：类型）','处理状态','BMS厂商'];
const row=(sn,type='短路',time='2026-09-28 12:00:00')=>Object.fromEntries(headers.map((h,i)=>[h,[time,'',sn,`保护:${type}`,'未处理','JY'][i]]));
const detail={detailVersion:2,bms:'F1-real',model:'real-model',cellsComplete:true,cells:[{index:1,voltage:3.4}],online:true};
async function workbook(rows) {
  const zip=new JSZip();
  zip.file('xl/worksheets/sheet1.xml',`<worksheet><sheetData>${[headers,...rows.map(r=>headers.map(h=>r[h]))].map((r,n)=>
    `<row>${r.map((v,i)=>`<c r="${String.fromCharCode(65+i)}${n+1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  return zip.generateAsync({type:'nodebuffer'});
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-current-day-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await atomicWriteJson(path.join(root,'github-config.json'),{auditPolicy:'current_day_pending'});
  await atomicWriteJson(path.join(root,'state/current_tracking.json'),{last_success_cutoff:'2026-09-25 16:00:00',items:[]});
  const old={startText:'2026-09-25 16:00:00',endText:'2026-09-26 16:00:00',reportDate:'2026-09-26',publishReport:false};
  await atomicWriteJson(path.join(root,'state/pending_audit.json'),old);
  await atomicWriteJson(path.join(root,'run/pending-audit.json'),old);
  return {projectRoot:root,auditPolicy:'current_day_pending',vendor:'JY',maxTrackingRefreshBatches:100,
    paths:{state:path.join(root,'state/current_tracking.json'),reports:path.join(root,'reports'),dailyReports:path.join(root,'reports/daily_reports'),data:path.join(root,'data'),lastResult:path.join(root,'run/last-result.json')}};
}
test('当天调度忽略历史失败截止；重复当天跳过；跨天完成也不追加补跑',async t=>{
  const config=await fixture(t),root=config.projectRoot;
  // Obsolete pending metadata must not even require an old year's calendar.
  await atomicWriteJson(path.join(root,'state/pending_audit.json'),{reportDate:'2025-12-31',endText:'2025-12-31 16:00:00'});
  const now=new Date('2026-09-28T16:35:00+08:00');
  const decision=await reportScheduleDecision({root,now});
  assert.equal(decision.window.startText,'2026-09-27 16:00:00');
  assert.equal(decision.window.endText,'2026-09-28 16:00:00');
  await prepare(root,now);
  await atomicWriteJson(config.paths.lastResult,{status:'success',period:{end_inclusive:decision.window.endText}});
  await atomicWriteJson(config.paths.state,{last_success_cutoff:decision.window.endText,items:[]});
  await atomicWriteJson(path.join(root,'state/daily_collection.json'),{last_collection_cutoff:decision.window.endText});
  assert.equal((await finalize(root,{artifactId:'10',runId:'20',monitorOutcome:'success'})).complete,true);
  assert.equal((await reportScheduleDecision({root,now})).should_run,false);
  assert.equal((await collectionContinuation({root,now:new Date('2026-09-29T16:35:00+08:00')})).should_run,false);
  assert.equal((await reportScheduleDecision({root,now:new Date('2026-09-29T16:35:00+08:00')})).window.startText,decision.window.endText);
});

test('重跑统计沿用前日基线，历史缺口沿用最新保存状态，已解决旧跟进不重新加入',async t=>{
  const config=await fixture(t),oldTime='2026-09-27 12:00:00';
  const old={sn:'resolved',type:'电量不足',time:oldTime,vendor:'JY',level:'保护',bms_number:'resolved',alarm_time:oldTime,
    review:{kind:'reading_pending',reason:'旧分页失败'}};
  const missing={...old,sn:'missing',bms_number:'missing',review:undefined};
  const current=row('new','电量不足','2026-09-28 12:00:00');
  await atomicWriteJson(config.paths.state,{last_success_cutoff:'2026-09-27 16:00:00',items:[old,missing]});
  await atomicWriteJson(path.join(config.projectRoot,'run/daily/collection.json'),{complete:true,endText:'2026-09-28 16:00:00',items:[
    {...old,review:undefined,lowVoltage:analyzeWeek({complete:true,records:[{time:'2026-09-28 15:00:00',minVoltage:3.4,maxVoltage:3.5}]},'2026-09-28 16:00:00')},
    {...missing,review:{kind:'reading_pending',status:'待确认',reason:'有效电压证据缺失或异常，不能判正常'}},
    {sn:'new',type:'电量不足',time:'2026-09-28 12:00:00',vendor:'JY',level:'保护',bms_number:'new',alarm_time:'2026-09-28 12:00:00'}]});
  await atomicWriteJson(path.join(config.projectRoot,'跟踪数据',evidenceName('missing')),{sn:'missing',cutoff:'2026-09-28 16:00:00',snapshot:{detail},evidence:{complete:true,records:[],detail}});
  const reads=[];
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      const rows=bmsNumbers.length?[current,row('missing','电量不足',oldTime),{...row('resolved','电量不足',oldTime),'修复时间':'2026-09-28 10:00:00'}]
        .filter(a=>bmsNumbers.includes(a['电池组编号'])):[current];
      return {buffer:await workbook(rows),resultCount:rows.length};
    }
    async fetchBatterySnapshots(sns) {
      reads.push(...sns);this.heartbeatEvidence=new Map(sns.map(sn=>[sn,{complete:true,records:[{time:'2026-09-28 15:00:00',minVoltage:3.4,maxVoltage:3.5}],detail}]));
      return new Map(sns.map(sn=>[sn,{detail}]));
    }
  }
  await runAudit(config,logger,{now:new Date('2026-09-28T16:35:00+08:00'),Platform,retryOptions:{delays:[]}});
  const state=await readJson(config.paths.state);
  assert.deepEqual(reads,['new']);assert.ok(!state.items.some(a=>a.sn==='resolved'));
  assert.match(state.items.find(a=>a.sn==='missing').review.reason,/有效电压证据缺失/);
  assert.equal(state.items.find(a=>a.sn==='new').origin,'本区间新增');
});

test('历史报警已恢复后仅保留独立低压风险，正常电量不足不读取、不写回跟踪',async t=>{
  const config=await fixture(t),oldTime='2026-09-27 12:00:00';
  const prior=['normal','low'].map(sn=>({sn,type:'电量不足',time:oldTime,vendor:'JY',level:'保护',
    bms_number:sn,alarm_time:oldTime,origin:'历史延续',lowVoltage:analyzeWeek({complete:true,records:[
      {time:'2026-09-27 15:00:00',minVoltage:sn==='normal'?3.4:2.4,maxVoltage:3.5}]},'2026-09-27 16:00:00')}));
  await atomicWriteJson(config.paths.state,{last_success_cutoff:'2026-09-27 16:00:00',items:prior});
  const queried=[];
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      const rows=bmsNumbers.length?bmsNumbers.map(sn=>({...row(sn,'电量不足',oldTime),'修复时间':'2026-09-28 10:00:00'})):[];
      return {buffer:await workbook(rows),resultCount:rows.length};
    }
    async fetchBatterySnapshots(sns) {
      queried.push(...sns);
      this.heartbeatEvidence=new Map(sns.map(sn=>[sn,{complete:true,records:[{time:'2026-09-28 15:00:00',minVoltage:2.4,maxVoltage:3.5}],detail}]));
      return new Map(sns.map(sn=>[sn,{detail}]));
    }
  }
  const progress=[];
  await runAudit(config,{...logger,progress:p=>progress.push(p)},{now:new Date('2026-09-28T16:35:00+08:00'),Platform,retryOptions:{delays:[]}});
  assert.deepEqual(queried,[]);
  const state=await readJson(config.paths.state);
  assert.deepEqual(state.items.map(a=>a.sn),['low']);assert.equal(state.items[0].followupOnly,true);
  assert.deepEqual(progress.find(p=>p.collection_scope).collection_scope,{current_window:0,history_only:0,total:0,skipped_recovered_normal:1,history_recovery_only:1,tracked_total:1});
});

for(const failure of ['cells','heartbeat','summary','empty_voltage','recovery','bms','timeout'])test(`读取失败直接待确认，不重试、不确认风险、不充当趋势基线：${failure}`,async t=>{
  const config=await fixture(t),sn='SN-pending';let reads=0,opens=0;
  const expectedStatus=['recovery','timeout'].includes(failure)?'待验证':'待确认';
  const alarm=row(sn,failure==='cells'?'单体压差过大':'电量不足');
  class Platform {
    async open(){opens++;} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      if(bmsNumbers.length && failure==='recovery')throw new Error('恢复查询 Timeout');
      if(!bmsNumbers.length)assert.equal(query.startText,'2026-09-27 16:00:00');
      return {buffer:await workbook([alarm]),resultCount:1};
    }
    async fetchBatterySnapshots() {
      reads++;
      const d={...detail,...(failure==='cells'?{cellsComplete:false,cells:[],cellsError:'执行指令错误'}:{}),...(failure==='bms'?{bms:''}:{})};
      const records=failure==='empty_voltage'?[]:[{time:'2026-09-28 15:00:00',minVoltage:3.4,maxVoltage:3.5,event:''}];
      this.heartbeatEvidence=new Map([[sn,{complete:!['heartbeat','timeout'].includes(failure),error:failure==='heartbeat'?'分页未完整读取':failure==='timeout'?'基本信息标签页等待超时（45秒）':undefined,historyComplete:false,records,detail:d}]]);
      return failure==='summary'?new Map():new Map([[sn,{detail:d}]]);
    }
  }
  const progress=[];
  const result=await runAudit(config,{...logger,progress:p=>progress.push(p)},{now:new Date('2026-09-28T16:35:00+08:00'),Platform,
    retryOptions:{wait:async()=>assert.fail('对象读取失败不应重试')}});
  assert.equal(result.status,'success');assert.equal(result.pending_review_count,1);assert.equal(reads,1);assert.equal(opens,1);
  assert.equal(result.period.start,'2026-09-27 16:00:00');
  const state=await readJson(config.paths.state);
  assert.equal(state.last_success_cutoff,'2026-09-28 16:00:00');assert.equal(state.items[0].review.status,expectedStatus);
  const raw=await readJson(path.join(config.paths.data,'2026-09-28_alarm_data.json'));
  assert.equal(raw.audit.complete,true);assert.equal(raw.audit.evidence_complete,false);assert.equal(raw.audit.confirmed,0);
  assert.notEqual(raw.audit.items[0].lowVoltage?.confirmed,true);
  assert.equal((await readJson(path.join(config.paths.reports,'型号趋势历史.json'))).at(-1).complete,false);
  assert.match(await fs.readFile(path.join(config.paths.reports,'电池报警复核清单.md'),'utf8'),new RegExp('分类：'+expectedStatus));
  assert.equal(progress.at(-1).pending,1);assert.equal(progress.at(-1).succeeded,0);
  const saved=await readJson(path.join(config.projectRoot,'跟踪数据',evidenceName(sn)));
  assert.equal(saved.alarms[0].review.status,expectedStatus);assert.ok(Array.isArray(saved.evidence.records));
  if(failure==='timeout'){assert.equal(saved.evidence.complete,false);assert.equal(progress.at(-1).pending_verification_count,1);}
  if(failure==='recovery'){assert.equal(raw.audit.items[0].review.recoveryPending,true);assert.equal(raw.record_count,0);}
});

test('休息日待确认及未恢复对象从最新每日跟踪延续；新日报只导出当天窗口',async t=>{
  const config=await fixture(t),queries=[];
  const old=row('holiday','短路','2026-10-11 15:00:00');let day='2026-10-11',fail=true;
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      if(!bmsNumbers.length)queries.push(query);
      const rows=bmsNumbers.length || day==='2026-10-11'?[old]:[];
      return {buffer:await workbook(rows),resultCount:rows.length};
    }
    async fetchBatterySnapshots(sns) {
      assert.deepEqual(sns,day==='2026-10-11'?['holiday']:[]);
      this.heartbeatEvidence=new Map(sns.map(sn=>[sn,{complete:!fail,records:[{time:`${day} 15:00:00`,minVoltage:3.4,maxVoltage:3.5,event:''}],detail,error:fail?'Timeout':undefined}]));
      return new Map(sns.map(sn=>[sn,{detail}]));
    }
  }
  const run=()=>runAudit(config,logger,{now:new Date(`${day}T16:35:00+08:00`),Platform,retryOptions:{delays:[]}});
  assert.equal((await run()).pending_review_count,1);
  day='2026-10-12';fail=false;
  assert.equal((await run()).pending_review_count,1);
  const state=await readJson(config.paths.state);
  assert.equal(state.items[0].sn,'holiday');assert.equal(state.items[0].origin,'历史延续');assert.equal(state.items[0].review.status,'待验证');
  assert.equal(state.items[0].historicalReview.lastEvidenceCutoff,'2026-10-11 16:00:00');
  assert.equal(queries[1].startText,'2026-10-11 16:00:00');assert.equal(queries[1].endText,'2026-10-12 16:00:00');
});

test('历史轻量复核保留原始截止和风险；跨日不重新确认旧电压，当天重新报警时恢复完整读取',async t=>{
  const config=await fixture(t),sn='old-risk',time='2026-09-27 12:00:00';let day='2026-09-28';const queries=[],reads=[];
  const records=Array.from({length:8},(_,i)=>({time:`2026-09-${20+i} 15:00:00`,minVoltage:2.4,maxVoltage:3.5,event:'保护:电量不足'}));
  records.push({time:'2026-09-20 15:00:00',minVoltage:2.4,maxVoltage:3.5,event:'进入低功耗'});
  const rawEvidence={complete:true,historyComplete:true,records,detail};
  const old={sn,type:'电量不足',time,vendor:'JY',level:'保护',bms_number:sn,alarm_time:time,detail,
    lowVoltage:analyzeWeek(rawEvidence,'2026-09-27 16:30:00')};
  assert.equal(old.lowVoltage.confirmed,true);
  await atomicWriteJson(config.paths.state,{last_success_cutoff:'2026-09-27 16:30:00',items:[old]});
  await atomicWriteJson(path.join(config.projectRoot,'跟踪数据',evidenceName(sn)),{sn,cutoff:'2026-09-27 16:30:00',snapshot:{detail},evidence:rawEvidence,alarms:[old]});
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      queries.push({day,bmsNumbers});
      const current=day==='2026-09-30'?row(sn,'电量不足',day+' 12:00:00'):null;
      const rows=bmsNumbers.length?[row(sn,'电量不足',time),...(current?[current]:[])]:current?[current]:[];
      return {buffer:await workbook(rows),resultCount:rows.length};
    }
    async fetchBatterySnapshots(sns) {
      if(sns.length)reads.push({day,sns});
      this.heartbeatEvidence=new Map(sns.map(sn=>[sn,{complete:true,historyComplete:false,records:[{time:day+' 15:00:00',minVoltage:3.4,maxVoltage:3.5}],detail}]));
      return new Map(sns.map(sn=>[sn,{detail}]));
    }
  }
  for(day of ['2026-09-28','2026-09-29','2026-09-30']) {
    const progress=[];
    const result=await runAudit(config,{...logger,progress:p=>progress.push(p)},{now:new Date(day+'T16:35:00+08:00'),Platform,retryOptions:{delays:[]}});
    const saved=await readJson(path.join(config.projectRoot,'跟踪数据',evidenceName(sn)));
    const state=await readJson(config.paths.state),raw=await readJson(path.join(config.paths.data,day+'_alarm_data.json'));
    if(day!=='2026-09-30') {
      assert.equal(raw.audit.confirmed,0);assert.equal(raw.today_heartbeat_evidence[sn].complete,false);
      assert.equal(state.items[0].lowVoltage.historicalConfirmed,true);assert.equal(state.items[0].historicalReview.lastEvidenceCutoff,'2026-09-27 16:30:00');
      assert.equal(saved.evidence.coverageCutoff,'2026-09-27 16:30:00');assert.deepEqual(saved.evidence.records,records);
      const end=progress.at(-1);assert.equal(end.total,0);assert.equal(end.failed,0);assert.equal(end.succeeded,0);
      assert.match(await fs.readFile(path.join(config.paths.reports,'今日电池报警简报.md'),'utf8'),/历史已确认风险待跟进/);
    } else {
      assert.equal(state.items[0].historicalReview,undefined);assert.equal(saved.evidence.carried,undefined);
      assert.equal(saved.evidence.records[0].time,day+' 15:00:00');assert.equal(result.pending_review_count,0);
    }
  }
  assert.deepEqual(reads,[{day:'2026-09-30',sns:[sn]}]);assert.ok(queries.filter(q=>q.bmsNumbers.length).length>=6);
});

test('全量报警覆盖失败或会话失效仍判失败，不能伪造空日报',async t=>{
  for(const kind of ['alarm','auth']) {
    const config=await fixture(t);
    class Platform {
      async open(){} async close(){}
      async queryAlarmAndDownload(){if(kind==='alarm')throw new Error('全量导出失败');return {buffer:await workbook([row('SN')]),resultCount:1};}
      async fetchBatterySnapshots(){this.sessionState={expired:true};return new Map();}
    }
    await assert.rejects(runAudit(config,logger,{now:new Date('2026-09-28T16:35:00+08:00'),Platform,retryOptions:{delays:[]}}),kind==='alarm'?/全量导出失败/:/会话失效/);
    assert.equal((await readJson(config.paths.state)).last_success_cutoff,'2026-09-25 16:00:00');
  }
});

test('最终复查会话中断后只续查未完成批次，设备待确认不重采，阶段不退回采集',async t=>{
  const config=await fixture(t),queries=[],progress=[];
  const alarms=[row('A','短路','2026-09-27 17:00:00'),row('B')];
  let opens=0,reads=0,interrupt=true;
  class Platform {
    constructor(config,logger){this.logger=logger;}
    async open(){opens++;} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      queries.push([...bmsNumbers]);
      if(bmsNumbers.includes('B') && interrupt){interrupt=false;throw Object.assign(new Error('登录失效'),{code:'SESSION_EXPIRED'});}
      const rows=bmsNumbers.length?alarms.filter(r=>bmsNumbers.includes(r['电池组编号'])):alarms;
      return {buffer:await workbook(rows),resultCount:rows.length};
    }
    async fetchBatterySnapshots(sns){
      reads++;this.heartbeatEvidence=new Map(sns.map(sn=>[sn,{complete:false,records:[],detail,error:'本轮读取超时'}]));
      return new Map(sns.map(sn=>[sn,{detail}]));
    }
  }
  const result=await runAudit(config,{...logger,progress:p=>progress.push(p)},{now:new Date('2026-09-28T16:35:00+08:00'),Platform,
    retryOptions:{delays:[0],wait:async()=>{}}});
  assert.equal(result.status,'success');assert.equal(opens,2);assert.equal(reads,1);
  assert.deepEqual(queries,[[],['A'],['B'],['B']]);
  assert.equal(result.pending_review_count,2);
  const recoveryStart=progress.findIndex(p=>p.phase==='recovery');
  assert.ok(recoveryStart>0);
  assert.ok(progress.slice(recoveryStart).every(p=>!['scope','collection'].includes(p.phase)));
  const resumed=progress.filter(p=>p.recovery?.active);
  assert.ok(resumed.some(p=>p.recovery.completed===1 && p.recovery.total===2));
  assert.equal(progress.filter(p=>p.recovery).at(-1).recovery.completed,2);
});

test('采集中会话失效只续采中断及未开始设备，离线和超时结果保留，最终恢复仍重新查询',async t=>{
  const config=await fixture(t),queries=[],reads=[],progress=[];
  const old={sn:'H',type:'短路',time:'2026-09-26 12:00:00',vendor:'JY',level:'保护',bms_number:'H',alarm_time:'2026-09-26 12:00:00'};
  await atomicWriteJson(config.paths.state,{last_success_cutoff:'2026-09-27 16:00:00',items:[old]});
  const alarms=[row('A','单体压差过大'),row('B'),row('C'),row('D')];
  let attempts=0;
  const good=extra=>({complete:true,records:[{time:'2026-09-28 15:00:00',minVoltage:3.4,maxVoltage:3.5}],detail,...extra});
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      queries.push([...bmsNumbers]);
      const rows=bmsNumbers.length?[row('H','短路',old.time),...alarms].filter(r=>bmsNumbers.includes(r['电池组编号'])):alarms;
      return {buffer:await workbook(rows),resultCount:rows.length};
    }
    async fetchBatterySnapshots(sns,options) {
      reads.push([...sns]);attempts++;
      if(attempts===1) {
        this.heartbeatEvidence=new Map([
          ['A',good({detail:{...detail,online:false,cellsComplete:false,cells:[],cellsError:'设备离线'}})],
          ['B',{complete:false,records:[],detail,error:'Timeout 45000ms exceeded',errorCode:'DETAIL_TAB_TIMEOUT'}],
          ['C',{complete:false,records:[],error:'登录失效',errorCode:'SESSION_EXPIRED'}],
          ['D',{complete:false,attempted:false,records:[],error:'尚未读取'}],
        ]);
        this.lastSnapshots=new Map(['A','B','C'].map(sn=>[sn,{detail:this.heartbeatEvidence.get(sn).detail}]));
        this.sessionState={expired:true};
        throw Object.assign(new Error('登录失效'),{code:'SESSION_EXPIRED'});
      }
      assert.equal(options.progressCompleted,2);assert.equal(options.progressFailed,1);
      this.heartbeatEvidence=new Map(sns.map(sn=>[sn,good()]));
      return new Map(sns.map(sn=>[sn,{detail}]));
    }
  }
  const result=await runAudit(config,{...logger,progress:p=>progress.push(p)},{now:new Date('2026-09-28T16:35:00+08:00'),Platform,
    retryOptions:{delays:[0],wait:async()=>{}}});
  assert.equal(result.status,'success');assert.deepEqual(reads,[['A','B','C','D'],['C','D']]);
  assert.deepEqual(queries,[[],['H'],['H'],['A','B','C','D']]);
  assert.ok(progress.some(p=>p.phase==='collection'&&p.completed===2&&p.heartbeat_complete===1&&p.failed===1&&p.pending===3));
  const state=await readJson(config.paths.state),pending=state.items.find(a=>a.sn==='B');
  assert.equal(pending.review.status,'待验证');assert.match(pending.review.reason,/Timeout/);
  const saved=await readJson(path.join(config.projectRoot,'跟踪数据',evidenceName('B')));
  assert.equal(saved.evidence.complete,false);
  assert.equal(state.items.find(a=>a.sn==='A').detail.online,false);
});

test('前置恢复复查中断后只补未完成批次，最终复查独立刷新已查批次',async t=>{
  const config=await fixture(t),queries=[];
  const old=['2026-09-25','2026-09-26'].map((date,i)=>({sn:`H${i}`,type:'短路',time:date+' 12:00:00',vendor:'JY',level:'保护',bms_number:`H${i}`,alarm_time:date+' 12:00:00'}));
  await atomicWriteJson(config.paths.state,{last_success_cutoff:'2026-09-27 16:00:00',items:old});
  let interrupted=false,reads=0;
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      queries.push([...bmsNumbers]);
      if(bmsNumbers.includes('H1')&&!interrupted){interrupted=true;throw Object.assign(new Error('登录失效'),{code:'SESSION_EXPIRED'});}
      const rows=bmsNumbers.length?old.filter(a=>bmsNumbers.includes(a.sn)).map(a=>row(a.sn,a.type,a.time)):[];
      return {buffer:await workbook(rows),resultCount:rows.length};
    }
    async fetchBatterySnapshots(){reads++;this.heartbeatEvidence=new Map();return new Map();}
  }
  await runAudit(config,logger,{now:new Date('2026-09-28T16:35:00+08:00'),Platform,retryOptions:{delays:[0],wait:async()=>{}}});
  assert.deepEqual(queries,[[],['H0'],['H1'],['H1'],['H0'],['H1']]);assert.equal(reads,1);
});

test('完整一周低压证据仍需读取状态确认；失败电芯的部分越界读数不用于排除',async t=>{
  for(const cellsComplete of [false,true]) {
    const config=await fixture(t),sn='week-risk';
    class Platform {
      async open(){} async close(){}
      async queryAlarmAndDownload(){return {buffer:await workbook([row(sn,'单体压差过大')]),resultCount:1};}
      async fetchBatterySnapshots() {
        const records=Array.from({length:10},(_,i)=>({time:`2026-09-${19+i} 15:00:00`,minVoltage:2.4,maxVoltage:2.5,event:'保护:电量不足'}));
        records.push({time:'2026-09-19 15:00:00',minVoltage:2.4,maxVoltage:2.5,event:'进入低功耗'});
        const d={...detail,cellsComplete,cells:cellsComplete?detail.cells:[{index:1,voltage:2.1}],cellsError:cellsComplete?undefined:'部分电芯读取失败'};
        this.heartbeatEvidence=new Map([[sn,{complete:true,historyComplete:true,records,detail:d}]]);
        return new Map([[sn,{detail:d}]]);
      }
    }
    const result=await runAudit(config,logger,{now:new Date('2026-09-28T16:35:00+08:00'),Platform,retryOptions:{delays:[]}});
    const raw=await readJson(path.join(config.paths.data,'2026-09-28_alarm_data.json'));
    assert.equal(result.pending_review_count,cellsComplete?0:1);
    assert.equal(raw.audit.confirmed,cellsComplete?1:0);
    assert.equal(raw.audit.items[0].excluded,false);
    assert.equal(raw.audit.items[0].difference.status,cellsComplete?'保留':'待复核');
  }
});

test('当天待确认报告保存失败仍不推进截止、不删除原跟踪证据',async t=>{
  const config=await fixture(t);
  await fs.mkdir(path.join(config.paths.reports,'今日电池报警简报.md'),{recursive:true});
  await atomicWriteJson(path.join(config.projectRoot,'跟踪数据',evidenceName('old')),{sn:'old',evidence:{complete:false,records:[]}});
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(){return {buffer:await workbook([row('SN')]),resultCount:1};}
    async fetchBatterySnapshots(){this.heartbeatEvidence=new Map([['SN',{complete:false,records:[],error:'Timeout'}]]);return new Map();}
  }
  await assert.rejects(runAudit(config,logger,{now:new Date('2026-09-28T16:35:00+08:00'),Platform,retryOptions:{delays:[]}}));
  assert.equal((await readJson(config.paths.state)).last_success_cutoff,'2026-09-25 16:00:00');
  assert.equal((await readJson(path.join(config.projectRoot,'跟踪数据',evidenceName('old')))).sn,'old');
});

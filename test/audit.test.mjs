import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { buildAuditWindow, isChinaWorkday, chinaDate, shiftDay } from '../src/calendar.mjs';
import { collectAlarms, classifyDifference, analyzeWeek, bmsSoftwareVersion } from '../src/audit-rules.mjs';
import { buildAuditReports, buildTrends, reportHtml } from '../src/audit-report.mjs';
import { saveAuditOutputs, evidenceName, withAuditRetries, runAudit } from '../src/audit-runner.mjs';
import { checkpointPath, evidenceSummary, hydrateEvidence } from '../src/evidence-store.mjs';
import { readPrivate, savePrivate } from '../src/private-store.mjs';
import { parseAlarmWorkbook } from '../src/xlsx.mjs';

const window=buildAuditWindow(new Date('2026-09-28T08:00:01Z'),{last_success_cutoff:'2026-09-24 16:00:00'});
const row=(sn='SN-A',type='电量不足',time='2026-09-28 12:00:00',extra={})=>({'电池组编号':sn,'报警（级别：类型）':`保护:${type}`,'最早报警时间':time,'修复时间':'','BMS厂商':'JY','处理状态':'未处理',...extra});
const week=(voltage='2.49')=>({complete:true,historyComplete:true,records:[...Array.from({length:8},(_,i)=>({time:`${shiftDay('2026-09-28',i-7)} 15:00:00`,event:'保护:电量不足',minVoltage:voltage,maxVoltage:'3.0'})),{time:'2026-09-21 15:01:00',event:'进入低功耗',minVoltage:''}]});
const threeDays=(voltage='2.579')=>({complete:true,historyComplete:true,records:[...Array.from({length:4},(_,i)=>({time:`${shiftDay('2026-09-28',i-3)} 15:00:00`,event:'保护:电量不足',minVoltage:voltage,maxVoltage:'3.0'})),{time:'2026-09-25 15:01:00',event:'进入低功耗',minVoltage:''}]});
const detail={detailVersion:2,bms:'F100-real',bmsSoftwareVersion:'SW-1.2.3',model:'48X6',customer:'客户甲',site:'站点一',cells:[{index:1,voltage:2.7},{index:2,voltage:4.2}],cellsComplete:true,collectedAt:'2026-09-28 17:00:00',url:'https://cloud.cnano.com.cn/Reports/BatteryInfo/BatteryView?id=fixture'};

test('高频报警保持连续三天规则，回升只切断对应报警链，分析不逐报警扫描全部采样',()=>{
  const start=Date.parse('2026-09-26T16:00:00Z'),end='2026-10-04 16:00:00';
  const records=Array.from({length:20001},(_,i)=>({time:new Date(start+i*8*86400000/20000).toISOString().slice(0,19).replace('T',' '),event:'保护:电量不足',minVoltage:'2.4',maxVoltage:'3.1'}));
  const sleep={...records[0],event:'进入低功耗'};
  const e={complete:true,historyComplete:true,records:[...records,sleep]};
  const result=analyzeWeek(e,end);assert.equal(result.confirmed,true);assert.equal(result.spanHours,192);assert.equal(result.minimumVoltage,2.4);
  const recovered=analyzeWeek({...e,records:[...e.records,{time:'2026-10-03 16:00:00',event:'',minVoltage:'2.8',maxVoltage:'3.1'}]},end);
  assert.equal(recovered.confirmed,false);assert.ok(recovered.spanHours<=24);
  const afterLastAlarm=analyzeWeek({...e,records:[...e.records,{time:'2026-10-04 16:00:01',event:'',minVoltage:'2.8',maxVoltage:'3.1'}]},end);
  assert.equal(afterLastAlarm.confirmed,true);
});
test('法定休息日、周末补班、固定北京时间截止及失败连续区间',()=>{
  assert.equal(isChinaWorkday('2026-09-20'),true);assert.equal(isChinaWorkday('2026-09-25'),false);assert.equal(isChinaWorkday('2026-10-10'),true);
  assert.equal(buildAuditWindow(new Date('2026-09-27T10:00:00Z')).endText,'2026-09-24 16:00:00');
  assert.equal(window.startText,'2026-09-24 16:00:00');assert.equal(window.endText,'2026-09-28 16:00:00');
  assert.equal(buildAuditWindow(new Date('2026-09-28T07:59:59Z'),{last_success_cutoff:'2026-09-24 16:00:00'}).alreadyComplete,true);
  assert.equal(buildAuditWindow(new Date('2026-09-28T08:00:00Z'),{last_success_cutoff:'2026-09-18 16:00:00'}).startText,'2026-09-18 16:00:00');
  assert.throws(()=>isChinaWorkday('2027-01-04'),/日历未配置/);
});
test('JY及保护优先过滤、仅两项、同电池同类型取最新、恢复复查不扩大截止',()=>{
  const rows=[row(),row('SN-A','电量不足','2026-09-28 15:00:00'),row('SN-A','单体压差过大'),row('SN-B','电量不足',undefined,{'BMS厂商':'OTHER'}),row('SN-C','电量不足',undefined,{'报警（级别：类型）':'提示:电量不足'}),...['物联网模块已解绑','物联网卡号变更','BMS编号异常'].map(t=>row('SN-D',t)),row('boundary','电量不足',window.startText),row('end','电量不足',window.endText),row('future','电量不足','2026-09-28 16:00:01')];
  const result=collectAlarms(rows,[],[row('SN-A','单体压差过大',undefined,{'修复时间':'2026-09-28 16:00:00'}),row('new-after','电量不足','2026-09-28 17:00:00')],window,'2026-09-28 18:00:00');
  assert.deepEqual(result.alarms.map(a=>[a.sn,a.time]),[['SN-A','2026-09-28 15:00:00'],['end',window.endText]]);assert.equal(result.recovered.length,1);
});
test('压差边界含等号，使用真实BMS体系，资料不足不能判正常',()=>{
  assert.equal(classifyDifference(detail).status,'保留');
  assert.equal(classifyDifference({...detail,cells:[{index:1,voltage:2.699}]}).status,'排除待复核');
  assert.equal(classifyDifference({...detail,bms:'F3-real',cells:[{index:1,voltage:2.6},{index:2,voltage:3.6}]}).status,'保留');
  assert.equal(classifyDifference({...detail,bms:'unknown'}).status,'待复核');
  assert.equal(classifyDifference({...detail,cellsComplete:false}).status,'待复核');
});
test('同一旧问题重复上报仍算延续；旧事件已恢复后新事件才算新增',()=>{
  const previous={sn:'SN-A',type:'电量不足',time:'2026-09-24 12:00:00',vendor:'JY',level:'保护'};
  let result=collectAlarms([row()], [previous], [row('SN-A','电量不足',previous.time)],window,'2026-09-28 18:00:00');
  assert.equal(result.alarms[0].origin,'历史延续');assert.equal(result.alarms[0].time,'2026-09-28 12:00:00');
  result=collectAlarms([row()], [previous], [row('SN-A','电量不足',previous.time,{'修复时间':'2026-09-24 13:00:00'})],window,'2026-09-28 18:00:00');
  assert.equal(result.alarms[0].origin,'本区间新增');
});
test('三天证据满足72小时，低功耗不清除电量不足，2.58V严格边界',()=>{
  const result=analyzeWeek(threeDays(),window.endText);assert.equal(result.confirmed,true);assert.equal(result.spanHours,72);assert.equal(result.notification,'待通知');
  assert.equal(analyzeWeek(threeDays('2.50'),window.endText).confirmed,true);
  assert.equal(analyzeWeek(threeDays('2.58'),window.endText).confirmed,false);
  assert.equal(analyzeWeek(threeDays('2.59'),window.endText).confirmed,false);
  const short=threeDays();short.records[0].time='2026-09-25 15:00:01';
  assert.equal(analyzeWeek(short,window.endText).confirmed,false);
  assert.equal(analyzeWeek(week('2.79'),window.endText).status,'低压保电观察');
  assert.notEqual(analyzeWeek(week('2.80'),window.endText).status,'低压保电观察');
});
test('单点、24小时缺口、回升、提示、异常数据、历史不全、低功耗缺失均不能冒充连续三天',()=>{
  const cases=[];
  let e=threeDays();e.records=e.records.slice(-2);cases.push(e);
  e=threeDays();e.records.splice(1,1);cases.push(e);
  e=threeDays();e.records.push({time:'2026-09-25 18:00:00',minVoltage:'2.8',event:'心跳数据'});cases.push(e);
  e=threeDays();e.records[1].event='提示:电量不足';cases.push(e);
  e=threeDays();e.records[1].abnormal=true;cases.push(e);
  e=threeDays();e.historyComplete=false;cases.push(e);
  e=threeDays();e.complete=false;cases.push(e);
  e=threeDays();e.records.pop();cases.push(e);
  for(const sample of cases)assert.equal(analyzeWeek(sample,window.endText).confirmed,false);
  e=week();e.records.push({time:'2026-09-28 15:30:00',minVoltage:'4.2',event:'异常数据'});assert.equal(analyzeWeek(e,window.endText).minVoltage,2.49);
  e=week();e.records.push({time:'2026-09-28 15:00:00',minVoltage:'2.7',event:'心跳数据'});assert.equal(analyzeWeek(e,window.endText).confirmed,false);
});
test('型号趋势拆分逐日，仅比较新增，历史缺口不能认定突增，保留35日汇总',()=>{
  const hist=Array.from({length:40},(_,i)=>({date:shiftDay('2026-09-27',-i),cutoffTime:'16:00',complete:true,groups:[]}));
  const alarms=Array.from({length:3},(_,i)=>({sn:`s${i}`,type:'电量不足',time:'2026-09-28 12:00:00',origin:'本区间新增',detail}));
  alarms.push({sn:'old',type:'电量不足',time:'2026-09-28 12:00:00',origin:'历史延续',detail});
  const result=buildTrends(alarms,window,hist);
  assert.equal(result.groups[0].count,3);assert.equal(result.groups[0].label,'新增集中出现');assert.equal(result.history.length,35);
  assert.equal(buildTrends(alarms,{...window,startDate:'2026-09-27',startText:'2026-09-27 16:00:00'},[]).groups[0].label,'历史不足、型号缺失或覆盖不全');
  assert.equal(buildTrends(alarms,window,hist,false).groups[0].label,'历史不足、型号缺失或覆盖不全');
  assert.equal(JSON.stringify(result.history).includes('s0'),false);
  const oldHistory=hist.map(day=>({...day,cutoffTime:'16:30'}));
  const oneDay={...window,startDate:'2026-09-27',startText:'2026-09-27 16:00:00'};
  assert.equal(buildTrends(alarms,oneDay,oldHistory).groups[0].baselineDays,0);
  assert.equal(buildTrends(alarms,oneDay,oldHistory).groups[0].label,'历史不足、型号缺失或覆盖不全');
});
test('老板简报使用基本信息BMS、按类型列数量、通知未发送，工程保留排除对象和采集时间',()=>{
  const a={sn:'SN-DO-NOT-SUBSTITUTE',type:'电量不足',time:'2026-09-28 12:00:00',origin:'本区间新增',detail,lowVoltage:analyzeWeek(week(),window.endText)};
  const excluded={...a,sn:'excluded',type:'单体压差过大',excluded:true,lowVoltage:null,difference:classifyDifference({...detail,cells:[{index:1,voltage:2.1}]})};
  const report=buildAuditReports({window,alarms:[a,excluded],trends:{groups:[]},checkedAt:'2026-09-28 18:00:00',complete:true});
  assert.match(report.brief,/F100-real/);assert.doesNotMatch(report.brief,/SN-DO-NOT-SUBSTITUTE|已通知/);assert.match(report.brief,/电量不足：1条/);assert.match(report.engineer,/excluded/);assert.match(report.engineer,/17:00:00/);
  assert.match(report.brief,/BMS软件版本：SW-1\.2\.3/);assert.match(report.engineer,/BMS软件版本：SW-1\.2\.3/);
  assert.match(report.engineer,/跨度≥72小时/);assert.doesNotMatch(report.brief+report.engineer,/一周|168小时|<2\.5V/);
  assert.match(reportHtml('<script>alert(1)</script>'),/&lt;script&gt;/);
});
test('软件版本优先基本信息，导出补充，缺失和冲突不推测，保存版本可继续继承',()=>{
  const a={detail,row:row(undefined,undefined,undefined,{'BMS版本':'export-1'})};
  assert.equal(bmsSoftwareVersion(a),'SW-1.2.3');
  assert.equal(bmsSoftwareVersion({...a,detail:{}}),'export-1');
  assert.equal(bmsSoftwareVersion({detail:{hardwareVersion:'HW-1'}}),'');
  assert.equal(bmsSoftwareVersion({...a,detail:{bmsSoftwareVersionError:'冲突'}}),'');
  const selection=collectAlarms([], [{sn:'old',type:'电量不足',time:'2026-09-24 12:00:00',vendor:'JY',level:'保护',bmsSoftwareVersion:'SW-old'}],[],window,'2026-09-28 18:00:00');
  assert.equal(bmsSoftwareVersion(selection.alarms[0]),'SW-old');
  const report=buildAuditReports({window,alarms:[{sn:'missing',type:'电量不足',time:window.endText,detail:{}}],trends:{groups:[]},checkedAt:window.endText,complete:true});
  assert.match(report.engineer,/BMS软件版本：缺失待核实/);
});
test('普通故障60/180秒重试且最多3次，凭据拒绝立即停止',async()=>{
  let attempts=0;const waits=[];
  await assert.rejects(withAuditRetries(async()=>{attempts++;throw new Error('network');},{wait:async n=>waits.push(n)}));
  assert.equal(attempts,3);assert.deepEqual(waits,[60000,180000]);
  attempts=0;await assert.rejects(withAuditRetries(async()=>{attempts++;throw Object.assign(new Error('需人工登录'),{code:'AUTH_REQUIRED'});},{wait:async()=>{throw new Error('不应等待');}}));assert.equal(attempts,1);
});
async function tempConfig() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-audit-'));
  return {projectRoot:root,vendor:'JY',maxTrackingRefreshBatches:20,paths:{state:path.join(root,'state/current_tracking.json'),reports:path.join(root,'reports'),dailyReports:path.join(root,'reports/daily_reports'),data:path.join(root,'data'),lastResult:path.join(root,'run/last-result.json')}};
}
async function cleanup(root){assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'jy-audit-'));await fs.rm(root,{recursive:true,force:true});}
test('报告和跟踪保存后才推进截止；成功清理恢复证据；不保留每日原始心跳副本',async()=>{
  const config=await tempConfig();
  try {
    await fs.mkdir(path.join(config.projectRoot,'跟踪数据'),{recursive:true});await fs.writeFile(path.join(config.projectRoot,'跟踪数据',evidenceName('old')),'old');
    const a={sn:'SN-A',type:'电量不足',time:'2026-09-28 12:00:00',origin:'本区间新增',vendor:'JY',level:'保护',row:row(),detail,lowVoltage:analyzeWeek(week(),window.endText)};
    const data={window,alarms:[a],recovered:[],warnings:[],snapshots:new Map([['SN-A',{detail}]]),evidence:new Map([['SN-A',week()]]),previousState:{},complete:true,checkedAt:'2026-09-28 18:00:00'};
    await saveAuditOutputs(config,data);
    assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.endText);
    assert.equal(await fs.access(path.join(config.projectRoot,'跟踪数据',evidenceName('old'))).then(()=>true,()=>false),false);
    const raw=JSON.parse(await fs.readFile(path.join(config.paths.data,'2026-09-28_alarm_data.json')));assert.equal(raw.today_heartbeat_evidence['SN-A'].records,undefined);
    assert.equal(raw.records[0].bms_software_version,'SW-1.2.3');
    assert.equal(raw.audit.items[0].bmsSoftwareVersion,'SW-1.2.3');
    assert.equal(raw.analysis_settings.lowVoltageThresholdV,2.58);assert.equal(raw.analysis_settings.lowVoltageDurationMinutes,4320);
    assert.equal(JSON.parse(await fs.readFile(config.paths.state)).items[0].bmsSoftwareVersion,'SW-1.2.3');
    const evidence=JSON.parse(await fs.readFile(path.join(config.projectRoot,'跟踪数据',evidenceName('SN-A'))));assert.equal(evidence.evidence.records.length,9);
    for(const name of ['今日电池报警简报','电池报警复核清单'])for(const ext of ['md','html'])await fs.access(path.join(config.paths.reports,`${name}.${ext}`));
    const saved=await fs.readFile(config.paths.state,'utf8');
    await saveAuditOutputs(config,{...data,complete:false,warnings:['未完成'],window:{...window,endText:'2026-09-29 16:00:00'}});
    assert.equal(await fs.readFile(config.paths.state,'utf8'),saved);
    assert.equal(JSON.parse(await fs.readFile(path.join(config.projectRoot,'跟踪数据',evidenceName('SN-A')))).cutoff,window.endText);
  } finally {await cleanup(config.projectRoot);}
});
test('报告保存失败不推进成功截止或删除旧跟踪证据',async()=>{
  const config=await tempConfig();
  try {
    await fs.mkdir(path.join(config.paths.reports,'今日电池报警简报.md'),{recursive:true});
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText}));
    await assert.rejects(saveAuditOutputs(config,{window,alarms:[],recovered:[],warnings:[],snapshots:new Map(),evidence:new Map(),previousState:{},complete:true,checkedAt:'2026-09-28 18:00:00'}));
    assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
  }finally{await cleanup(config.projectRoot);}
});
test('Windows当前用户加密可往返，文件无明文凭据', {skip:process.platform!=='win32'},async()=>{
  const config=await tempConfig();try{
    const file=path.join(config.projectRoot,'private/fixture.dpapi');await savePrivate(file,{username:'fixture-user',password:'fixture-secret'});
    assert.doesNotMatch(await fs.readFile(file,'utf8'),/fixture/);assert.deepEqual(await readPrivate(file),{username:'fixture-user',password:'fixture-secret'});
  }finally{await cleanup(config.projectRoot);}
});
async function workbook(rows) {
  const headers=['最早报警时间','修复时间','电池组编号','报警（级别：类型）','处理状态','BMS厂商'];
  const xmlRow=(values,n)=>`<row r="${n}">${values.map((v,i)=>`<c r="${String.fromCharCode(65+i)}${n}" t="inlineStr"><is><t>${v ?? ''}</t></is></c>`).join('')}</row>`;
  const zip=new JSZip();zip.file('xl/worksheets/sheet1.xml',`<worksheet><sheetData>${xmlRow(headers,1)}${rows.map((r,i)=>xmlRow(headers.map(h=>r[h]),i+2)).join('')}</sheetData></worksheet>`);return zip.generateAsync({type:'nodebuffer'});
}
test('Excel前开后闭与全流程：恢复检查后正式报告，不混入截止后新报警',async()=>{
  const buffer=await workbook([row('start','电量不足',window.startText),row('end','电量不足',window.endText)]);
  assert.deepEqual((await parseAlarmWorkbook(buffer,{vendor:'JY',start:window.start,end:window.end,endInclusive:true})).rows.map(r=>r['电池组编号']),['end']);
  const config=await tempConfig();
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query){const rows=query.reportDate.includes('tracking')?[row(),row('SN-A','电量不足','2026-09-28 16:31:00')]:[row()];return {buffer:await workbook(rows),resultCount:rows.length};}
    async fetchBatterySnapshots(sns){assert.deepEqual(sns,['SN-A']);this.heartbeatEvidence=new Map([['SN-A',{...week(),detail,historyDays:Array.from({length:10},(_,i)=>shiftDay(window.reportDate,-i))}]]);return new Map([['SN-A',{detail}]]);}
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
    const result=await runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{delays:[]}});
    assert.equal(result.status,'success');const state=JSON.parse(await fs.readFile(config.paths.state));assert.equal(state.items.length,1);assert.equal(state.items[0].sn,'SN-A');
  }finally{await cleanup(config.projectRoot);}
});

test('详情失败后的同截止续查复用完整初始导出，最终恢复状态仍重新查询',async()=>{
  const config=await tempConfig();let exports=0,refreshes=0,fetches=0;
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      if(!bmsNumbers.length){exports++;assert.equal(exports,1,'再次导出会被持续增长的整日总数挡住');}
      else refreshes++;
      return {buffer:await workbook([row()]),resultCount:1};
    }
    async fetchBatterySnapshots(sns) {
      fetches++;assert.deepEqual(sns,['SN-A']);
      if(fetches===2)assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
      this.heartbeatEvidence=new Map([['SN-A',{...week(),complete:fetches>1,error:'Timeout',detail,
        historyDays:Array.from({length:10},(_,i)=>shiftDay(window.reportDate,-i))}]]);
      return new Map([['SN-A',{detail}]]);
    }
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});
    await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
    const result=await runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{wait:async()=>{}}});
    assert.equal(result.status,'success');assert.equal(exports,1);assert.equal(fetches,2);assert.equal(refreshes,1,'心跳补齐后只做一次最终恢复复查');
  }finally{await cleanup(config.projectRoot);}
});

test('6→4→0设备缺口使用同一三轮预算，只补缺失SN，最后统一复查并保留离线例外',async()=>{
  const config=await tempConfig(),calls=[],waits=[],events=[],progress=[];
  const prior=row('GOOD','电量不足','2026-09-23 12:00:00');
  const cells=Array.from({length:6},(_,i)=>`CELLS-${i+1}`);
  const rows=[row('GOOD','电量不足'),...cells.map(sn=>row(sn,'单体压差过大')),row('OFFLINE','单体压差过大')];
  let exports=0,fetches=0,finalRefreshes=0;
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      if(!bmsNumbers.length)exports++;
      if(bmsNumbers.length && query.startDate==='2026-09-28'){finalRefreshes++;assert.equal(fetches,3,'补齐电芯前不能做最终全量复查');events.push('final');}
      const selected=bmsNumbers.length?(query.startDate==='2026-09-23'?[prior]:rows):rows;
      return {buffer:await workbook(selected),resultCount:selected.length};
    }
    async fetchBatterySnapshots(sns,{cachedEvidence}) {
      calls.push(sns);fetches++;events.push('fetch');
      if(fetches>1)for(const sn of sns)assert.equal(cachedEvidence.get(sn).complete,true,'补电芯仍复用已完整的心跳');
      this.heartbeatEvidence=new Map(sns.map(sn=>[sn,{complete:true,historyComplete:false,records:[],detail:sn==='OFFLINE'?{...detail,online:false,cellsComplete:false,cells:[]}:
        {...detail,cellsComplete:!cells.includes(sn)||fetches===3||fetches===2&&cells.indexOf(sn)>=4,cells:detail.cells,cellsError:'暂时失败'}}]));
      return new Map(sns.map(sn=>[sn,{detail:this.heartbeatEvidence.get(sn).detail}]));
    }
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});
    await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[{sn:'GOOD',type:'电量不足',time:prior['最早报警时间'],vendor:'JY',level:'保护',bms_number:'GOOD',alarm_time:prior['最早报警时间']}]}));
    const result=await runAudit(config,{progress:p=>progress.push(p),warn(){},info(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,
      retryOptions:{wait:async ms=>{
        waits.push(ms);assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
        assert.equal(await fs.access(config.paths.lastResult).then(()=>true,()=>false),false,'补查前只存检查点，不发布暂存报告');
        const files=await fs.readdir(path.join(config.projectRoot,'run/acquisition'));
        const saved=await Promise.all(files.map(async file=>JSON.parse(await fs.readFile(path.join(config.projectRoot,'run/acquisition',file)))));
        assert.ok(saved.some(s=>Array.isArray(s.evidence['CELLS-1']?.records)),'原始心跳已原子保存');
      }}});
    assert.equal(result.status,'success');assert.equal(result.pending_review_count,1);
    assert.deepEqual(calls,[['GOOD',...cells,'OFFLINE'],cells,cells.slice(0,4)]);
    assert.deepEqual(waits,[60000,180000]);assert.equal(exports,1);assert.equal(finalRefreshes,1);
    assert.deepEqual(events,['fetch','fetch','fetch','final']);
    assert.ok(progress.some(p=>/等待设备证据补查：6块/.test(p.stage)&&p.pending===6&&p.recovery===null));
    assert.ok(progress.some(p=>/等待设备证据补查：4块/.test(p.stage)&&p.pending===4));
    assert.deepEqual(JSON.parse(await fs.readFile(config.paths.state)).pending_reviews.map(r=>r.sn),['OFFLINE']);
  }finally{await cleanup(config.projectRoot);}
});

test('必要电芯持续失败只做三轮及一次最后复查，保留未完成截止和原始检查点',async()=>{
  const config=await tempConfig(),waits=[];let fetches=0,refreshes=0;
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}){if(bmsNumbers.length){refreshes++;assert.equal(fetches,3);}return {buffer:await workbook([row('SN-A','单体压差过大')]),resultCount:1};}
    async fetchBatterySnapshots(){fetches++;this.heartbeatEvidence=new Map([['SN-A',{complete:true,historyComplete:false,records:[],detail:{...detail,online:true,cellsComplete:false,cells:[],cellsError:'执行指令错误'}}]]);return new Map([['SN-A',{detail:this.heartbeatEvidence.get('SN-A').detail}]]);}
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
    await assert.rejects(runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{wait:async ms=>waits.push(ms)}}),{code:'AUDIT_INCOMPLETE'});
    assert.equal(fetches,3);assert.equal(refreshes,1);assert.deepEqual(waits,[60000,180000]);
    assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
    assert.equal(JSON.parse(await fs.readFile(config.paths.lastResult)).status,'partial_success');
    await fs.access(path.join(config.projectRoot,'run/pending-audit.json'));
    const manifest=JSON.parse(await fs.readFile(path.join(config.projectRoot,'run/acquisition/manifest.json')));
    assert.ok(Array.isArray(JSON.parse(await fs.readFile(path.join(config.projectRoot,'run/acquisition',manifest.devices[0].file))).evidence['SN-A'].records));
  }finally{await cleanup(config.projectRoot);}
});

test('最后预算轮仍刷新恢复状态：已恢复普通压差可剔除，历史风险证据缺口仍阻断',async()=>{
  for(const historicalRisk of [false,true]) {
    const config=await tempConfig();let fetches=0,refreshes=0;
    const alarm=row('SN-A','单体压差过大');
    class Platform {
      async open(){} async close(){}
      async queryAlarmAndDownload(query,{bmsNumbers}) {
        const final=bmsNumbers.length&&fetches===3;if(final)refreshes++;
        return {buffer:await workbook([{...alarm,'修复时间':final?'2026-09-28 17:00:00':''}]),resultCount:1};
      }
      async fetchBatterySnapshots(){fetches++;this.heartbeatEvidence=new Map([['SN-A',{complete:true,historyComplete:false,records:[],detail:{...detail,online:true,cellsComplete:false,cells:[]}}]]);return new Map([['SN-A',{detail:this.heartbeatEvidence.get('SN-A').detail}]]);}
    }
    try {
      await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,
        items:historicalRisk?[{sn:'SN-A',type:'单体压差过大',time:alarm['最早报警时间'],vendor:'JY',level:'保护',bms_number:'SN-A',alarm_time:alarm['最早报警时间'],difference:{status:'待复核'}}]:[]}));
      const run=()=>runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),clock:()=>new Date('2026-09-28T10:00:00Z'),Platform,retryOptions:{wait:async()=>{}}});
      if(historicalRisk)await assert.rejects(run(),{code:'AUDIT_INCOMPLETE'});
      else {assert.equal((await run()).status,'success');assert.deepEqual(JSON.parse(await fs.readFile(config.paths.state)).items,[]);}
      assert.equal(fetches,3);assert.equal(refreshes,1);
      assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,historicalRisk?window.startText:window.endText);
    }finally{await cleanup(config.projectRoot);}
  }
});

test('初始导出计数始终不符时不建立缓存；下一轮成功导出后才读取设备',async()=>{
  const config=await tempConfig();let exports=0,fetches=0;
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      if(!bmsNumbers.length)exports++;
      return {buffer:await workbook([row()]),resultCount:!bmsNumbers.length&&exports<=3?2:1};
    }
    async fetchBatterySnapshots(){fetches++;assert.equal(exports,4);this.heartbeatEvidence=new Map([['SN-A',{complete:true,historyComplete:false,records:[],detail}]]);return new Map([['SN-A',{detail}]]);}
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
    assert.equal((await runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{wait:async()=>{}}})).status,'success');
    assert.equal(exports,4);assert.equal(fetches,1);
  }finally{await cleanup(config.projectRoot);}
});

test('设备缺口不新增嵌套预算；零次、一次重试及前轮登录失败均在最后可用轮做最终复查',async()=>{
  for(const scenario of [{delays:[],opensFail:0},{delays:[60000],opensFail:0},{delays:[60000],opensFail:1}]) {
    const config=await tempConfig(),waits=[];let opens=0,fetches=0,finalRefreshes=0;
    class Platform {
      async open(){opens++;if(opens<=scenario.opensFail)throw new Error('登录页面网络超时');} async close(){}
      async queryAlarmAndDownload(query,{bmsNumbers}){if(bmsNumbers.length){finalRefreshes++;assert.equal(opens,scenario.delays.length+1);}return {buffer:await workbook([row('SN-A','单体压差过大')]),resultCount:1};}
      async fetchBatterySnapshots(){fetches++;this.heartbeatEvidence=new Map([['SN-A',{complete:true,records:[],detail:{...detail,cellsComplete:false,cells:[]}}]]);return new Map([['SN-A',{detail:this.heartbeatEvidence.get('SN-A').detail}]]);}
    }
    try {
      await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
      await assert.rejects(runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{delays:scenario.delays,wait:async ms=>waits.push(ms)}}),{code:'AUDIT_INCOMPLETE'});
      assert.equal(opens,scenario.delays.length+1);assert.equal(fetches,opens-scenario.opensFail);assert.equal(finalRefreshes,1);assert.deepEqual(waits,scenario.delays);
      assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
    }finally{await cleanup(config.projectRoot);}
  }
});

test('最终报警原身份缺失仍需重新复查；完整设备检查点不重读，不能把复查结果缓存为成功',async()=>{
  const config=await tempConfig(),waits=[];let fetches=0,finalRefreshes=0;
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      if(bmsNumbers.length)finalRefreshes++;
      const rows=bmsNumbers.length&&finalRefreshes===1?[]:[row()];
      return {buffer:await workbook(rows),resultCount:rows.length};
    }
    async fetchBatterySnapshots(sns){if(sns.length){fetches++;this.heartbeatEvidence=new Map([['SN-A',{complete:true,records:[],detail}]]);return new Map([['SN-A',{detail}]]);}this.heartbeatEvidence=new Map();return new Map();}
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
    assert.equal((await runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{wait:async ms=>waits.push(ms)}})).status,'success');
    assert.equal(fetches,1);assert.equal(finalRefreshes,2);assert.deepEqual(waits,[60000]);
  }finally{await cleanup(config.projectRoot);}
});

test('设备阶段认证拒绝或取消直接停止，不等待、不复查、不提交，并关闭平台',async()=>{
  for(const failure of ['auth','cancel']) {
    const config=await tempConfig(),controller=new AbortController();config.signal=controller.signal;
    let closes=0,refreshes=0,fetches=0;
    class Platform {
      async open(){} async close(){closes++;}
      async queryAlarmAndDownload(query,{bmsNumbers}){if(bmsNumbers.length)refreshes++;return {buffer:await workbook([row('SN-A','单体压差过大')]),resultCount:1};}
      async fetchBatterySnapshots(){fetches++;if(failure==='auth')throw Object.assign(new Error('凭据被拒绝'),{code:'AUTH_REQUIRED'});
        this.heartbeatEvidence=new Map([['SN-A',{complete:true,records:[],detail:{...detail,cellsComplete:false,cells:[]}}]]);controller.abort(new Error('用户取消'));return new Map([['SN-A',{detail}]]);}
    }
    try {
      await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
      await assert.rejects(runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{wait:async()=>assert.fail('认证或取消不应等待')}}),failure==='auth'?{code:'AUTH_REQUIRED'}:/用户取消/);
      assert.equal(fetches,1);assert.equal(closes,1);assert.equal(refreshes,0);
      assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
      assert.equal(await fs.access(config.paths.lastResult).then(()=>true,()=>false),false);
    }finally{await cleanup(config.projectRoot);}
  }
});

test('提前补查保留紧凑摘要对应的原始文件，不用摘要覆盖records',async()=>{
  const config=await tempConfig();let fetches=0;
  const records=[{time:'2026-09-28 12:00:00',minVoltage:3.4,maxVoltage:3.5,event:''}];
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(){return {buffer:await workbook([row('SN-A','单体压差过大')]),resultCount:1};}
    async fetchBatterySnapshots(sns,{cachedEvidence}) {
      fetches++;if(fetches>1)assert.deepEqual((await hydrateEvidence('SN-A',cachedEvidence.get('SN-A'))).records,records);
      const d={...detail,cellsComplete:fetches>1},e={complete:true,historyComplete:false,records,detail:d};
      const file=checkpointPath(config.projectRoot,'SN-A');await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,JSON.stringify({endText:window.endText,reportDate:window.reportDate,snapshots:{'SN-A':{detail:d}},evidence:{'SN-A':e}}));
      this.heartbeatEvidence=new Map([['SN-A',evidenceSummary(e,window.endText,file)]]);return new Map([['SN-A',{detail:d}]]);
    }
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
    assert.equal((await runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{wait:async()=>{
      assert.deepEqual(JSON.parse(await fs.readFile(checkpointPath(config.projectRoot,'SN-A'))).evidence['SN-A'].records,records);
    }}})).status,'success');
    assert.equal(fetches,2);assert.deepEqual(JSON.parse(await fs.readFile(path.join(config.projectRoot,'跟踪数据',evidenceName('SN-A')))).evidence.records,records);
  }finally{await cleanup(config.projectRoot);}
});

test('提前检查点保存失败传播文件错误，沿用原重试预算且不推进截止',async()=>{
  const config=await tempConfig(),warnings=[];let fetches=0,waits=0;
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(){return {buffer:await workbook([row('SN-A','单体压差过大')]),resultCount:1};}
    async fetchBatterySnapshots(){fetches++;if(fetches===1)await fs.writeFile(path.join(config.projectRoot,'run/acquisition'),'模拟路径阻塞');const d={...detail,cellsComplete:fetches>1};this.heartbeatEvidence=new Map([['SN-A',{complete:true,records:[],detail:d}]]);return new Map([['SN-A',{detail:d}]]);}
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
    const result=await runAudit(config,{progress(){},warn:message=>warnings.push(message)},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{delays:[60000],wait:async()=>{
      waits++;assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
      assert.equal(await fs.access(config.paths.lastResult).then(()=>true,()=>false),false);
      await fs.unlink(path.join(config.projectRoot,'run/acquisition'));
    }}});
    assert.equal(result.status,'success');assert.equal(fetches,2);assert.equal(waits,1);
    assert.match(warnings[0],/ENOTDIR|EEXIST/);assert.doesNotMatch(warnings[0],/设备证据待补齐/);
  }finally{await cleanup(config.projectRoot);}
});

test('最新报警复查已恢复时，仍核验并保留更早日期的未恢复同类型报警',async()=>{
  const config=await tempConfig(),dates=[];
  const rows=[row('SN-A','电量不足','2026-09-26 12:00:00'),row('SN-A','电量不足','2026-09-27 12:00:00')];
  class Platform {
    async open(){} async close(){}
    async queryAlarmAndDownload(query,{bmsNumbers}) {
      const selected=bmsNumbers.length?rows.filter(r=>r['最早报警时间'].startsWith(query.startDate)).map(r=>({...r,'修复时间':query.startDate==='2026-09-27'?'2026-09-28 17:00:00':''})):rows;
      if(bmsNumbers.length)dates.push(query.startDate);
      return {buffer:await workbook(selected),resultCount:selected.length};
    }
    async fetchBatterySnapshots(){this.heartbeatEvidence=new Map([['SN-A',{complete:true,historyComplete:false,records:[],detail}]]);return new Map([['SN-A',{detail}]]);}
  }
  try {
    await fs.mkdir(path.dirname(config.paths.state),{recursive:true});await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
    const result=await runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{delays:[]}});
    assert.equal(result.status,'success');assert.deepEqual(dates,['2026-09-26','2026-09-27']);
    assert.equal(JSON.parse(await fs.readFile(config.paths.state)).items[0].time,'2026-09-26 12:00:00');
  }finally{await cleanup(config.projectRoot);}
});

test('电芯失败不丢心跳；压差缺少逐节电压不能推进截止，续查仍重新读取电芯',async()=>{
  for (const type of ['电量不足', '单体压差过大']) {
    const config=await tempConfig();
    const missingCells={...detail,cells:[],cellsComplete:false,cellsError:'电芯详情读取失败：执行指令错误,请稍后再试'};
    let fetches=0;
    class Platform {
      async open(){} async close(){}
      async queryAlarmAndDownload(){return {buffer:await workbook([row('SN-A',type)]),resultCount:1};}
      async fetchBatterySnapshots(sns){
        assert.deepEqual(sns,['SN-A']);fetches++;
        this.heartbeatEvidence=new Map([['SN-A',{...week(),detail:missingCells,historyDays:Array.from({length:10},(_,i)=>shiftDay(window.reportDate,-i))}]]);
        return new Map([['SN-A',{detail:missingCells}]]);
      }
    }
    try {
      await fs.mkdir(path.dirname(config.paths.state),{recursive:true});
      await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
      const run=()=>runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{delays:[]}});
      if(type==='电量不足')assert.equal((await run()).status,'success');
      else {
        await assert.rejects(run(),/压差电芯核查未完成/);
        await assert.rejects(run(),/压差电芯核查未完成/);
        assert.equal(fetches,2);
        assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
      }
      const report=await fs.readFile(path.join(config.paths.reports,'电池报警复核清单.md'),'utf8');
      assert.match(report,/电芯读取限制：电芯详情读取失败：执行指令错误/);
      if(type==='单体压差过大')assert.match(report,/压差处理：待复核/);
    }finally{await cleanup(config.projectRoot);}
  }
});

test('离线电芯独立待复核并推进截止；混合网络故障仍补查；跨日报警恢复后继续跟踪直至补读完成',async()=>{
  for(const mixed of [false,true]) {
    const config=await tempConfig(),calls=[],waits=[];
    const offline={...detail,online:false,cells:[],cellsComplete:false,cellsError:'平台显示设备离线'};
    const rows=[row('OFFLINE','单体压差过大','2026-09-27 12:00:00'),...(mixed?[row('NETWORK','电量不足','2026-09-27 12:00:00')]:[])];
    let opens=0,repaired=false,online=false;
    class Platform {
      async open(){opens++;} async close(){}
      async queryAlarmAndDownload(){return {buffer:await workbook(rows.map(r=>({...r,'修复时间':repaired?'2026-09-28 00:00:00':''}))),resultCount:rows.length};}
      async fetchBatterySnapshots(sns){
        calls.push(sns);this.heartbeatEvidence=new Map();
        for(const sn of sns)this.heartbeatEvidence.set(sn,{...week(online?'3.0':'2.49'),
          complete:sn!=='NETWORK'||opens>1,error:'Timeout',detail:sn==='OFFLINE'&&!online?offline:detail,
          historyDays:Array.from({length:10},(_,i)=>shiftDay(window.reportDate,-i))});
        return new Map(sns.map(sn=>[sn,{detail:sn==='OFFLINE'&&!online?offline:detail}]));
      }
    }
    try {
      await fs.mkdir(path.dirname(config.paths.state),{recursive:true});
      await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
      const run=(date='2026-09-28')=>runAudit(config,{progress(){},warn(){}},{now:new Date(date+'T08:00:01Z'),Platform,retryOptions:{wait:async ms=>waits.push(ms)}});
      const result=await run();
      assert.equal(result.status,'success');assert.equal(result.pending_review_count,1);
      assert.deepEqual(calls,mixed?[['OFFLINE','NETWORK'],['NETWORK']]:[['OFFLINE']]);
      assert.deepEqual(waits,mixed?[60000]:[]);
      let state=JSON.parse(await fs.readFile(config.paths.state));
      assert.equal(state.last_success_cutoff,window.endText);
      assert.deepEqual(state.pending_reviews.map(r=>r.sn),['OFFLINE']);
      assert.equal(state.items.find(a=>a.sn==='OFFLINE').difference.status,'待复核');
      const tracked=path.join(config.projectRoot,'跟踪数据',evidenceName('OFFLINE'));
      assert.equal(JSON.parse(await fs.readFile(tracked)).evidence.detail.cellsComplete,false);
      assert.match(await fs.readFile(path.join(config.paths.reports,'今日电池报警简报.md'),'utf8'),/报告已生成，1块离线电池电芯待复核/);
      assert.equal((await run()).status,'skipped');
      // Even after the alarm is repaired, the unresolved cell review survives.
      repaired=true;
      assert.equal((await run('2026-09-29')).status,'success');
      assert.ok(calls.at(-1).includes('OFFLINE'));
      state=JSON.parse(await fs.readFile(config.paths.state));
      assert.equal(state.last_success_cutoff,'2026-09-29 16:00:00');
      assert.equal(state.items.find(a=>a.sn==='OFFLINE').followupOnly,true);
      assert.equal(state.pending_reviews.length,1);
      await fs.access(tracked);
      assert.match(await fs.readFile(path.join(config.paths.reports,'电池报警复核清单.md'),'utf8'),/平台显示设备离线/);
      online=true;
      assert.equal((await run('2026-09-30')).status,'success');
      state=JSON.parse(await fs.readFile(config.paths.state));
      assert.deepEqual(state.pending_reviews,[]);assert.deepEqual(state.items,[]);
      assert.equal(await fs.access(tracked).then(()=>true,()=>false),false);
    }finally{await cleanup(config.projectRoot);}
  }
});

test('离线待复核不能掩盖心跳读取或恢复复查失败，截止及旧跟踪证据保持不变',async()=>{
  for(const failure of ['heartbeat','refresh']) {
    const config=await tempConfig();
    const offline={...detail,online:false,cells:[],cellsComplete:false,cellsError:'平台显示设备离线'};
    let queries=0;
    class Platform {
      async open(){} async close(){}
      async queryAlarmAndDownload(){if(++queries>1 && failure==='refresh')throw new Error('恢复复查网络故障');return {buffer:await workbook([row('OFFLINE','单体压差过大')]),resultCount:1};}
      async fetchBatterySnapshots(){
        this.heartbeatEvidence=new Map([['OFFLINE',{...week(),detail:offline,complete:failure!=='heartbeat',error:'心跳网络故障'}]]);
        return new Map([['OFFLINE',{detail:offline}]]);
      }
    }
    try {
      await fs.mkdir(path.dirname(config.paths.state),{recursive:true});
      await fs.writeFile(config.paths.state,JSON.stringify({last_success_cutoff:window.startText,items:[]}));
      await assert.rejects(runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{delays:[]}}),{code:'AUDIT_INCOMPLETE'});
      assert.equal(JSON.parse(await fs.readFile(config.paths.state)).last_success_cutoff,window.startText);
      await fs.access(path.join(config.projectRoot,'run/pending-audit.json'));
      const manifest=JSON.parse(await fs.readFile(path.join(config.projectRoot,'run/acquisition/manifest.json')));
      assert.equal(manifest.endText,window.endText);
      const saved=JSON.parse(await fs.readFile(path.join(config.projectRoot,'run/acquisition',manifest.devices[0].file)));
      assert.ok(Array.isArray(saved.evidence.OFFLINE.records));
    }finally{await cleanup(config.projectRoot);}
  }
});

test('报告完成但压差待复核的日期不进入完整趋势基线',()=>{
  const alarms=[{sn:'OFFLINE',type:'单体压差过大',time:window.endText,origin:'本区间新增',detail,difference:{status:'待复核'}}];
  const trends=buildTrends(alarms,window,[],true);
  assert.equal(trends.history.at(-1).complete,false);
  assert.match(trends.groups[0].label,/历史不足/);
});

test('两项关注报警按心跳识别低压，补电名单按SN去重，不凭压差报警冒充持续三天',async()=>{
  for(const sustained of [true,false]) {
    const config=await tempConfig();
    class Platform {
      async open(){} async close(){}
      async queryAlarmAndDownload(){const rows=[row('SN-A','电量不足'),row('SN-A','单体压差过大')];return {buffer:await workbook(rows),resultCount:2};}
      async fetchBatterySnapshots(sns){
        assert.deepEqual(sns,['SN-A']);
        const e=week();if(!sustained)e.records=e.records.map(r=>({...r,event:r.event==='进入低功耗'?r.event:'保护:单体压差过大'}));
        this.heartbeatEvidence=new Map([['SN-A',{...e,detail,historyDays:Array.from({length:10},(_,i)=>shiftDay(window.reportDate,-i))}]]);
        return new Map([['SN-A',{detail}]]);
      }
    }
    try {
      await runAudit(config,{progress(){},warn(){}},{now:new Date('2026-09-28T08:00:01Z'),Platform,retryOptions:{delays:[]}});
      const state=JSON.parse(await fs.readFile(config.paths.state));
      assert.equal(state.items.length,2);
      assert.ok(state.items.every(a=>a.lowVoltage.minVoltage===2.49 && a.lowVoltage.confirmed===sustained));
      const brief=await fs.readFile(path.join(config.paths.reports,'今日电池报警简报.md'),'utf8');
      assert.match(brief,sustained?/已确认需补电：1块/:/已确认需补电：0块.*优先复核：1块/);
      assert.equal((brief.match(/BMS：F100-real/g)??[]).length,sustained?1:0);
    }finally{await cleanup(config.projectRoot);}
  }
});

test('压差排除项集中单列，同SN其他报警仍正式统计，具体读数及详情保留',()=>{
  const a={sn:'SAME',type:'单体压差过大',time:window.endText,origin:'本区间新增',detail:{...detail,cells:[{index:1,voltage:2.1}]} ,excluded:true};
  a.difference=classifyDifference(a.detail);
  const report=buildAuditReports({window,alarms:[a,{...a,type:'电量不足',excluded:false,difference:null}],trends:{groups:[]},checkedAt:window.endText,complete:true});
  assert.deepEqual(report.counts.map(c=>[c.type,c.count]),[['电量不足',1]]);
  const [retained,excluded]=report.engineer.split('## 压差越界排除项（集中复核）');
  assert.match(retained,/### SAME · 电量不足/);assert.doesNotMatch(retained,/### SAME · 单体压差过大/);
  assert.match(excluded,/### SAME · 单体压差过大/);assert.match(excluded,/1号=2.1V/);assert.match(excluded,/打开电池详情/);
});

import fs from 'node:fs/promises';
import {isDeviceTimeout} from './pending-verification.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JYPlatform } from './platform.mjs';
import { atomicWrite, atomicWriteJson, readJson } from './utils.mjs';
import { toRawData } from './xlsx.mjs';
import { readDailyCache, collectDailyAlarmRows, loadRollingEvidence, loadHistoricalEvidence, loadHistoricalReviewState, saveDailyCache } from './daily-collection.mjs';
import { refreshPreviousAlarms } from './tracking-refresh.mjs';
import { beijingText, buildDailyAuditWindow, CALENDAR_2026, isChinaWorkday, reportArchiveName } from './calendar.mjs';
import { collectAlarms, normalizeAlarm, classifyDifference, analyzeWeek, alarmKey, LOW_VOLTAGE_RULE, bmsSoftwareVersion } from './audit-rules.mjs';
import { buildAuditReports, buildTrends, reportHtml } from './audit-report.mjs';
import { generateAutomaticReports } from './custom-report.mjs';
import { checkpointName, checkpointPath, evidenceSummary, hydrateEvidence } from './evidence-store.mjs';
import { currentDayPending, currentDayWindow, auditWindowNow } from './audit-policy.mjs';
import { buildAcquisitionPlan } from './acquisition-plan.mjs';
import { carryHistoricalAlarm } from './historical-review.mjs';

export const evidenceName=sn=>createHash('sha256').update(sn).digest('hex')+'.json';
export function isRetryable(error) {return !['AUTH_REQUIRED','CALENDAR_REQUIRED','EXPORT_LIMIT'].includes(error.code) && !/凭据|额外验证|验证码|账号限制/.test(error.message);}
export async function withAuditRetries(operation,{signal,onRetry=()=>{},wait=delay,delays=[60000,180000]}={}) {
  for(let attempt=0;;attempt++)try{return await operation(attempt);}catch(error){
    signal?.throwIfAborted();if(attempt>=delays.length || !isRetryable(error))throw error;
    await onRetry(attempt+2,delays[attempt],error);await wait(delays[attempt],undefined,{signal});
  }
}
export async function loadAcquisition(root,window,{compact=false,sns}={}) {
  const snapshots=new Map(),evidence=new Map();
  const dir=path.join(root,'run/acquisition');
  const files=await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const individual=files.filter(file=>/^batch-sn-[a-f0-9]{24}\.json$/.test(file));
  // New runs checkpoint each SN atomically. Do not reparse the same rows from
  // history, batch and whole-run backups (legacy whole-run files can be >350MB).
  const chosen=individual.length?individual:files.filter(file=>/^(batch-|repair-).+\.json$/.test(file));
  const wanted=sns?new Set(sns):null;
  for(const file of chosen) {
    if(!file.endsWith('.json'))continue;
    if(!individual.length && (await fs.stat(path.join(dir,file))).size>16*1024*1024)continue;
    let checkpoint;try{checkpoint=await readJson(path.join(dir,file));}catch{continue;}
    if(checkpoint.endText!==window.endText || checkpoint.reportDate!==window.reportDate)continue;
    for(const [sn,item] of Object.entries(checkpoint.snapshots ?? {}))if((!wanted||wanted.has(sn))&&!checkpoint.evidence?.[sn]?.carried)snapshots.set(sn,item);
    for(const [sn,item] of Object.entries(checkpoint.evidence ?? {}))if((!wanted||wanted.has(sn))&&!item.carried&&item.complete && (!item.historyComplete || item.historyDays?.length>=10)) evidence.set(sn,compact?evidenceSummary(item,window.endText,path.join(dir,file)):item);
  }
  return {snapshots,evidence};
}
async function saveAcquisitionEvidence(root,window,snapshots,evidence) {
  // Production writes each SN before returning. Legacy/test implementations
  // still need an atomic raw checkpoint before an early device-only retry.
  for(const [sn,e] of evidence)if(!e.evidenceFile || path.resolve(e.evidenceFile)!==path.resolve(checkpointPath(root,sn)))await atomicWriteJson(checkpointPath(root,sn),{endText:window.endText,reportDate:window.reportDate,snapshots:Object.fromEntries(snapshots.has(sn)?[[sn,snapshots.get(sn)]]:[]),evidence:{[sn]:await hydrateEvidence(sn,e)}});
}
function deviceEvidenceGaps(sns,cellSNs,snapshots,evidence) {
  const gaps=new Map();
  for(const sn of sns) {
    const e=evidence.get(sn),detail=e?.detail ?? snapshots.get(sn)?.detail,reasons=[];
    if(!snapshots.has(sn))reasons.push('电池摘要未取得');
    if(!e?.complete)reasons.push(`心跳读取未完成：${e?.error || '缺失'}`);
    if(!detail)reasons.push('基本信息未取得');
    if(cellSNs.has(sn) && !detail?.cellsComplete && detail?.online!==false)reasons.push(`压差电芯核查未完成：${detail?.cellsError || '逐节电压证据不完整'}`);
    if(reasons.length)gaps.set(sn,reasons.join('；'));
  }
  return gaps;
}
export async function saveAuditOutputs(config,{window,alarms,recovered,warnings,snapshots,evidence,previousState,complete,checkedAt,rows=[]},beforeCommit=()=>{}) {
  const root=config.projectRoot;
  const publishReport=window.publishReport!==false;
  const trends=buildTrends(alarms,window,await readJson(path.join(config.paths.reports,'型号趋势历史.json'),[]),complete);
  const report=buildAuditReports({window,alarms,recovered,warnings,trends,complete,checkedAt});
  const archive=path.join(config.paths.reports,reportArchiveName(window.reportDate,window.endText));
  const period={start:window.startText,end_inclusive:window.endText};
  const items=alarms.map(a=>({...a,bmsSoftwareVersion:bmsSoftwareVersion(a),row:undefined,detail:a.detail?{...a.detail,cells:undefined}:undefined,bms_number:a.sn,alarm_type:a.type,alarm_time:a.time,bms_vendor:'JY'}));
  const pendingReviews=alarms.filter(a=>a.review).map(a=>({sn:a.sn,type:a.type,...a.review}));
  const focusItems=alarms.map(a=>({sn:a.sn,category:a.type,count:1,types:[a.type],latestAlarm:a.time,row:a.row ?? {},snapshot:snapshots.get(a.sn),
    collection:a.historicalReview?'仅恢复复查，未重读心跳':evidence.get(a.sn)?.complete?'心跳范围读取完整':'证据读取不完整',
    crossCheck:{status:a.review?.kind==='reading_pending'?(a.review.status || '待确认'):a.excluded?'压差排除待复核':'未恢复保护，继续跟踪',warnings:[...(a.lowVoltage?.gaps ?? []),...(a.review?[a.review.reason]:[])]},
    lowVoltage:a.lowVoltage?{...a.lowVoltage,reason:a.lowVoltage.gaps.join('；') || '满足连续三天补电条件',sampledMinutes:a.lowVoltage.spanHours*60,sleepEvidence:a.lowVoltage.lowPowerEvents.map(e=>e.time).join('、')}:null}));
  const focus={items:focusItems,summary:report.counts.map(c=>({category:c.type,recordCount:c.count,snCount:new Set(report.kept.filter(a=>a.type===c.type).map(a=>a.sn)).size})),
    uniqueSNCount:new Set(alarms.map(a=>a.sn)).size,evidenceSNCount:[...new Set(alarms.map(a=>a.sn))].filter(sn=>evidence.get(sn)?.complete&&!evidence.get(sn)?.carried).length,overlap:[...new Set(alarms.filter(a=>a.type==='单体压差过大' && alarms.some(b=>b.sn===a.sn && b.type==='电量不足')).map(a=>a.sn))],analysisSettings:{auditVersion:2,...LOW_VOLTAGE_RULE}};
  const raw={audit_version:2,generated_at:checkedAt,period,record_count:report.kept.length,records:toRawData(report.kept.map(a=>a.row ?? {'电池组编号':a.sn,'最早报警时间':a.time,'报警（级别：类型）':`保护:${a.type}`,'BMS厂商':'JY'})).map((record,i)=>({...record,bms_software_version:bmsSoftwareVersion(report.kept[i]) || null})),
    today_focus:{...focus,items:focus.items.map(i=>({...i,snapshot:i.snapshot?{heartbeatTime:i.snapshot.heartbeatTime,batteryStatus:i.snapshot.batteryStatus}:null}))},today_heartbeat_evidence:Object.fromEntries([...evidence].map(([sn,e])=>[sn,{complete:e.complete&&!e.carried,carried:e.carried===true,coverageCutoff:e.coverageCutoff,error:e.error,historyComplete:e.historyComplete,historyDays:e.historyDays,recordCount:e.recordCount ?? e.records?.length ?? 0}])),analysis_settings:focus.analysisSettings,
    audit:{items,confirmed:report.confirmed,counts:report.counts,complete,evidence_complete:pendingReviews.length===0 && !warnings.length && !alarms.some(a=>a.historicalReview),warnings,pending_reviews:pendingReviews,trends:trends.groups},acquisition_finished_at:checkedAt};
  // Required outputs all precede the success watermark. Any failure leaves the
  // pending interval and its acquisition checkpoints available for resumption.
  beforeCommit();
  if(publishReport) {
  for(const [name,content] of [['今日电池报警简报',report.brief],['电池报警复核清单',report.engineer]]) {
    await atomicWrite(path.join(archive,name+'.md'),content);await atomicWrite(path.join(archive,name+'.html'),reportHtml(content));
    await atomicWrite(path.join(config.paths.reports,name+'.md'),content);await atomicWrite(path.join(config.paths.reports,name+'.html'),reportHtml(content));
  }
  // These aliases let the existing desktop and legacy report readers continue.
  await atomicWrite(path.join(config.paths.reports,`${window.reportDate}_JY报警监测日报.md`),report.engineer);
  await atomicWrite(path.join(config.paths.reports,`${window.reportDate}_重点专项SN.md`),report.engineer);
  await atomicWrite(path.join(config.paths.dailyReports,`${window.reportDate}_JY日报总结.txt`),report.brief);
  await atomicWriteJson(path.join(config.paths.data,`${window.reportDate}_alarm_data.json`),raw);
  }
  const trackDir=path.join(root,'跟踪数据');
  const sns=[...new Set(alarms.map(a=>a.sn))];
  // Ensure every raw device file exists before saving a small run manifest.
  // Test/legacy platform implementations may still return full in-memory rows.
  await saveAcquisitionEvidence(root,window,snapshots,evidence);
  await atomicWriteJson(path.join(root,'run/acquisition/manifest.json'),{schema_version:1,endText:window.endText,reportDate:window.reportDate,devices:[...evidence].map(([sn,e])=>({sn,file:checkpointName(sn),complete:e.complete===true&&!e.carried,carried:e.carried===true,coverageCutoff:e.coverageCutoff}))});
  if(complete)for(const sn of sns)await atomicWriteJson(path.join(trackDir,evidenceName(sn)),{sn,cutoff:window.endText,snapshot:snapshots.get(sn),evidence:await hydrateEvidence(sn,evidence.get(sn)),alarms:items.filter(a=>a.sn===sn)});
  const custom=publishReport?await generateAutomaticReports(root,raw,window.reportDate):{outputs:[],errors:[]};
  const result=publishReport?{status:complete?'success':'partial_success',completed_at:checkedAt,report_date:window.reportDate,period,message:report.oneLine,pending_review_count:report.reviewCount,
    report_path:path.join(config.paths.reports,`${window.reportDate}_JY报警监测日报.md`),daily_report_path:path.join(config.paths.reports,'今日电池报警简报.html'),
    engineer_report_path:path.join(config.paths.reports,'电池报警复核清单.html'),custom_reports:custom.outputs,custom_report_errors:custom.errors}
    :{status:complete?'success':'partial_success',mode:'collection',completed_at:checkedAt,report_date:null,collection_date:window.reportDate,period,
      message:complete?`每日采集与统计已完成，${sns.length}块电池，${report.reviewCount}块${currentDayPending(config)?'待确认':'电芯待复核'}；正式报告仍按法定工作日生成。`:'每日采集未完成。',pending_review_count:report.reviewCount,counts:report.counts};
  await atomicWrite(path.join(config.paths.reports,'运行状态.html'),reportHtml(`# ${publishReport?(complete?report.completionText:'核查未完成'):'每日采集状态'}\n\n${result.message}\n\n${checkedAt}\n\n${warnings.join('\n')}`));
  await atomicWriteJson(config.paths.lastResult,result);
  if(complete) {
    await saveDailyCache(root,{window,rows,items,counts:report.counts,pendingReviews});
    if(publishReport) {
    await atomicWriteJson(path.join(config.paths.reports,'型号趋势历史.json'),trends.history);
    await atomicWriteJson(config.paths.state,{schema_version:2,generated_at:checkedAt,last_success_cutoff:window.endText,period,items,pending_reviews:pendingReviews});
    }
    // Only app-owned, hashed tracking files are eligible for removal. This
    // happens after all required reports/evidence and the state were saved.
    const keep=new Set(sns.map(evidenceName));
    for(const file of await fs.readdir(trackDir).catch(()=>[]))if(/^[a-f0-9]{64}\.json$/.test(file) && !keep.has(file))await fs.unlink(path.join(trackDir,file)).catch(()=>{});
    await fs.unlink(path.join(root,'run/pending-audit.json')).catch(()=>{});
    for(const file of await fs.readdir(path.join(root,'run/acquisition')).catch(()=>[]))if(/^(?:(batch-|repair-|history-).+|manifest)\.json$/.test(file))await fs.unlink(path.join(root,'run/acquisition',file)).catch(()=>{});
  }
  return result;
}
export async function runAudit(config,logger,{now=new Date(),clock=()=>new Date(),beforeCommit=()=>{},onRetry=()=>{},Platform=JYPlatform,retryOptions={}}={}) {
  const root=config.projectRoot, previousState=await readJson(config.paths.state,{items:[]});
  const pendingPolicy=currentDayPending(config);
  const calendars=config.workdayCalendars ?? [CALENDAR_2026];
  const collectionState=await readJson(path.join(root,'state/daily_collection.json'),{});
  const pendingPath=path.join(root,'run/pending-audit.json');
  let pending=pendingPolicy?null:await readJson(pendingPath);
  if(pending) {
    pending.publishReport ??= isChinaWorkday(pending.reportDate,calendars);
    const cutoff=pending.publishReport?previousState.last_success_cutoff:collectionState.last_collection_cutoff || previousState.last_success_cutoff;
    if(cutoff>=pending.endText)pending=null;
  }
  const windowNow=auditWindowNow(now,{date:config.auditDate,event:process.env.GITHUB_EVENT_NAME,refName:process.env.GITHUB_REF_NAME,defaultBranch:process.env.JY_DEFAULT_BRANCH});
  const window=pendingPolicy?currentDayWindow(windowNow,previousState,collectionState,calendars):pending?{...pending,start:new Date(pending.start),end:new Date(pending.end)}:buildDailyAuditWindow(windowNow,previousState,collectionState,calendars);
  if(window.alreadyComplete)return {status:'skipped',completed_at:beijingText(now),message:'本次每日采集或正式报告区间已完成，无需重复核查'};
  const dailyCache=await readDailyCache(root,window);
  // A holiday's accepted tracking list is newer than the last formal report.
  // Carry objects forward without importing its alarm rows into today's range.
  if(pendingPolicy) {
    const latest=await readJson(path.join(root,'run/daily/collection.json'));
    if(latest?.complete && latest.endText===collectionState.last_collection_cutoff && latest.endText<=window.startText &&
      latest.endText>=(previousState.last_success_cutoff || '') && Array.isArray(latest.items))previousState.items=latest.items;
  }
  const reviewState=pendingPolicy?await loadHistoricalReviewState(root,window,previousState):previousState;
  const recoveryTargets=[...new Map([...(previousState.items ?? []),...(reviewState.items ?? [])]
    .map(a=>[`${alarmKey(a)}\0${a.time}`,a])).values()];
  await atomicWriteJson(pendingPath,window);
  // Offline live cells cannot be repaired by repeating the same history scan.
  // Scope this set to one invocation so a later run checks device status again.
  const offlineThisRun=new Set();
  // A successful export already proved coverage for this fixed window. Do not
  // put device repair behind another live whole-date export. Recovery status
  // is still queried afresh after every attempt's device reads.
  let verifiedAlarms, prepared;
  // In current-day mode, recovery/session failures must not re-enter device
  // collection (including devices already recorded as pending). Invocation only.
  const recoveryCheckpoint = pendingPolicy ? new Map() : undefined;
  // Scope selection and final recovery have different freshness requirements.
  // Resume initial batches within this invocation; final recovery stays fresh.
  const scopeCheckpoint = pendingPolicy ? new Map() : undefined;
  const processedThisRun = new Map();
  logger.progress({phase:'scope',audit_policy:config.auditPolicy,stage:'登录与报警导出',cutoff:window.endText});
  return withAuditRetries(async attempt=>{
    logger.progress({phase:prepared?'recovery':'scope',stage:prepared?`重新登录，继续报警恢复复查（第${attempt+1}/3次）`:attempt?`重试${attempt+1}/3：登录与报警导出`:'登录与报警导出',estimated_remaining_seconds:null,active_workers:[],...(!prepared?{recovery:null}:{}),audit_policy:config.auditPolicy});
    const platform=new Platform({...config,boundedEvidenceMemory:true},logger);
    try {
      await platform.open();
      const collected=prepared ?? await (async()=>{
        const parsed=verifiedAlarms ?? await collectDailyAlarmRows(platform,window,dailyCache);
        if(verifiedAlarms)logger.info?.(`复用截止${window.endText}本轮已完整核对的报警导出，继续补查设备。`);
        verifiedAlarms=parsed;
        let refresh=await refreshPreviousAlarms(platform,recoveryTargets,parsed.rows,config,{checkpoint:scopeCheckpoint});
        let selection=collectAlarms(parsed.rows,previousState.items ?? [],refresh.rows,window,beijingText(clock()));
        const historicalReviewMode=config.historicalReviewMode ?? (pendingPolicy?'recovery_only':'full');
        const { previousRisks, sns, historicalSNS, cellSNs, scope } = buildAcquisitionPlan(selection, reviewState.items ?? [], dailyCache?.items ?? [], window,{historicalReviewMode,previousCutoff:reviewState.last_success_cutoff || window.startText});
        const historicalSet=new Set(historicalSNS),previousByKey=new Map([...(previousState.items ?? []),...(reviewState.items ?? []),...(dailyCache?.items ?? [])].map(a=>[alarmKey(a),a]));
        logger.info?.(`采集范围：当日报警${scope.current_window}块，仅历史跟踪${scope.history_only}块，合并去重${scope.total}块；已恢复且无独立风险免采集${scope.skipped_recovered_normal}块。`);
        if(scope.history_recovery_only!=null)logger.info?.(`历史仅恢复复查${scope.history_recovery_only}块，复用原资料，不计入设备完整采集。`);
        logger.progress({stage:'恢复已完成的逐电池检查点',estimated_remaining_seconds:null});
        const cache=await loadAcquisition(root,window,{compact:true,sns});
        for(const sn of sns)if(processedThisRun.has(sn)) {
          const {snapshot,evidence}=processedThisRun.get(sn);
          if(snapshot)cache.snapshots.set(sn,snapshot);
          cache.evidence.set(sn,evidence);
        }
        const needed=sns.filter(sn=>!processedThisRun.has(sn) && (!cache.snapshots.has(sn)||!cache.evidence.get(sn)?.complete||!cache.evidence.get(sn)?.detail||
          cache.evidence.get(sn)?.detail?.detailVersion!==2 ||
          (cellSNs.has(sn) && !cache.evidence.get(sn)?.detail?.cellsComplete && !offlineThisRun.has(sn))));
        const neededSet=new Set(needed);
        const resumedFailed=sns.filter(sn=>!neededSet.has(sn)&&!cache.evidence.get(sn)?.complete).length;
        logger.progress({phase:'collection',stage:'基本信息、电芯及心跳核查',total:sns.length,completed:sns.length-needed.length,
          succeeded:sns.length-needed.length-resumedFailed,heartbeat_complete:sns.length-needed.length-resumedFailed,failed:resumedFailed,pending:needed.length+resumedFailed,collection_scope:scope});
        const rolling=await loadRollingEvidence(root,window.endText,{compact:true,sns:needed});
        let fetched;
        try {
          fetched=await platform.fetchBatterySnapshots(needed,{evidenceSNs:needed,cellSNs:[...cellSNs],progressTotal:sns.length,progressCompleted:sns.length-needed.length,progressFailed:resumedFailed,reportDate:window.reportDate,endText:window.endText,cachedEvidence:new Map([...rolling,...cache.evidence])});
        } finally {
          // Keep completed attempts even when a different lane loses its login.
          // Authentication-interrupted and never-started devices must resume;
          // attributed device gaps remain pending, never successful evidence.
          if(pendingPolicy)for(const [sn,evidence] of platform.heartbeatEvidence ?? []) {
            if(evidence.attempted===false || ['AUTH_REQUIRED','SESSION_EXPIRED'].includes(evidence.errorCode))continue;
            processedThisRun.set(sn,{evidence,snapshot:(fetched ?? platform.lastSnapshots)?.get(sn)});
          }
        }
        const historical=await loadHistoricalEvidence(root,window.endText,historicalSNS);
        const snapshots=new Map([...historical.snapshots,...cache.snapshots,...fetched]),evidence=new Map([...historical.evidence,...cache.evidence,...(platform.heartbeatEvidence ?? [])]);
        if(platform.sessionState?.expired)throw Object.assign(new Error('平台会话失效，需重新登录'),{code:'AUTH_REQUIRED'});
        if(pendingPolicy)for(const sn of sns)if(!evidence.has(sn))evidence.set(sn,{sn,complete:false,records:[],error:'设备读取未返回证据'});
        for(const sn of cellSNs)if(evidence.get(sn)?.detail?.online===false)offlineThisRun.add(sn);
        config.signal?.throwIfAborted();
        const deviceGaps=deviceEvidenceGaps(sns,cellSNs,snapshots,evidence);
        // Use the existing global retry budget, not another nested retry loop.
        // Do not repeat every original-alarm query just to repair a few cells.
        // On the final available attempt still refresh live recovery: a recovered
        // alarm may remove its device requirement, but retained risks still block.
        if(!pendingPolicy && deviceGaps.size && attempt<(retryOptions.delays ?? [60000,180000]).length) {
          await saveAcquisitionEvidence(root,window,snapshots,evidence);
          logger.info?.(`设备证据待补齐${deviceGaps.size}块，暂缓全量报警恢复复查；已保存逐SN证据，下一轮仅补查缺失证据。`);
          throw Object.assign(new Error(`设备证据待补齐：${[...deviceGaps].slice(0,4).map(([sn,reason])=>`${sn}：${reason}`).join('；')}`),{code:'DEVICE_EVIDENCE_INCOMPLETE',missingSNs:[...deviceGaps.keys()]});
        }
        return {parsed,previousRisks,sns,historicalSet,previousByKey,snapshots,evidence,deviceGaps};
      })();
      if(pendingPolicy)prepared=collected;
      const {parsed,previousRisks,sns,historicalSet,previousByKey,snapshots,evidence,deviceGaps}=collected;
      let refresh,selection;
      // Recheck all original alarms after potentially long detail/history reads.
      // Newly returned events are not admitted by collectAlarms.
      const targets=[...recoveryTargets,...parsed.rows.map(r=>({...normalizeAlarm(r),bms_number:r['电池组编号'],alarm_time:r['最早报警时间']}))];
      logger.progress({phase:'recovery',stage:'截止范围内报警恢复复查',estimated_remaining_seconds:null});
      refresh=await refreshPreviousAlarms(platform,targets,[],config,{stage:'截止范围内报警恢复复查',checkpoint:recoveryCheckpoint});
      const checkedAt=beijingText(clock());
      selection=collectAlarms(parsed.rows,previousState.items ?? [],refresh.rows,window,checkedAt);
      const warnings=pendingPolicy?[]:[...refresh.errors,...(platform.acquisitionWarnings ?? [])];
      const refreshedIdentities=new Set(refresh.rows.map(normalizeAlarm).map(a=>`${alarmKey(a)}\0${a.time}`));
      const recoveryGaps=new Map();
      for(const a of [...selection.alarms,...previousRisks])if(!refreshedIdentities.has(`${alarmKey(a)}\0${a.time}`)) {
        const reason=`${a.sn}／${a.type}原始报警未在恢复复查中找到，不能视为恢复${refresh.errors.length?'；'+refresh.errors.join('；'):''}`;
        if(pendingPolicy)recoveryGaps.set(`${alarmKey(a)}\0${a.time}`,reason);else warnings.push(reason);
      }
      // Unattributed recovery errors must never disappear into a successful run.
      if(pendingPolicy && refresh.errors.length && !recoveryGaps.size)warnings.push(...refresh.errors);
      if(selection.legacyMissing.length)warnings.push(`历史对象缺少JY厂商证据，需复核：${[...new Set(selection.legacyMissing)].join('、')}`);
      const active=new Set(selection.alarms.map(alarmKey));
      const followups=previousRisks.filter(a=>!active.has(alarmKey(a))).map(a=>({...a,followupOnly:true,origin:'历史延续'}));
      const lowBySN=new Map(sns.map(sn=>[sn,evidence.get(sn)?.week ?? analyzeWeek(evidence.get(sn),window.endText)]));
      const alarms=[...selection.alarms,...followups].map(a=>{
        if(historicalSet.has(a.sn))return {...carryHistoricalAlarm(a,previousByKey.get(alarmKey(a)),evidence.get(a.sn),snapshots.get(a.sn),checkedAt,
          recoveryGaps.get(`${alarmKey(a)}\0${a.time}`),reviewState.last_success_cutoff),evidenceIndex:`跟踪数据/${evidenceName(a.sn)}`};
        const e=evidence.get(a.sn),detail=e?.detail ?? snapshots.get(a.sn)?.detail;
        if(!pendingPolicy && !e?.complete)warnings.push(`${a.sn}心跳读取未完成：${e?.error || '缺失'}`);
        if(!pendingPolicy && !detail)warnings.push(`${a.sn}基本信息未取得`);
        const difference=a.type==='单体压差过大'?classifyDifference(pendingPolicy && !detail?.cellsComplete?{...detail,cells:[]}:detail):null;
        let review;
        if(difference && !detail?.cellsComplete) {
          const warning=`${a.sn}压差电芯核查未完成：${detail?.cellsError || '逐节电压证据不完整'}`;
          // An explicitly offline device is a retained object-level review,
          // not a failed alarm-coverage run. Unknown/network failures still block.
          if(detail?.online===false)review={kind:'offline_cells',reason:detail.cellsError || '平台显示设备离线，逐节电压待补读'};
          else if(!pendingPolicy)warnings.push(warning);
        }
        if(pendingPolicy) {
          const reasons=[deviceGaps.get(a.sn),recoveryGaps.get(`${alarmKey(a)}\0${a.time}`),
            !detail?.bms?'真实BMS编号缺失':null,difference?.status==='待复核'?difference.reason:null].filter(Boolean);
          if(reasons.length)review={kind:'reading_pending',status:'待确认',reason:[...new Set(reasons)].join('；'),
            recoveryPending:recoveryGaps.has(`${alarmKey(a)}\0${a.time}`)};
        }
        const observedLow=lowBySN.get(a.sn);
        if(pendingPolicy && observedLow?.minVoltage===null)review={...review,kind:'reading_pending',status:'待确认',
          reason:[review?.reason,'有效电压证据缺失或异常，不能判正常'].filter(Boolean).join('；')};
        if(review?.kind==='reading_pending' && isDeviceTimeout(review.reason))review={...review,status:'待验证',timeout:true};
        let lowVoltage=a.type==='电量不足' || observedLow?.minVoltage===null || observedLow?.minVoltage<2.8?observedLow:null;
        if(pendingPolicy && review && lowVoltage?.confirmed)lowVoltage={...lowVoltage,confirmed:false,status:review.status || '待确认',gaps:[...lowVoltage.gaps,review.reason]};
        return {...a,detail,difference,review,excluded:difference?.status==='排除待复核',lowVoltage,evidenceIndex:`跟踪数据/${evidenceName(a.sn)}`,
          evidenceSummary:`读取${e?.recordCount ?? e?.records?.length ?? 0}条；历史日期${e?.historyDays?.join('、') || window.reportDate}；异常数据${e?.abnormalCount ?? e?.records?.filter(r=>r.abnormal).length ?? 0}条`};
      }).filter(a=>!a.followupOnly || a.review || a.difference && a.difference.status!=='保留' || a.lowVoltage && (!evidence.get(a.sn)?.complete || a.lowVoltage.historicalConfirmed || a.lowVoltage.minVoltage===null || a.lowVoltage.minVoltage<2.8));
      const complete=!warnings.length;
      config.signal?.throwIfAborted();
      const refreshedRows=new Map(refresh.rows.map(r=>[`${r['电池组编号']}\0${r['报警（级别：类型）']}\0${r['最早报警时间']}`,r]));
      const rows=parsed.rows.map(r=>refreshedRows.get(`${r['电池组编号']}\0${r['报警（级别：类型）']}\0${r['最早报警时间']}`) ?? r);
      logger.progress({phase:'saving',stage:'保存报告与滚动证据',active_workers:[],current_sn:'',estimated_remaining_seconds:null});
      const result=await saveAuditOutputs(config,{window,alarms,recovered:selection.recovered,warnings:[...new Set(warnings)],snapshots,evidence,previousState,complete,checkedAt,rows},()=>{if(complete)beforeCommit();});
      if(!complete) {
        throw Object.assign(new Error(`必要核查未完成：${[...new Set(warnings)].slice(0,4).join('；')}；已保留暂存报告与续查进度`),{code:'AUDIT_INCOMPLETE'});
      }
      for(const file of platform.downloadFiles ?? [])if(path.dirname(path.resolve(file))===path.resolve(config.paths.downloads))await fs.unlink(file).catch(()=>{});
      const pendingCount=new Set(alarms.filter(a=>a.review).map(a=>a.sn)).size;
      const devicePendingCount=new Set(alarms.filter(a=>a.review && sns.includes(a.sn)).map(a=>a.sn)).size;
      logger.progress({phase:'completed',status:'completed',stage:pendingPolicy && pendingCount?`核查完成，${pendingCount}块待确认`:'完成',completed:sns.length,total:sns.length,
        succeeded:sns.length-(pendingPolicy?devicePendingCount:0),failed:pendingPolicy?devicePendingCount:0,pending:pendingPolicy?devicePendingCount:0,
        heartbeat_complete:sns.filter(sn=>evidence.get(sn)?.complete).length,pending_review_count:pendingCount,
        pending_verification_count:new Set(alarms.filter(a=>a.review?.status==='待验证').map(a=>a.sn)).size,
        historical_pending_count:new Set(alarms.filter(a=>a.review && historicalSet.has(a.sn)).map(a=>a.sn)).size,
        estimated_remaining_seconds:0,active_workers:[],report_path:result.report_path});return result;
    } finally {await platform.close().catch(()=>{});}
  },{...retryOptions,signal:config.signal,onRetry:(attempt,ms,error)=>{onRetry();logger.warn(error.message);logger.progress({phase:prepared?'recovery':'scope',stage:prepared?`恢复复查中断，${ms/1000}秒后重新登录并继续（第${attempt}/3次）；保留已处理设备和复查批次`:error.code==='DEVICE_EVIDENCE_INCOMPLETE'?`等待设备证据补查：${error.missingSNs.length}块，第${attempt}/3次，${ms/1000}秒后重试`:`等待自动续查，第${attempt}/3次，${ms/1000}秒后重试`,status:'running',estimated_remaining_seconds:null,
    ...(error.code==='DEVICE_EVIDENCE_INCOMPLETE'?{failed:error.missingSNs.length,pending:error.missingSNs.length,recovery:null,active_workers:[],current_sn:''}:{}),
  });}});
}

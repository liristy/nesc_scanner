// Temporary full-window acceptance harness. Keep on the test branch only.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadConfig} from '../src/config.mjs';
import {runAudit} from '../src/audit-runner.mjs';
import {beijingText,chinaDate} from '../src/calendar.mjs';
import {atomicWriteJson} from '../src/utils.mjs';
import {createRunLogger} from '../src/progress.mjs';
import {hydrateEvidence,checkpointPath} from '../src/evidence-store.mjs';
import {archiveFolders} from './private-evidence.mjs';

export function readOnlyWindow(startText,endText,now=new Date()) {
  const valid=text=>/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text||'') && Number.isFinite(chinaDate(text).getTime()) && beijingText(chinaDate(text))===text;
  if(!valid(startText)||!valid(endText)||startText>=endText||chinaDate(endText)>now)throw new Error('只读测试区间无效或截止尚未到达');
  return {start:chinaDate(startText),end:chinaDate(endText),startText,endText,startDate:startText.slice(0,10),endDate:endText.slice(0,10),reportDate:endText.slice(0,10),publishReport:false,auditPolicy:'current_day_pending',alreadyComplete:false};
}
export async function protectedFiles(root) {
  const entries=[];
  async function walk(directory) {
    for(const entry of await fs.readdir(path.join(root,directory),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
      const relative=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(relative);
      else if(entry.isFile())entries.push([relative,createHash('sha256').update(await fs.readFile(path.join(root,relative))).digest('hex')]);
      else throw new Error('测试基线存在非普通文件');
    }
  }
  await walk('reports');await walk('state');return entries.sort(([a],[b])=>a.localeCompare(b));
}
export async function saveReadOnlyOutputs(config,data) {
  const {window,alarms,recovered,warnings,snapshots,evidence,complete,checkedAt,rows}=data;
  const directory=path.join(config.projectRoot,'run/read-only-window');
  for(const [sn,e] of evidence)if(!e.evidenceFile)await atomicWriteJson(checkpointPath(config.projectRoot,sn),{endText:window.endText,reportDate:window.reportDate,snapshots:Object.fromEntries(snapshots.has(sn)?[[sn,snapshots.get(sn)]]:[]),evidence:{[sn]:await hydrateEvidence(sn,e)}});
  const current=[...evidence.values()].filter(e=>!e.carried),pending=new Set(alarms.filter(a=>a.review).map(a=>a.sn));
  const result={status:complete?'success':'incomplete',mode:'readonly_full_window',period:{start_exclusive:window.startText,end_inclusive:window.endText},checked_at:checkedAt,
    alarm_rows:rows.length,alarm_records:alarms.length,alarm_devices:new Set(alarms.map(a=>a.sn)).size,
    device_attempts:current.length,heartbeat_complete:current.filter(e=>e.complete).length,heartbeat_incomplete:current.filter(e=>!e.complete).length,
    heartbeat_rows:current.reduce((sum,e)=>sum+(e.recordCount??e.records?.length??0),0),
    historical_recovery_only:[...evidence.values()].filter(e=>e.carried).length,pending_devices:pending.size,
    warnings_count:warnings.length,message:'完整只读区间核查结束；报告及正式截止未写入'};
  await atomicWriteJson(path.join(directory,'result.json'),result);
  await atomicWriteJson(path.join(directory,'details.json'),{window,alarms,recovered,warnings,snapshots:Object.fromEntries(snapshots),evidence:Object.fromEntries(evidence),rows});
  return result;
}
async function main() {
  if(process.env.GITHUB_REF_NAME===process.env.JY_DEFAULT_BRANCH || process.env.JY_READONLY_FULL!=='true')throw new Error('只读完整测试仅允许独立分支显式运行');
  const config=await loadConfig(),root=config.projectRoot;
  const window=readOnlyWindow(process.env.JY_WINDOW_START,process.env.JY_WINDOW_END);
  const baseline=await protectedFiles(root),base=createRunLogger(root),started=Date.now(),phases=[];
  const logger={...base,progress(update){
    const next=update.phase;
    if(next && phases.at(-1)?.phase!==next)phases.push({phase:next,elapsed_seconds:(Date.now()-started)/1000});
    return base.progress(update.phase==='saving'?{...update,phase:'evidence',stage:'保存只读测试证据'}:update);
  }};
  let error;
  try {await runAudit(config,logger,{windowOverride:window,saveOutputs:saveReadOnlyOutputs});}
  catch(e){error=e;logger.progress({status:'error',stage:'只读测试未完成',error:String(e.message)});}
  finally {
    await logger.close();
    const unchanged=JSON.stringify(baseline)===JSON.stringify(await protectedFiles(root));
    const timing={start:window.startText,end:window.endText,started_at:new Date(started).toISOString(),finished_at:new Date().toISOString(),collector_seconds:(Date.now()-started)/1000,phases,protected_reports_state_unchanged:unchanged,status:error?'failure':'success',error:error?String(error.message):undefined};
    await atomicWriteJson(path.join(root,'run/read-only-window/timing.json'),timing);
    const evidence=await archiveFolders(root,[['run/read-only-window','result/'],['run/acquisition','acquisition/'],['run/heartbeat-diagnostics','diagnostics/'],['downloads','downloads/']]);
    await fs.mkdir(path.join(root,'run/speed-check'),{recursive:true});
    await fs.writeFile(path.join(root,'run/speed-check/full-window.zip'),evidence);
    for(const name of await fs.readdir(path.join(root,'run')))if(/^monitor-.*\.log$/.test(name))await fs.copyFile(path.join(root,'run',name),path.join(root,'run/private-logs',name));
    if(!unchanged)throw new Error('只读测试改变了报告或正式状态，验收失败');
  }
  if(error)throw error;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();

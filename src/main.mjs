import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { runAudit } from './audit-runner.mjs';
import { atomicWrite, atomicWriteJson, withRunLock } from './utils.mjs';
import { createRunLogger } from './progress.mjs';
import { beijingText } from './calendar.mjs';
import { reportHtml } from './audit-report.mjs';

const root=path.resolve(process.env.JY_ALARM_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const cancellation=new AbortController();
let committing=false,logger,config;
const cancel=()=>{if(committing){process.send?.({type:'cancel-rejected'});return;}cancellation.abort(new Error('用户已停止本次监测'));};
process.on('message',m=>{if(m?.type==='cancel')cancel();});process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
try {
  await withRunLock(path.join(root,'run/monitor.lock'),async()=>{
    logger=createRunLogger(root);logger.progress({stage:'启动',status:'running',completed:0,total:0});
    config=await loadConfig();config.signal=cancellation.signal;
    const result=await runAudit(config,logger,{beforeCommit:()=>{committing=true;process.send?.({type:'committing'});},onRetry:()=>{committing=false;process.send?.({type:'collecting'});}});
    if(result.status==='skipped'){
      await atomicWriteJson(config.paths.lastResult,result);
      logger.progress({status:'skipped',stage:result.message});
    }
    console.info(result.message);
  });
} catch(error) {
  if(error.code==='MONITOR_ALREADY_RUNNING'){console.error(error.message);process.exitCode=2;}
  else {
    const stopped=cancellation.signal.aborted, completed_at=beijingText(new Date());
    const status=stopped?'cancelled':'error';
    const message=stopped?'已停止本次核查，成功截止未推进，证据及续查进度已保留。':String(error.message);
    logger?.progress({status,stage:stopped?'已停止':'失败',error:message,active_workers:[]});
    const file=path.join(root,'reports/error',completed_at.slice(0,10)+'_JY报警监测异常.md');
    const loginHelp=process.env.JY_ALARM_RUNTIME==='github'?'登录问题请检查仓库Actions Secrets与平台账号状态。':'登录问题请打开“任务与设置”配置登录凭据。';
    await atomicWrite(file,`# 核查${stopped?'停止':'失败'}\n\n${completed_at}\n\n${message}\n\n${config?.auditPolicy==='current_day_pending'?'下次定时任务只核查当日区间，不补跑本次失败区间。':'下次沿用未完成截止续查。'}${loginHelp}\n`);
    await atomicWrite(path.join(root,'reports/运行状态.html'),reportHtml(`# 运行状态：${status}\n\n${completed_at}\n\n${message}\n\n成功截止未推进。`));
    await atomicWriteJson(path.join(root,'run/last-result.json'),{status,completed_at,message,error_report_path:file});
    console.error(message);process.exitCode=stopped?0:1;
  }
}
await logger?.close();
if(process.connected)process.disconnect();

import fs from "node:fs";
import path from "node:path";
import { formatLocalDateTime } from "./utils.mjs";
import { progressText, progressSummary } from './progress-view.mjs';
import { githubProgressPublisher } from './github-progress.mjs';

export function createRunLogger(projectRoot, { io = fs, output = console, tickMs = 15000 } = {}) {
  const directory = path.join(projectRoot, "run");
  try { io.mkdirSync(directory, { recursive: true }); } catch (error) { output.warn(`无法创建日志目录：${error.message}`); }
  const started = Date.now();
  const logPath = path.join(directory, `monitor-${formatLocalDateTime(new Date()).slice(0, 10)}-${process.pid}.log`);
  let state = { pid: process.pid, started_at: formatLocalDateTime(new Date()), status: "running", stage: "启动", log_path: logPath };
  const write = (level, message) => {
    const line = `[${formatLocalDateTime(new Date())}] ${message}`;
    try { io.appendFileSync(logPath, `${level} ${line}\n`, "utf8"); } catch { /* Diagnostics must not interrupt collection. */ }
    (level === "WARN" ? output.warn : output.info)(line);
  };
  let progressWarning = false;
  const publisher=githubProgressPublisher(process.env,{onError:message=>write('WARN',message)});
  let lastPrinted = '';
  const display = (force = false) => {
    const key = JSON.stringify([state.stage, state.completed, state.total, state.failed, state.status,state.recovery]);
    if (!force && key === lastPrinted) return;
    lastPrinted = key;
    write('INFO', progressText(state));
    for (const w of state.active_workers ?? []) write('INFO', `  通道 ${w.lane} → ${w.sn}：${w.stage}`);
    for (const b of state.recovery?.active_batches ?? []) write('INFO',`  复查批次 ${b.batch} → ${b.date} · ${b.sns.length}块 · ${b.sns.slice(0,3).join('、')}${b.sns.length>3?'等':''}：${b.stage}`);
  };
  const persist = () => {
    const target = path.join(directory, 'progress.json'), temporary = `${target}.${process.pid}.tmp`;
    try {
      io.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8'); io.renameSync(temporary, target);
      progressWarning = false; return true;
    } catch (error) {
      if (!progressWarning) write('WARN', `进度文件暂未更新，采集继续：${error.message}`);
      progressWarning = true; return false;
    }
  };
  const timer = tickMs > 0 ? setInterval(() => {
    if (state.status !== 'running') return;
    state.elapsed_seconds = Math.round((Date.now() - started) / 1000);
    if(state.recovery?.active)state.recovery={...state.recovery,elapsed_seconds:Math.round((Date.now()-state.recovery.started_ms)/1000)};
    persist(); display(true); publisher.update(state);
  }, tickMs).unref() : null;
  return {
    info: message => write("INFO", message),
    warn: message => write("WARN", message),
    progress: update => {
      state = { ...state, ...update, updated_at: formatLocalDateTime(new Date()), elapsed_seconds: Math.round((Date.now() - started) / 1000) };
      display(); publisher.update(state); return persist();
    },
    close: async () => {
      if (timer) clearInterval(timer);
      if (process.env.GITHUB_STEP_SUMMARY && process.env.JY_PUBLIC_RUN !== 'true') {
        try { io.appendFileSync(process.env.GITHUB_STEP_SUMMARY, progressSummary(state), 'utf8'); } catch { /* UI must not fail collection. */ }
      }
      await publisher.finish(state.status==='completed'?{...state,stage:'采集完成，等待工作流收尾'}:state,{terminal:false});
    },
  };
}

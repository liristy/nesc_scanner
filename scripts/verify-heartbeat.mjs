import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { JYPlatform } from "../src/platform.mjs";
import { createRunLogger } from "../src/progress.mjs";
import { atomicWriteJson, formatLocalDateTime, withRunLock } from "../src/utils.mjs";
import { buildWorkdayWindow } from '../src/time-window.mjs';

const sns = process.argv.slice(2);
if (!sns.length || sns.length > 5) throw new Error("请提供1至5个SN进行只读采集验收");
const config = await loadConfig();
await withRunLock(path.join(config.projectRoot, "run", "monitor.lock"), async () => {
  const logger = createRunLogger(config.projectRoot);
  logger.progress({ stage: "小批次只读验收", total: sns.length, completed: 0 });
  const started = Date.now();
  const { endText, reportDate } = buildWorkdayWindow(new Date(), config.windowCutoffTime, { mode: 'daily' });
  let platform;
  try {
    platform = await new JYPlatform(config, logger).open();
    if (process.env.JY_DIAGNOSTIC === '1') {
      const watch = page => {
        page.on('pageerror', error => logger.warn(`页面脚本：${error.message}`));
        page.on('response', response => { if (response.status() >= 400) logger.warn(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
      };
      for (const page of platform.context.pages()) watch(page);
      platform.context.on('page', watch);
    }
    await platform.fetchBatterySnapshots(sns, { evidenceSNs: sns, reportDate, endText });
    const evidence = [...platform.heartbeatEvidence.values()];
    const result = { completed_at: formatLocalDateTime(new Date()), seconds: (Date.now() - started) / 1000,
      results: evidence.map(e => ({ sn: e.sn, complete: e.complete, rows: e.readCount, error: e.error })) };
    await atomicWriteJson(path.join(config.projectRoot, "run", "smoke-result.json"), result);
    if (evidence.length !== sns.length || evidence.some(e => !e.complete)) throw new Error("小批次验收未全部通过");
    logger.progress({ status: "completed", stage: "小批次验收通过", completed: evidence.length });
    console.info(JSON.stringify(result));
  } catch (error) {
    logger.progress({ status: "error", stage: "验收失败", error: error.message });
    throw error;
  } finally { await platform?.close(); }
});

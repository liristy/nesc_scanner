import path from 'node:path';
import { currentDayWindow } from '../src/audit-policy.mjs';
import { AUDIT_CUTOFF_TEXT, beijingText, chinaDate } from '../src/calendar.mjs';
import { loadConfig } from '../src/config.mjs';
import { collectDailyAlarmRows } from '../src/daily-collection.mjs';
import { JYPlatform } from '../src/platform.mjs';
import { atomicWriteJson } from '../src/utils.mjs';

if (process.env.REPORT_BRANCH !== 'dev' || process.env.JY_PRIVATE_QUERY_ID) {
  throw new Error('完整报警窗口验收仅允许在 dev 单独手动运行');
}
const date = process.env.JY_CHECK_DATE;
const cutoff = chinaDate(`${date} ${AUDIT_CUTOFF_TEXT}`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(cutoff.getTime()) ||
    beijingText(cutoff).slice(0, 10) !== date || cutoff > new Date()) throw new Error('请输入已到统计截止的验收日期');
const config = await loadConfig();
const window = currentDayWindow(cutoff);
const output = path.join(config.projectRoot, 'run/speed-check/alarm-window.json');
const verification = { start: window.startText, end: window.endText, complete: false };
const platform = await new JYPlatform(config).open();
try {
  await platform.ensureLogin();
  const dates = [window.startDate, window.endDate];
  verification.platformCounts = [];
  for (const day of dates) {
    const query = platform.alarmQuery({ startDate: day, endDate: day }, []);
    const page = await platform.readAlarmTable(query);
    verification.platformCounts.push({ date: day, count: page.count });
  }
  const collected = await collectDailyAlarmRows(platform, window, null);
  verification.calendarRows = collected.allRowCount;
  verification.windowRows = collected.rows.length;
  verification.coverage = collected.coverage;
  const expected = verification.platformCounts.reduce((total, day) => total + day.count, 0);
  if (collected.allRowCount !== expected || !collected.rows.length ||
      !collected.coverage?.some(day => day.initialCount > 20000) ||
      verification.platformCounts.some(day => day.count > 20000 &&
        !collected.coverage.some(proof => proof.date === day.date && proof.uniqueCount === day.count)) ||
      collected.rows.some(row => row['最早报警时间'] <= window.startText || row['最早报警时间'] > window.endText)) {
    throw new Error('未能证明超限日期和完整统计窗口均已读齐');
  }
  verification.complete = true;
} catch (error) {
  verification.error = error.message;
  throw error;
} finally {
  await platform.close();
  await atomicWriteJson(output, verification);
}

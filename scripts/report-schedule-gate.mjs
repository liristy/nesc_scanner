import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { beijingText, chinaDate, buildDailyAuditWindow, CALENDAR_2026, isChinaWorkday, AUDIT_CUTOFF_TEXT } from '../src/calendar.mjs';
import { readJson } from '../src/utils.mjs';
import { currentDayPending, currentDayWindow, auditWindowNow } from '../src/audit-policy.mjs';

export function effectiveState(state = {}) {
  // Replay the last legacy interval under the new inclusive boundary and rules.
  return !state.last_success_cutoff && state.period?.start
    ? { ...state, last_success_cutoff: state.period.start } : state;
}
export async function reportScheduleDecision({ root = '.', now = new Date(), event = process.env.GITHUB_EVENT_NAME } = {}) {
  now=auditWindowNow(now,{date:process.env.JY_AUDIT_DATE,event,refName:process.env.GITHUB_REF_NAME,defaultBranch:process.env.JY_DEFAULT_BRANCH});
  const config = await readJson(path.join(root, process.env.JY_ALARM_CONFIG || 'github-config.json'), {});
  const state = effectiveState(await readJson(path.join(root, 'state/current_tracking.json'), {}));
  const pending = await readJson(path.join(root, 'state/pending_audit.json'));
  const collection = await readJson(path.join(root, 'state/daily_collection.json'), {});
  const calendars = config.workdayCalendars ?? [CALENDAR_2026];
  const pendingReport = !currentDayPending(config) && pending && (pending.publishReport ?? isChinaWorkday(pending.reportDate, calendars));
  const completed = pendingReport ? state.last_success_cutoff : collection.last_collection_cutoff || state.last_success_cutoff;
  const window = currentDayPending(config) ? currentDayWindow(now, state, collection, calendars) : pending && !(completed >= pending.endText)
    ? { ...pending, publishReport: pendingReport } : buildDailyAuditWindow(now, state, collection, calendars);
  const should_run = !window.alreadyComplete;
  return { should_run, report_date: window.reportDate, window,
    reason: should_run ? `${window.publishReport ? '工作日核查并生成报告' : '休息日采集与统计，正式报告截止不变'}（${window.startText}，${window.endText}]；${currentDayPending(config) ? '只核查当天，不补跑历史失败区间；对象读取失败归类为待确认。' : '复用每日已核验数据，失败沿用原截止续查。'}`
      : `截至 ${window.endText} 的采集区间已完成，跳过重复采集（当前北京时间 ${beijingText(now)}）。` };
}

// A cloud trigger can arrive a few minutes early. Wait for the real cutoff
// before selecting the window, without pretending that the data has arrived.
export async function scheduledReportDecision({ root = '.', clock = () => new Date(), sleep = delay,
  log = console.log, event = process.env.GITHUB_EVENT_NAME } = {}) {
  const arrival = clock();
  const cutoffText = `${beijingText(arrival).slice(0, 10)} ${AUDIT_CUTOFF_TEXT}`;
  const cutoff = chinaDate(cutoffText).getTime();
  const remaining = cutoff - arrival.getTime();
  if (!process.env.JY_AUDIT_DATE && ['push', 'workflow_dispatch'].includes(event) && remaining > 0 && remaining <= 15 * 60_000) {
    log(`当前北京时间 ${beijingText(arrival)}，提前触发；等待至 ${cutoffText} 后再判断当天采集区间。`);
    while (clock().getTime() < cutoff) {
      await sleep(Math.min(60_000, cutoff - clock().getTime()));
    }
  }
  return reportScheduleDecision({ root, now: clock(), event });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const decision = await scheduledReportDecision();
  console.log(`${decision.report_date}：${decision.reason}`);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `should_run=${decision.should_run}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## 核查调度\n\n${decision.reason}\n`);
}

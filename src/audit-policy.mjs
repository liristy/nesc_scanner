import { beijingText, shiftDay, chinaDate, isChinaWorkday, CALENDAR_2026, AUDIT_CUTOFF_TIME, AUDIT_CUTOFF_TEXT } from './calendar.mjs';

export const currentDayPending = config => config.auditPolicy === 'current_day_pending';
export function auditWindowNow(now, {date, event, refName, defaultBranch}={}) {
  if(!date)return now;
  if(event!=='workflow_dispatch' || !refName || !defaultBranch || refName===defaultBranch)
    throw new Error('指定日期重跑仅允许手动运行非主线分支');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('指定核查日期必须为YYYY-MM-DD');
  const cutoff=chinaDate(`${date} ${AUDIT_CUTOFF_TEXT}`);
  if(!Number.isFinite(cutoff.getTime()) || beijingText(cutoff).slice(0,10)!==date)throw new Error('指定核查日期无效');
  if(cutoff>now)throw new Error(`指定核查日期的${AUDIT_CUTOFF_TIME}尚未到达，不能提前伪造完整区间`);
  return cutoff;
}
export function currentDayWindow(now, reportState = {}, collectionState = {}, calendars = [CALENDAR_2026]) {
  const text = beijingText(now);
  const date = text.slice(11) < AUDIT_CUTOFF_TEXT ? shiftDay(text.slice(0, 10), -1) : text.slice(0, 10);
  const startText = `${shiftDay(date, -1)} ${AUDIT_CUTOFF_TEXT}`, endText = `${date} ${AUDIT_CUTOFF_TEXT}`;
  const completed = [reportState.last_success_cutoff, collectionState.last_collection_cutoff].filter(Boolean).sort().at(-1);
  return { start: chinaDate(startText), end: chinaDate(endText), startText, endText,
    startDate: startText.slice(0, 10), endDate: date, reportDate: date,
    publishReport: isChinaWorkday(date, calendars), initial: !reportState.last_success_cutoff,
    auditPolicy: 'current_day_pending', alreadyComplete: Boolean(completed && completed >= endText) };
}

// 国务院办公厅国办发明电〔2025〕7号。
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
export const CALENDAR_2026 = {
  year: 2026,
  holidays: [['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']],
  workdays: ['01-04','02-14','02-28','05-09','09-20','10-10'],
};
export const AUDIT_CUTOFF_TIME = '16:00';
export const AUDIT_CUTOFF_TEXT = `${AUDIT_CUTOFF_TIME}:00`;
export const reportArchiveName = (date, endText) => `${date.replaceAll('-', '')}-${(endText?.slice(11,19) || AUDIT_CUTOFF_TEXT).replaceAll(':','')}`;
export const beijingText = date => new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).format(date);
export const chinaDate = text => new Date(String(text).replace(' ', 'T') + (String(text).length === 10 ? 'T00:00:00+08:00' : '+08:00'));
export const shiftDay = (date, n) => beijingText(new Date(chinaDate(date).getTime() + n * 86400000)).slice(0,10);
export function isChinaWorkday(date, calendars = [CALENDAR_2026]) {
  const calendar = calendars.find(c => c.year === Number(date.slice(0,4)));
  if (!calendar) throw Object.assign(new Error(`${date.slice(0,4)}年法定工作日日历未配置，请更新日历；不猜测调休日期`), {code:'CALENDAR_REQUIRED'});
  const md = date.slice(5);
  if (calendar.workdays.includes(md)) return true;
  if (calendar.holidays.some(([a,b]) => md >= a && md <= b)) return false;
  return ![0,6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
}
export function buildAuditWindow(now, previousState = {}, calendars = [CALENDAR_2026]) {
  const nowText = beijingText(now);
  let date = nowText.slice(0,10);
  if (nowText.slice(11) < AUDIT_CUTOFF_TEXT) date = shiftDay(date,-1);
  while (!isChinaWorkday(date, calendars)) date = shiftDay(date,-1);
  const endText = `${date} ${AUDIT_CUTOFF_TEXT}`;
  let startText = previousState.last_success_cutoff;
  if (!startText) {
    let previous = shiftDay(date,-1);
    while (!isChinaWorkday(previous, calendars)) previous = shiftDay(previous,-1);
    startText = `${previous} ${AUDIT_CUTOFF_TEXT}`;
  }
  if (!Number.isFinite(chinaDate(startText).getTime())) throw new Error('上次成功截止时间无效');
  return {start:chinaDate(startText),end:chinaDate(endText),startText,endText,startDate:startText.slice(0,10),endDate:date,reportDate:date,
    initial:!previousState.last_success_cutoff, alreadyComplete:startText >= endText};
}

export function buildDailyAuditWindow(now, reportState = {}, collectionState = {}, calendars = [CALENDAR_2026]) {
  const report = buildAuditWindow(now, reportState, calendars);
  const nowText = beijingText(now);
  const date = nowText.slice(11) < AUDIT_CUTOFF_TEXT ? shiftDay(nowText.slice(0, 10), -1) : nowText.slice(0, 10);
  // Catch up a missed formal workday report before collecting later holidays.
  const overdueReport = reportState.last_success_cutoff && !report.alreadyComplete && report.reportDate < date;
  const endDate = overdueReport ? report.reportDate : date;
  const endText = `${endDate} ${AUDIT_CUTOFF_TEXT}`;
  const startText = reportState.last_success_cutoff || report.startText;
  const publishReport = isChinaWorkday(endDate, calendars);
  const completeThrough = publishReport ? reportState.last_success_cutoff
    : collectionState.last_collection_cutoff || reportState.last_success_cutoff;
  return { start: chinaDate(startText), end: chinaDate(endText), startText, endText,
    startDate: startText.slice(0, 10), endDate, reportDate: endDate, publishReport,
    initial: !reportState.last_success_cutoff, alreadyComplete: Boolean(completeThrough && completeThrough >= endText) };
}

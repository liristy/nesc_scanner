import { numericReading } from './evidence.mjs';
import { chinaDate } from './calendar.mjs';

export const LOW_VOLTAGE_RULE = Object.freeze({ lowVoltageThresholdV:2.58, lowVoltageDurationMinutes:4320 });

export function bmsSoftwareVersion(alarm) {
  if (alarm.detail?.bmsSoftwareVersionError) return '';
  return alarm.detail?.bmsSoftwareVersion || alarm.bmsSoftwareVersion || alarm.row?.['BMS版本'] || '';
}

export const IGNORED_ALARMS = new Set(['物联网模块已解绑','物联网卡号变更','BMS编号异常']);
export const alarmKey = a => `${a.sn}\0${a.type}`;
export function normalizeAlarm(row) {
  return {sn:row.sn ?? row.bms_number ?? row['电池组编号'], type:row.type ?? row.alarm_type ?? String(row['报警（级别：类型）'] ?? '').replace(/^保护\s*[:：]\s*/,''),
    time:row.time ?? row.alarm_time ?? row['最早报警时间'], repair:row.repair ?? row.repair_time ?? row['修复时间'] ?? '',
    vendor:row.vendor ?? row.bms_vendor ?? row['BMS厂商'], level:row.level ?? (/^保护\s*[:：]/.test(row['报警（级别：类型）'] ?? '') ? '保护' : ''),
    bmsSoftwareVersion:row.bmsSoftwareVersion ?? row.bms_software_version ?? row.bms_version ?? row['BMS版本'] ?? '', row};
}
export function collectAlarms(rows, previousItems, refreshed, window, checkedAt) {
  const current = rows.map(normalizeAlarm).filter(a => a.time > window.startText && a.time <= window.endText);
  const refresh = new Map(refreshed.map(normalizeAlarm).map(a => [`${alarmKey(a)}\0${a.time}`,a]));
  const legacyMissing = [];
  const prior = previousItems.map(item => {
    const a = normalizeAlarm(item);
    const verified = refresh.get(`${alarmKey(a)}\0${a.time}`);
    if (!verified && a.vendor !== 'JY') legacyMissing.push(a.sn);
    return verified ?? a;
  });
  const candidates = [...prior, ...current].filter(a => a.vendor === 'JY' && a.level === '保护' && a.time <= window.endText && !IGNORED_ALARMS.has(a.type));
  const continuing=new Set(prior.filter(a=>a.vendor==='JY' && a.level==='保护' && !(a.repair && Number.isFinite(chinaDate(a.repair).getTime()) && a.repair>=a.time && a.repair<=checkedAt)).map(alarmKey));
  const recovered = [], unresolved = new Map();
  for (const a of candidates) {
    if (!a.sn || !a.time) continue;
    const updated = refresh.get(`${alarmKey(a)}\0${a.time}`) ?? a;
    const repairDate = chinaDate(updated.repair);
    if (updated.repair && Number.isFinite(repairDate.getTime()) && updated.repair >= a.time && updated.repair <= checkedAt) { recovered.push(updated); continue; }
    const prior = unresolved.get(alarmKey(a));
    if (!prior || a.time > prior.time) unresolved.set(alarmKey(a), {...updated, origin:a.time > window.startText && !continuing.has(alarmKey(a)) ? '本区间新增' : '历史延续'});
  }
  return {alarms:[...unresolved.values()],recovered:[...new Map(recovered.map(a=>[`${alarmKey(a)}\0${a.time}`,a])).values()],legacyMissing};
}
export function classifyDifference(detail) {
  const bms = detail?.bms;
  const range = bms?.startsWith('F1') ? [2.7,4.2] : bms?.startsWith('F3') ? [2.6,3.6] : null;
  if (!range) return {status:'待复核',reason:'基本信息真实BMS类型未知或缺失',outliers:[]};
  const cells = detail?.cells ?? [];
  const outliers = cells.filter(c => Number.isFinite(c.voltage) && (c.voltage < range[0] || c.voltage > range[1]));
  if (outliers.length) return {status:'排除待复核',reason:'按约定归入平台／模块读数问题；未经现场确认',range,outliers};
  if (!detail.cellsComplete || !cells.length || cells.some(c=>!Number.isFinite(c.voltage))) return {status:'待复核',reason:detail.cellsError || '电芯电压证据不完整',range,outliers};
  return {status:'保留',reason:'已读取电芯均在约定范围内，含边界',range,outliers};
}
export function validVoltage(record) {
  if (record.abnormal || /异常数据/.test(`${record.event} ${record.dataStatus ?? ''}`)) return null;
  const min = numericReading(record.minVoltage), max = numericReading(record.maxVoltage);
  if (min === null || min <= 0 || min > 5 || (max !== null && (max < min || max > 5))) return null;
  return min;
}
export function analyzeWeek(evidence, endText) {
  const records = (evidence?.records ?? []).filter(r=>r.time <= endText && Number.isFinite(chinaDate(r.time).getTime())).sort((a,b)=>a.time.localeCompare(b.time));
  const samples = records.filter(r=>validVoltage(r) !== null);
  const latest = samples.at(-1), minVoltage = latest ? validVoltage(latest) : null;
  const latestValues = new Set(samples.filter(r=>r.time===latest?.time).map(validVoltage));
  const alarms = records.filter(r=>/^保护\s*[:：]\s*电量不足$/.test(r.event) && !r.abnormal && !/异常数据/.test(r.dataStatus ?? ''));
  const sleep = records.filter(r=>/进入低功耗/.test(r.event) && !r.abnormal);
  // All samples are sorted. A backward alarm chain stops at the most recent
  // recovery before its final alarm; rescanning every sample at every alarm
  // would make high-frequency batteries quadratic in the number of rows.
  const recoveryBeforeEnd = samples.findLast(r=>r.time<=alarms.at(-1)?.time && validVoltage(r)>=2.8)?.time;
  let chainStart=alarms.length-1;
  for (let i=alarms.length-2;i>=0;i--) {
    const gap = (chinaDate(alarms[chainStart].time)-chinaDate(alarms[i].time))/3600000;
    if (gap > 24 || recoveryBeforeEnd && recoveryBeforeEnd>=alarms[i].time && recoveryBeforeEnd<=alarms[chainStart].time) break;
    chainStart=i;
  }
  const chain=alarms.length?alarms.slice(chainStart):[];
  const start = chain[0]?.time, end = chain.at(-1)?.time;
  const spanHours = chain.length>1 ? (chinaDate(end)-chinaDate(start))/3600000 : 0;
  const gaps = [];
  if (!evidence?.complete) gaps.push(evidence?.error || '心跳读取不完整');
  if (!evidence?.historyComplete) gaps.push('近9天历史未完整读取');
  if (minVoltage === null || latestValues.size !== 1) gaps.push('有效最低电压缺失或同刻读数冲突');
  if (latest && (chinaDate(endText)-chinaDate(latest.time))/3600000 >24) gaps.push('最新有效电压距截止超过24小时');
  if (minVoltage !== null && minVoltage>=LOW_VOLTAGE_RULE.lowVoltageThresholdV) gaps.push('最新有效最低电压未低于2.58V');
  if (spanHours<LOW_VOLTAGE_RULE.lowVoltageDurationMinutes/60) gaps.push('有效保护报警跨度不足72小时或相邻记录间隔超过24小时');
  if (!end || (chinaDate(endText)-chinaDate(end))/3600000>24) gaps.push('末条有效保护报警距截止超过24小时');
  if (!sleep.some(r=>r.time>=start && r.time<=endText)) gaps.push('该证据段未见进入低功耗事件');
  if (start && samples.some(r=>r.time>=start && validVoltage(r)>=2.8)) gaps.push('证据段内最低电压曾回升至2.8V或以上');
  const confirmed = !gaps.length;
  return {confirmed,status:confirmed?'已确认需补电':minVoltage!==null && minVoltage<LOW_VOLTAGE_RULE.lowVoltageThresholdV?'低压优先复核':minVoltage!==null && minVoltage<2.8 && sleep.length?'低压保电观察':'证据待复核',
    minVoltage,latestTime:latest?.time ?? null,minimumVoltage:samples.length?samples.reduce((min,r)=>Math.min(min,validVoltage(r)),Infinity):null,
    spanHours,start,end,lowPowerEvents:sleep.map(r=>({time:r.time,event:r.event})),gaps,notification:'待通知',
    coverage:{from:records[0]?.time,to:records.at(-1)?.time}, abnormalCount:records.filter(r=>r.abnormal || /异常数据/.test(r.event)).length};
}

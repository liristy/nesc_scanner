import { alarmKey } from './audit-rules.mjs';
import { chinaDate } from './calendar.mjs';

// These describe an unconfirmed low-voltage risk, not a failure to
// read the latest voltage. Unknown gaps must remain eligible for follow-up.
const riskOnlyGaps = new Set([
  '近9天历史未完整读取', '最新有效最低电压未低于2.5V',
  '有效保护报警跨度不足168小时或相邻记录间隔超过24小时',
  '最新有效最低电压未低于2.58V',
  '有效保护报警跨度不足72小时或相邻记录间隔超过24小时',
  '末条有效保护报警距截止超过24小时', '该证据段未见进入低功耗事件',
  '证据段内最低电压曾回升至2.8V或以上',
]);

export function needsHistoricalRiskFollowup(alarm, cutoff) {
  if (alarm.recoveredVoltageFollowup || alarm.review || ['排除待复核', '待复核'].includes(alarm.difference?.status)) return true;
  const low = alarm.lowVoltage;
  if (!low) return false;
  if (low.confirmed || low.historicalConfirmed || !Number.isFinite(low.minVoltage) || low.minVoltage <= 0 || low.minVoltage > 5 || low.minVoltage < 2.8) return true;
  const sampleTime = chinaDate(low.latestTime).getTime(), end = chinaDate(cutoff).getTime();
  if (!Number.isFinite(sampleTime) || !Number.isFinite(end) || sampleTime > end || end - sampleTime > 24 * 3600000) return true;
  return !Array.isArray(low.gaps) || low.gaps.some(gap => !riskOnlyGaps.has(gap));
}

export function recoveredVoltageCandidates(selection, previousByKey, window, previousCutoff) {
  const active = new Set(selection.alarms.map(alarmKey));
  const candidates = new Map();
  for (const alarm of selection.recovered ?? []) {
    const key = alarmKey(alarm);
    if (active.has(key)) continue;
    const previous = previousByKey.get(key);
    const inWindow = alarm.time > window.startText;
    const recentRecovery = alarm.repair > window.startText && previous &&
      (!previous.lowVoltage || needsHistoricalRiskFollowup(previous, previousCutoff));
    const retainedLow = previous?.followupOnly && Number.isFinite(previous.lowVoltage?.minVoltage) &&
      previous.lowVoltage.minVoltage < 2.8;
    if (!inWindow && !recentRecovery && !retainedLow && !previous?.recoveredVoltageFollowup) continue;
    if (!candidates.has(key) || candidates.get(key).time < alarm.time) candidates.set(key, alarm);
  }
  return [...candidates.values()];
}

export function hasFreshVoltageAfterRecovery(alarm, evidence, observed, cutoff) {
  if (!evidence?.complete || evidence.carried || !Number.isFinite(observed?.minVoltage) ||
      observed.minVoltage <= 0 || observed.minVoltage > 5 ||
      observed.gaps?.includes('有效最低电压缺失或同刻读数冲突') ||
      (observed.latestInvalidVoltageTime && observed.latestInvalidVoltageTime >= observed.latestTime)) return false;
  const time = chinaDate(observed.latestTime).getTime();
  const end = chinaDate(cutoff).getTime();
  const repair = chinaDate(alarm.repair).getTime();
  return Number.isFinite(time) && Number.isFinite(end) && Number.isFinite(repair) &&
    time >= repair && time <= end && end - time <= 24 * 3600000;
}

export function buildAcquisitionPlan(selection, previousItems, cachedItems, window, {historicalReviewMode='full',previousCutoff=window.startText}={}) {
  const prior = [...previousItems, ...cachedItems].filter(a => a.vendor === 'JY');
  const previousRisks = [...new Map(prior.filter(a => needsHistoricalRiskFollowup(a,
    historicalReviewMode==='recovery_only' && a.historicalReview ? a.historicalReview.lastEvidenceCutoff :previousCutoff)).map(a => [alarmKey(a), a])).values()];
  const candidates = [...selection.alarms, ...previousRisks];
  const recovered = window.auditPolicy === 'current_day_pending'
    ? recoveredVoltageCandidates(selection, new Map(prior.map(a => [alarmKey(a), a])), window, previousCutoff) : [];
  const tracked = new Set([...candidates, ...recovered].map(a => a.sn));
  const trackedSNS = [...tracked];
  const current = new Set([...selection.alarms, ...recovered].filter(a => a.time > window.startText && a.time <= window.endText).map(a => a.sn));
  const recoveredChecks = new Set([...recovered, ...previousRisks.filter(a => a.recoveredVoltageFollowup)].map(a => a.sn));
  const sns = historicalReviewMode==='recovery_only' ? trackedSNS.filter(sn=>current.has(sn) || recoveredChecks.has(sn)) : trackedSNS;
  const historicalSNS = trackedSNS.filter(sn=>!sns.includes(sn));
  const legacy = new Set([...selection.alarms, ...prior.filter(a => a.lowVoltage || a.review || ['排除待复核', '待复核'].includes(a.difference?.status))].map(a => a.sn));
  return { previousRisks, sns, historicalSNS, trackedSNS, cellSNs: new Set(candidates.filter(a => sns.includes(a.sn) && a.type === '单体压差过大').map(a => a.sn)),
    scope: { current_window: current.size, history_only: sns.filter(sn => !current.has(sn)).length,
      total: sns.length, skipped_recovered_normal: [...legacy].filter(sn=>!tracked.has(sn)).length,
      ...(historicalReviewMode==='recovery_only'?{history_recovery_only:historicalSNS.length,tracked_total:trackedSNS.length}:{}) } };
}

import { alarmKey, isMonitoredAlarm } from './audit-rules.mjs';
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
  if (alarm.review || ['排除待复核', '待复核'].includes(alarm.difference?.status)) return true;
  const low = alarm.lowVoltage;
  if (!low) return false;
  if (low.confirmed || low.historicalConfirmed || !Number.isFinite(low.minVoltage) || low.minVoltage <= 0 || low.minVoltage > 5 || low.minVoltage < 2.8) return true;
  const sampleTime = chinaDate(low.latestTime).getTime(), end = chinaDate(cutoff).getTime();
  if (!Number.isFinite(sampleTime) || !Number.isFinite(end) || sampleTime > end || end - sampleTime > 24 * 3600000) return true;
  return !Array.isArray(low.gaps) || low.gaps.some(gap => !riskOnlyGaps.has(gap));
}

export function buildAcquisitionPlan(selection, previousItems, cachedItems, window, {historicalReviewMode='full',previousCutoff=window.startText}={}) {
  const prior = [...previousItems, ...cachedItems].filter(isMonitoredAlarm);
  const previousRisks = [...new Map(prior.filter(a => needsHistoricalRiskFollowup(a,
    historicalReviewMode==='recovery_only' && a.historicalReview ? a.historicalReview.lastEvidenceCutoff :previousCutoff)).map(a => [alarmKey(a), a])).values()];
  const candidates = [...selection.alarms, ...previousRisks];
  const trackedSNS = [...new Set(candidates.map(a => a.sn))];
  const current = new Set(selection.alarms.filter(a => a.time > window.startText && a.time <= window.endText).map(a => a.sn));
  const sns = historicalReviewMode==='recovery_only' ? trackedSNS.filter(sn=>current.has(sn)) : trackedSNS;
  const historicalSNS = trackedSNS.filter(sn=>!sns.includes(sn));
  const legacy = new Set([...selection.alarms, ...prior.filter(a => a.lowVoltage || a.review || ['排除待复核', '待复核'].includes(a.difference?.status))].map(a => a.sn));
  return { previousRisks, sns, historicalSNS, trackedSNS, cellSNs: new Set(candidates.filter(a => sns.includes(a.sn) && a.type === '单体压差过大').map(a => a.sn)),
    scope: { current_window: current.size, history_only: sns.filter(sn => !current.has(sn)).length,
      total: sns.length, skipped_recovered_normal: legacy.size - trackedSNS.length,
      ...(historicalReviewMode==='recovery_only'?{history_recovery_only:historicalSNS.length,tracked_total:trackedSNS.length}:{}) } };
}

import {isDeviceTimeout} from './pending-verification.mjs';
import { needsHistoricalRiskFollowup } from './acquisition-plan.mjs';

export function carryHistoricalAlarm(alarm, previous, evidence, snapshot, checkedAt, recoveryGap, previousCutoff) {
  const cutoff=evidence && Object.hasOwn(evidence,'coverageCutoff') ? evidence.coverageCutoff
    :previous?.historicalReview ? previous.historicalReview.lastEvidenceCutoff :previousCutoff;
  const detail=evidence?.detail ?? previous?.detail;
  const observed=evidence?.week;
  const low=observed && (previous?.lowVoltage || alarm.type==='电量不足' || observed.minVoltage===null || observed.minVoltage<2.8)
    ? observed :previous?.lowVoltage;
  let review=previous?.review;
  if(review?.recoveryPending && !recoveryGap && evidence?.complete && snapshot && detail?.bms &&
      !needsHistoricalRiskFollowup({...previous,review:undefined},cutoff))review=undefined;
  const reasons=[review?.reason,!evidence?.evidenceFile?'历史原始证据未取得，保留既有缺口':null,
    evidence?.complete===false?evidence.error || '历史心跳读取缺口尚未补齐':null,
    observed?.minVoltage===null?'有效电压证据缺失或异常，不能判正常':null,recoveryGap].filter(Boolean).flatMap(reason=>reason.split('；')).filter(Boolean);
  if(reasons.length)review={...review,kind:'reading_pending',status:'待确认',reason:[...new Set(reasons)].join('；'),recoveryPending:!!recoveryGap};
  if(review?.kind==='reading_pending' && isDeviceTimeout(review.reason))review={...review,status:'待验证',timeout:true};
  return {...previous,...alarm,detail,difference:previous?.difference,excluded:previous?.excluded,review,
    lowVoltage:low?{...low,confirmed:false,historicalConfirmed:previous?.lowVoltage?.confirmed || previous?.lowVoltage?.historicalConfirmed || false,
      status:'历史电压及风险记录，今日仅复查报警恢复；未重读心跳'}:null,
    historicalReview:{mode:'recovery_only',lastEvidenceCutoff:cutoff ?? null,checkedAt,recoveryPending:!!recoveryGap},
    evidenceSummary:`历史资料截至${cutoff || '未知'}；今日仅复查报警恢复，未重读详情、电芯或心跳。`};
}

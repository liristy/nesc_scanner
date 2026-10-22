import { alarmTypeOf, identityOf, parsePlatformDateTime } from "./utils.mjs";
import { EVIDENCE_DEFAULTS } from "./evidence.mjs";

export const TRACKING_STATUSES = new Set(["新增未恢复", "持续未恢复", "状态待确认"]);

export function directRecovery(row, checkedAt) {
  const repair = parsePlatformDateTime(row["修复时间"]);
  const alarm = parsePlatformDateTime(row["最早报警时间"]);
  const cutoff = parsePlatformDateTime(checkedAt);
  if (repair && (!alarm || repair >= alarm) && (!cutoff || repair <= cutoff)) return { recovered: true, reason: `平台记录修复时间：${row["修复时间"]}；非现场恢复证明` };
  return { recovered: false, reason: "" };
}

export function classifyHeartbeat(alertTimeText, snapshot, { alarmType, checkedAt, maxEvidenceAgeMinutes = EVIDENCE_DEFAULTS.maxEvidenceAgeMinutes } = {}) {
  if (!snapshot) return { status: "状态待确认", result: "未查询到该 BMS 的最新心跳摘要" };
  const alertTime = parsePlatformDateTime(alertTimeText);
  if (!alertTime) return { status: "状态待确认", result: "报警时间无法解析" };
  const check = parsePlatformDateTime(checkedAt);
  const latestTime = parsePlatformDateTime(snapshot.latestEvidenceTime);
  // A summary fetched after the cutoff must not veto valid historical detail.
  if (snapshot.evidenceComplete && check && latestTime && latestTime > alertTime && latestTime <= check &&
      (check - latestTime) / 60000 <= maxEvidenceAgeMinutes && snapshot.latestAlarmTypes?.includes(alarmType)) {
    return { status: "未恢复", result: `截止前最新有效心跳${snapshot.latestEvidenceTime}仍明确记录保护:${alarmType}；摘要状态${snapshot.batteryStatus || "空"}` };
  }
  const heartbeatTime = parsePlatformDateTime(snapshot.heartbeatTime);
  if (!heartbeatTime) return { status: "状态待确认", result: "最新心跳时间为空或无法解析" };
  if (alertTime && heartbeatTime <= alertTime) {
    return { status: "状态待确认", result: `最新心跳 ${snapshot.heartbeatTime} 未晚于报警时间` };
  }
  if (!check || heartbeatTime > check || (check - heartbeatTime) / 60000 > maxEvidenceAgeMinutes) {
    return { status: "状态待确认", result: `摘要时间${snapshot.heartbeatTime}过旧、晚于截止或缺少核查截止时间` };
  }
  return { status: "状态待确认", result: `摘要${snapshot.heartbeatTime}显示${snapshot.batteryStatus || "未知"}；缺少同一保护项的有效最新证据，不能判为已恢复。${snapshot.evidenceError || ""}` };
}

export function buildRollingResult({ currentRows, refreshedPreviousRows = [], previousState, snapshots, checkedAt, evidenceCutoff = checkedAt, maxEvidenceAgeMinutes = EVIDENCE_DEFAULTS.maxEvidenceAgeMinutes }) {
  const previousItems = Array.isArray(previousState?.items) ? previousState.items : [];
  const currentByIdentity = new Map(currentRows.map((row) => [identityOf(row), row]));
  const refreshedByIdentity = new Map(refreshedPreviousRows.map(row => [identityOf(row), row]));
  const candidateByIdentity = new Map();

  for (const item of previousItems) candidateByIdentity.set(identityOf(item), { previous: item, row: currentByIdentity.get(identityOf(item)) ?? refreshedByIdentity.get(identityOf(item)) ?? null });
  for (const row of currentRows) {
    const key = identityOf(row);
    if (!candidateByIdentity.has(key)) candidateByIdentity.set(key, { previous: null, row });
  }

  const tracking = [];
  const changes = [];
  for (const { previous, row } of candidateByIdentity.values()) {
    const source = row ?? previous;
    const normalized = {
      bms_number: source.bms_number ?? source["电池组编号"],
      alarm_type: source.alarm_type ?? alarmTypeOf(source["报警（级别：类型）"]),
      alarm_time: source.alarm_time ?? source["最早报警时间"],
      processing_status: row?.["处理状态"] ?? previous?.processing_status ?? "",
      repair_time: row?.["修复时间"] || previous?.repair_time || null,
    };
    const direct = row ? directRecovery(row, evidenceCutoff) : { recovered: false, reason: "" };
    const priorStatus = previous?.current_status ?? "本周期新增报警";
    if (direct.recovered) {
      changes.push({ ...normalized, previous_status: priorStatus, current_status: "本周期恢复", result: direct.reason });
      continue;
    }

    const heartbeat = classifyHeartbeat(normalized.alarm_time, snapshots.get(normalized.bms_number), { alarmType: normalized.alarm_type, checkedAt: evidenceCutoff, maxEvidenceAgeMinutes });

    const currentStatus = heartbeat.status === "未恢复"
      ? (previous ? "持续未恢复" : "新增未恢复")
      : "状态待确认";
    const snapshot = snapshots.get(normalized.bms_number);
    const item = {
      ...normalized,
      first_discovered_time: previous?.first_discovered_time ?? checkedAt,
      last_checked_time: checkedAt,
      latest_heartbeat_time: snapshot?.heartbeatTime ?? null,
      heartbeat_verification_result: heartbeat.result,
      latest_battery_status: snapshot?.batteryStatus ?? null,
      current_status: currentStatus,
    };
    tracking.push(item);
    if (!previous || previous.current_status !== currentStatus || previous.heartbeat_verification_result !== item.heartbeat_verification_result) {
      changes.push({ ...item, previous_status: priorStatus });
    }
  }

  tracking.sort((a, b) => a.bms_number.localeCompare(b.bms_number) || a.alarm_time.localeCompare(b.alarm_time) || a.alarm_type.localeCompare(b.alarm_type));
  return { tracking, changes };
}

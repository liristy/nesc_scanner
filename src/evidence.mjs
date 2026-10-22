import { parsePlatformDateTime } from "./utils.mjs";

export const EVIDENCE_DEFAULTS = Object.freeze({
  lowVoltageThresholdV: 2.5,
  lowVoltageDurationMinutes: 30,
  maxSampleGapMinutes: 5,
  maxEvidenceAgeMinutes: 30,
});

export function numericReading(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d+)?(?:\[\d+\])?$/.test(text)) return null;
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

// These are displayed table fields, never inferred from the list position or SOC.
export function heartbeatRecord(row) {
  return {
    time: row.TCreateTime ?? row["心跳时间"] ?? "",
    event: row.TBatteryHeartbeatStatus ?? row["心跳状态"] ?? "",
    workStatus: row.TBatteryStatus ?? row["工作状态"] ?? "",
    minVoltage: row.TMinVoltage ?? row["最低电压"] ?? "",
    maxVoltage: row.TMaxVoltage ?? row["最高电压"] ?? "",
    voltageDifference: row.TDiffVoltage ?? row["压差"] ?? "",
    maxTemperature: row.TMaxTemperatureNo ?? row["最高温度(℃)"] ?? "",
    mosTemperature: row.TMosTemperature ?? row["MOS温度"] ?? "",
    mosStatus: row.TMOSStatus ?? row["MOS管状态"] ?? "",
    abnormal: Object.values(row).some(v => typeof v === 'string' && /异常数据/.test(v)),
    dataStatus: row.TDataStatus ?? row['数据状态'] ?? '',
  };
}

export function crossCheckEvidence(evidence, snapshot, alarmTypes, endText, options = {}) {
  const settings = { ...EVIDENCE_DEFAULTS, ...options };
  const end = parsePlatformDateTime(endText);
  const physical = (evidence?.records ?? []).filter(r => r.minVoltage !== "" || r.maxVoltage !== "" || r.workStatus);
  const latestTime = physical.map(r => r.time).sort().at(-1);
  const latest = physical.filter(r => r.time === latestTime);
  const types = [...new Set(latest.filter(r => /^保护\s*[:：]/.test(r.event)).map(r => r.event.replace(/^保护\s*[:：]\s*/, "").trim()))];
  const warnings = [];
  if (!evidence?.complete) warnings.push(evidence?.error || "今日心跳未完整取得");
  if (!latestTime) warnings.push("今日没有有效遥测行");
  const t = parsePlatformDateTime(latestTime);
  if (t && end && (end - t) / 60000 > settings.maxEvidenceAgeMinutes) warnings.push("最新有效遥测过旧");
  if (t && end && t >= end) warnings.push("遥测时间不在统计截止之前");
  if (latestTime && snapshot?.heartbeatTime && latestTime !== snapshot.heartbeatTime) warnings.push("摘要采集时间与心跳有效遥测时间不同，不混作同一时刻");
  if (latest.some(r => r.workStatus && snapshot?.batteryStatus && r.workStatus !== snapshot.batteryStatus)) warnings.push("摘要状态与心跳工作状态不一致，需复核");
  const minValues = [...new Set(latest.map(r => numericReading(r.minVoltage)).filter(v => v !== null))];
  const maxValues = [...new Set(latest.map(r => numericReading(r.maxVoltage)).filter(v => v !== null))];
  if (minValues.length > 1 || maxValues.length > 1) warnings.push("同一时刻单体电压冲突");
  if (minValues.some(v => v <= 0 || v > 5) || maxValues.some(v => v <= 0 || v > 5)) warnings.push("单体电压零值或超出采样合理范围，不能当成实测结论");
  if (minValues.length === 1 && maxValues.length === 1 && minValues[0] > maxValues[0]) warnings.push("最低单体电压大于最高单体电压");
  const seen = alarmTypes.filter(type => types.includes(type));
  const missing = alarmTypes.filter(type => !types.includes(type));
  const status = !evidence?.complete || !t || !end || t >= end || (end - t) / 60000 > settings.maxEvidenceAgeMinutes
    ? "当前状态待核实"
    : seen.length ? `最新心跳仍见：${seen.join("、")}` : "最新心跳未见对应保护，不能认定恢复";
  if (missing.length && latestTime) warnings.push(`心跳最新时刻未见${missing.join("、")}，不代表未发生或已恢复`);
  return { status, latestTime: latestTime ?? null, latestTypes: types, warnings, latestReadings: latest[0] ?? null };
}

export function analyzeLowVoltage(evidence, { reportDate, endText, ...settings } = {}) {
  const options = { ...EVIDENCE_DEFAULTS, ...settings };
  const end = parsePlatformDateTime(endText);
  const rows = (evidence?.records ?? []).filter(r => {
    const t = parsePlatformDateTime(r.time);
    return t && String(r.time).startsWith(reportDate) && (!end || t < end);
  }).sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const sleep = rows.filter(r => /进入低功耗|进入休眠|欠压休眠|低压休眠/.test(r.event));
  const result = {
    status: "证据不足", reason: "今日心跳未完整取得", latestTime: null, minVoltage: null,
    sampledMinutes: 0, sampleCount: 0,
    sleepEvidence: sleep.length ? `见${sleep.at(-1).event}（${sleep.at(-1).time}）；未确认欠压原因` : "未见低压休眠直接证据；不等于未触发",
  };
  if (!evidence?.complete || !rows.length) return { ...result, reason: evidence?.error || result.reason };
  const groups = new Map();
  for (const row of rows) {
    // A business/sleep event's blank voltage is not zero and is not a sample.
    const v = numericReading(row.minVoltage);
    if (v === null && !row.workStatus && !/心跳数据|保护[:：]/.test(row.event)) continue;
    const group = groups.get(row.time) ?? new Set();
    group.add(v);
    const max = numericReading(row.maxVoltage);
    if (max !== null && (max <= 0 || max > 5 || (v !== null && max < v))) group.add(null);
    groups.set(row.time, group);
  }
  const samples = [...groups].map(([time, values]) => ({ time, values: [...values] }));
  if (!samples.length) return { ...result, reason: "今日没有有效最低单体电压，不能用总电压或SOC替代" };
  const latest = samples.at(-1);
  result.latestTime = latest.time;
  result.minVoltage = latest.values.length === 1 ? latest.values[0] : null;
  const ageMinutes = end ? (end - parsePlatformDateTime(latest.time)) / 60000 : Infinity;
  if (ageMinutes > options.maxEvidenceAgeMinutes) return { ...result, reason: `最新电压距统计截止${ageMinutes.toFixed(1)}分钟，不能证明当前状态` };
  const newestEvent = parsePlatformDateTime(rows.at(-1).time);
  if (rows.some(r => r.time > latest.time && /注册上线/.test(r.event))) return { ...result, reason: "最新电压后重新上线，不能沿用上线前电压判断当前状态" };
  if ((newestEvent - parsePlatformDateTime(latest.time)) / 60000 > options.maxSampleGapMinutes) {
    return { ...result, reason: "最新事件与有效电压相隔过久，不能沿用旧电压" };
  }
  if (latest.values.length !== 1 || result.minVoltage === null || result.minVoltage <= 0 || result.minVoltage > 5) {
    return { ...result, reason: "最新单体电压为零、超出采样合理范围或同一时刻读数冲突，需核实" };
  }
  if (result.minVoltage >= options.lowVoltageThresholdV) {
    return { ...result, status: "最新采样未满足低压条件", reason: `最新有效最低单体电压不低于${options.lowVoltageThresholdV}V；不推断此前是否休眠` };
  }
  let first = latest;
  let count = 1;
  let interrupted = "";
  for (let i = samples.length - 2; i >= 0; i--) {
    const sample = samples[i];
    if (rows.some(r => r.time > sample.time && r.time < first.time && /注册上线|进入低功耗|进入休眠/.test(r.event))) { interrupted = "采样间有上线/休眠事件，不能跨事件拼接持续低压"; break; }
    const gap = (parsePlatformDateTime(first.time) - parsePlatformDateTime(sample.time)) / 60000;
    if (gap > options.maxSampleGapMinutes) { interrupted = "低压采样之间存在时间缺口"; break; }
    if (sample.values.length !== 1 || sample.values[0] === null || sample.values[0] <= 0 || sample.values[0] > 5) { interrupted = "低压段内存在无效或冲突读数"; break; }
    if (sample.values[0] >= options.lowVoltageThresholdV) break;
    first = sample;
    count++;
  }
  result.sampledMinutes = (parsePlatformDateTime(latest.time) - parsePlatformDateTime(first.time)) / 60000;
  result.sampleCount = count;
  if (count >= 2 && result.sampledMinutes >= options.lowVoltageDurationMinutes) {
    return { ...result, status: "低压采样满足分析条件", reason: `连续可见采样低于${options.lowVoltageThresholdV}V，跨度${result.sampledMinutes.toFixed(1)}分钟；非固件触发或连续实测证明` };
  }
  return { ...result, reason: interrupted || `低压采样跨度不足${options.lowVoltageDurationMinutes}分钟或仅有单点` };
}

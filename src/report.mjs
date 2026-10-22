import { alarmTypeOf, groupCount, md } from "./utils.mjs";
import { buildFocus } from "./focus.mjs";
import { lowVoltageSummary } from "./narrative.mjs";

function groupForDisplay(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.bms_number}\u0000${item.alarm_type}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...item, event_count: 1 });
      continue;
    }
    current.event_count += 1;
    if (String(item.alarm_time) < String(current.alarm_time)) current.alarm_time = item.alarm_time;
    if (String(item.first_discovered_time ?? "") < String(current.first_discovered_time ?? "")) current.first_discovered_time = item.first_discovered_time;
    if (String(item.last_checked_time ?? "") > String(current.last_checked_time ?? "")) current.last_checked_time = item.last_checked_time;
  }
  return [...groups.values()].sort((a, b) => a.bms_number.localeCompare(b.bms_number) || a.alarm_type.localeCompare(b.alarm_type));
}

export function summarize({ periodRows, tracking, changes }) {
  const currentUnresolved = tracking.filter((item) => item.current_status === "新增未恢复" || item.current_status === "持续未恢复");
  const typeGroups = new Map();
  for (const row of periodRows) {
    const alarmType = String(row.__alarm_type ?? alarmTypeOf(row["报警（级别：类型）"])).trim() || "未标注报警类型";
    const bmsNumber = String(row["电池组编号"] ?? "").trim();
    const current = typeGroups.get(alarmType) ?? { alarmType, alarmCount: 0, bmsNumbers: new Set() };
    current.alarmCount += 1;
    if (bmsNumber) current.bmsNumbers.add(bmsNumber);
    typeGroups.set(alarmType, current);
  }
  const alarmTypeSummary = [...typeGroups.values()]
    .map((item) => ({ alarmType: item.alarmType, alarmCount: item.alarmCount, bmsCount: item.bmsNumbers.size }))
    .sort((a, b) => b.alarmCount - a.alarmCount || a.alarmType.localeCompare(b.alarmType, "zh-CN"));
  return {
    periodAlarmCount: periodRows.length,
    periodBmsCount: groupCount(periodRows, (row) => row["电池组编号"]),
    newUnresolvedCount: tracking.filter((item) => item.current_status === "新增未恢复").length,
    continuousUnresolvedCount: tracking.filter((item) => item.current_status === "持续未恢复").length,
    recoveredCount: changes.filter((item) => item.current_status === "本周期恢复").length,
    pendingCount: tracking.filter((item) => item.current_status === "状态待确认").length,
    currentUnresolvedBmsCount: groupCount(currentUnresolved, (item) => item.bms_number),
    alarmTypeSummary,
  };
}

export function oneLineSummary(summary, reportDate) {
  const typeText = summary.alarmTypeSummary.length
    ? summary.alarmTypeSummary.map((item) => `${item.alarmType}${item.alarmCount}条（${item.bmsCount}个BMS）`).join("、")
    : "无";
  return `${reportDate} JY保护报警：本周期${summary.periodAlarmCount}条、涉及${summary.periodBmsCount}个BMS；类型分布：${typeText}；新增未恢复${summary.newUnresolvedCount}条、持续未恢复${summary.continuousUnresolvedCount}条、平台记录修复${summary.recoveredCount}条、状态待确认${summary.pendingCount}条，最新证据仍见对应保护${summary.currentUnresolvedBmsCount}个BMS。`;
}

export function buildReport({ window, checkedAt, periodRows, tracking, changes, focus, verificationWarnings = [] }) {
  focus ??= buildFocus({ rows: periodRows, reportDate: window.reportDate, endText: window.endText });
  const summary = summarize({ periodRows, tracking, changes });
  const incomplete = focus.incompleteSNs ?? [];
  const partial = incomplete.length > 0 || verificationWarnings.length > 0;
  const status = partial ? "partial_success" : "success";
  const collectionNotice = partial
    ? `采集状态：部分完成；专项心跳有${incomplete.length}个SN未完整核查，历史复核限制${verificationWarnings.length}项。缺失证据不能视为设备正常。`
    : "采集状态：已完成查询范围内的分页与数量校验；不等同于设备状态全部确认。";
  const output = [`# JY 报警监测日报（${window.reportDate}）`, ""];
  output.push(collectionNotice, "");
  if (incomplete.length) output.push(`待补查SN：${incomplete.join("、")}`, "");
  output.push("## 一、统计周期", "", `${window.startText} ～ ${window.endText}（结束时间不含）`, "");
  output.push(focus.markdown);
  if (verificationWarnings.length) output.push("## 数据复核限制", "", ...verificationWarnings.map(w => `- ${md(w)}`), "");
  output.push("## 二、统计汇总", "", "| 指标 | 数量 |", "|---|---:|");
  output.push(`| 本周期保护报警总数 | ${summary.periodAlarmCount} |`);
  output.push(`| 涉及 BMS 数量 | ${summary.periodBmsCount} |`);
  output.push(`| 新增未恢复数量 | ${summary.newUnresolvedCount} |`);
  output.push(`| 持续未恢复数量 | ${summary.continuousUnresolvedCount} |`);
  output.push(`| 平台记录修复数量（非现场恢复证明） | ${summary.recoveredCount} |`);
  output.push(`| 状态待确认数量 | ${summary.pendingCount} |`);
  output.push(`| 最新证据仍见对应保护的 BMS 数量 | ${summary.currentUnresolvedBmsCount} |`, "");

  output.push("## 三、报警类型汇总", "", "| 报警类型 | 报警条数 | 涉及 BMS 数 | 占本周期比例 |", "|---|---:|---:|---:|");
  for (const item of summary.alarmTypeSummary) {
    const percentage = summary.periodAlarmCount ? `${((item.alarmCount / summary.periodAlarmCount) * 100).toFixed(1)}%` : "0.0%";
    output.push(`| ${md(item.alarmType)} | ${item.alarmCount} | ${item.bmsCount} | ${percentage} |`);
  }
  if (!summary.alarmTypeSummary.length) output.push("| — | 0 | 0 | 0.0% |");
  output.push("");

  const unresolved = groupForDisplay(tracking.filter((item) => item.current_status !== "状态待确认"));
  output.push("## 四、当前未恢复 BMS", "", "| BMS编号 | 报警类型 | 首次发现时间 | 最新检查时间 | 处理状态 | 修复时间 | 心跳结果 | 当前状态 |", "|---|---|---|---|---|---|---|---|");
  for (const item of unresolved) {
    const type = item.event_count > 1 ? `${item.alarm_type}（${item.event_count}条）` : item.alarm_type;
    output.push(`| ${md(item.bms_number)} | ${md(type)} | ${md(item.first_discovered_time)} | ${md(item.last_checked_time)} | ${md(item.processing_status)} | ${md(item.repair_time)} | ${md(item.heartbeat_verification_result)} | ${md(item.current_status)} |`);
  }
  if (!unresolved.length) output.push("| — | — | — | — | — | — | — | 当前无足够证据确认；不代表设备正常 |");
  output.push("");

  const displayedChanges = groupForDisplay(changes);
  output.push("## 五、本周期状态变化", "", "| BMS编号 | 报警类型 | 上一状态 | 当前状态 |", "|---|---|---|---|");
  for (const item of displayedChanges) {
    const type = item.event_count > 1 ? `${item.alarm_type}（${item.event_count}条）` : item.alarm_type;
    output.push(`| ${md(item.bms_number)} | ${md(type)} | ${md(item.previous_status)} | ${md(item.current_status)} |`);
  }
  if (!displayedChanges.length) output.push("| — | — | — | 本周期无状态变化 |");
  output.push("");

  const pending = groupForDisplay(tracking.filter((item) => item.current_status === "状态待确认"));
  if (pending.length) {
    output.push("## 六、状态待确认", "", "| BMS编号 | 报警类型 | 无法确认原因 |", "|---|---|---|");
    for (const item of pending) output.push(`| ${md(item.bms_number)} | ${md(item.alarm_type)} | ${md(item.heartbeat_verification_result)} |`);
    output.push("");
  }
  output.push(`> 最新检查时间：${checkedAt}`, "");
  const low = lowVoltageSummary(focus);
  const oneLine = `${collectionNotice} ${focus.concise} ${oneLineSummary(summary, window.reportDate)}`;
  const hotToday = periodRows.filter(row => String(row['最早报警时间']).startsWith(window.reportDate) && /高温|过温|温度过高/.test(row['报警（级别：类型）']));
  const brief = [`${window.reportDate} JY 电池监测简报`, '',
    `统计截至 ${window.endText}。重点项目仅统计今天首次发生、截至该时刻平台无有效修复时间的报警。`, '',
    ...(focus.summary ?? []).map(item => `${item.category}：${item.snCount}个SN，${item.recordCount}条报警记录。`),
    `合计${focus.uniqueSNCount ?? 0}个SN；压差与电量不足重叠${focus.overlap?.length ?? 0}个SN。`, '',
    low.text, '',
    `证据采集：${focus.evidenceSNCount ?? 0}/${focus.uniqueSNCount ?? 0}个重点SN已完整读取平台可见心跳。读取完整不代表设备正常。`,
    ...(hotToday.length ? [`高温补充：今天曾出现${hotToday.length}条高温报警（含平台已记录修复的项目），未修复数为0不代表今天没有发生。`] : []), '',
    `跨周期跟踪：${tracking.length}条仍需跟踪，其中${summary.pendingCount}条状态待确认。完整SN与原因见专项清单。`,
    `滚动统计范围：${window.startText}～${window.endText}（结束时刻不含）。`,
    ...(partial ? ['',collectionNotice] : []),
    ...(verificationWarnings.length ? [`历史复核限制${verificationWarnings.length}项，详见完整日报；受影响记录保留待核实。`] : [])].join("\n");
  return { markdown: output.join("\n"), summary, oneLine, brief, status };
}

export function buildExceptionReport({ reportDate, checkedAt, window, error }) {
  const lines = [
    `# JY 报警监测异常记录（${reportDate}）`,
    "",
    "**本周期数据获取不完整**",
    "",
    `- 检查时间：${checkedAt}`,
    `- 目标周期：${window ? `${window.startText} ～ ${window.endText}（结束时间不含）` : "无法确定"}`,
    `- 异常：${String(error?.message ?? error).replace(/\r?\n/g, " ")}`,
    "- 处理：未生成正常日报，未清空或覆盖 current_tracking.json。",
    "",
  ];
  return lines.join("\n");
}

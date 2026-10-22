import { alarmTypeOf, md } from "./utils.mjs";
import { directRecovery } from "./classify.mjs";
import { analyzeLowVoltage, crossCheckEvidence, EVIDENCE_DEFAULTS } from "./evidence.mjs";

export const FOCUS_CATEGORIES = ["单体压差过大", "电量不足", "高温相关保护"];
export function focusCategory(type) {
  const name = alarmTypeOf(type);
  if (name === "单体压差过大" || name === "电量不足") return name;
  if (/高温|过温|温度过高/.test(name)) return "高温相关保护";
  return null;
}

export function todayFocusRows(rows, reportDate, endText) {
  return rows.filter(r => String(r["最早报警时间"]).startsWith(reportDate) && (!endText || String(r["最早报警时间"]) < endText) && focusCategory(r["报警（级别：类型）"]) && !directRecovery(r, endText).recovered);
}

export function buildFocus({ rows, reportDate, endText, evidence = new Map(), snapshots = new Map(), options = {} }) {
  const selected = todayFocusRows(rows, reportDate, endText);
  const groups = new Map();
  for (const row of selected) {
    const sn = String(row["电池组编号"] ?? "").trim();
    if (!sn) throw new Error("专项报警缺少SN，不能完成去重统计");
    const category = focusCategory(row["报警（级别：类型）"]);
    const key = `${category}\0${sn}`;
    const item = groups.get(key) ?? { sn, category, count: 0, types: new Set(), latestAlarm: "", row: null };
    item.count++;
    item.types.add(alarmTypeOf(row["报警（级别：类型）"]));
    if (String(row["最早报警时间"]) >= item.latestAlarm) {
      item.latestAlarm = row["最早报警时间"];
      item.row = row;
    }
    groups.set(key, item);
  }
  const items = [...groups.values()].map(item => ({
    ...item, types: [...item.types].sort(),
    collection: evidence.get(item.sn)?.complete ? "今日心跳分页读取完整" : (evidence.get(item.sn)?.error || "未取得完整今日心跳"),
    snapshot: snapshots.get(item.sn) ?? null,
    crossCheck: crossCheckEvidence(evidence.get(item.sn), snapshots.get(item.sn), [...item.types], endText, options),
    lowVoltage: item.category === "电量不足" ? analyzeLowVoltage(evidence.get(item.sn), { reportDate, endText, ...options }) : null,
  })).sort((a, b) => FOCUS_CATEGORIES.indexOf(a.category) - FOCUS_CATEGORIES.indexOf(b.category) || a.sn.localeCompare(b.sn));
  const summary = FOCUS_CATEGORIES.map(category => {
    const subset = items.filter(i => i.category === category);
    return { category, recordCount: subset.reduce((n, i) => n + i.count, 0), snCount: subset.length, sns: subset.map(i => i.sn) };
  });
  const voltage = new Set(summary[0].sns);
  const overlap = summary[1].sns.filter(sn => voltage.has(sn));
  const uniqueSNCount = new Set(items.map(i => i.sn)).size;
  const incompleteSNs = [...new Set(items.filter(i => !evidence.get(i.sn)?.complete).map(i => i.sn))];
  const evidenceSNCount = uniqueSNCount - incompleteSNs.length;
  const text = summary.map(i => `${i.category}${i.recordCount}条/${i.snCount}个SN`).join("；");
  const concise = `今日专项（最早报警日期${reportDate}、截至${endText}，平台截至该时刻无有效修复记录）：${text}；合计${uniqueSNCount}个SN，压差与电量不足重叠${overlap.length}个SN。心跳完整读取${evidenceSNCount}/${uniqueSNCount}个SN；心跳不能单独证明恢复或未触发低压休眠。`;
  const lines = ["## 今日重点专项：压差、电量不足、高温保护", "", concise, "",
    "仅统计今日新发生且平台未记录有效修复时间的专项报警；不混入此前存量。记录条数不是触发次数。已关闭但无修复时间仍保留核查。", "",
    "| 专项 | 平台未恢复记录 | 去重SN |", "|---|---:|---:|", ...summary.map(i => `| ${i.category} | ${i.recordCount} | ${i.snCount} |`), "",
    "### 完整SN清单", "", "| 专项 | SN | 记录数 | 具体保护项 | 最新报警时间 | 报警时最低/最高单体V | 报警压差V | 报警最高温度/MOS℃ | 最新摘要时间/状态 | 证据采集 |", "|---|---|---:|---|---|---|---|---|---|---|"];
  for (const i of items) lines.push(`| ${i.category} | ${md(i.sn)} | ${i.count} | ${md(i.types.join("、"))} | ${md(i.latestAlarm)} | ${md(i.row["最低电压（V）"])}/${md(i.row["最高电压（V）"])} | ${md(i.row["压差（V）"])} | ${md(i.row["最高温度（℃）"])}/${md(i.row["MOS温度（℃）"])} | ${md(i.snapshot?.heartbeatTime)}/${md(i.snapshot?.batteryStatus)} | ${md(i.collection)} |`);
  if (!items.length) lines.push("| — | 今日查询范围未见上述未恢复记录 | 0 | — | — | — | — | — | — | — |");
  lines.push("", "### 报警、心跳与摘要交叉核对", "", "| SN | 专项 | 证据判断 | 最新遥测时间 | 遥测最低/最高单体V | 遥测最高温度/MOS℃ | 不一致与限制 |", "|---|---|---|---|---|---|---|");
  for (const i of items) {
    const c = i.crossCheck;
    const r = c.latestReadings;
    lines.push(`| ${md(i.sn)} | ${i.category} | ${md(c.status)} | ${md(c.latestTime)} | ${md(r?.minVoltage)}/${md(r?.maxVoltage)} | ${md(r?.maxTemperature)}/${md(r?.mosTemperature)} | ${md(c.warnings.join("；"))} |`);
  }
  const settings = { ...EVIDENCE_DEFAULTS, ...options };
  lines.push("", "### 电量不足：低压保电证据与SN", "",
    `分析条件：最低单体电压严格小于${settings.lowVoltageThresholdV}V，采样跨度至少${settings.lowVoltageDurationMinutes}分钟，相邻有效采样间隔不超过${settings.maxSampleGapMinutes}分钟；超过${settings.maxEvidenceAgeMinutes}分钟的电压不用于推断当前状态。时长是分析假设，未经固件规范确认。SOC不作判据。空值不作0，业务日志和低功耗事件不能替代电压采样。`, "",
    "| SN | 分析结果 | 最新有效电压时间 | 最低单体V | 采样跨度分钟 | 休眠证据 | 说明 |", "|---|---|---|---:|---:|---|---|");
  for (const i of items.filter(i => i.lowVoltage)) {
    const v = i.lowVoltage;
    lines.push(`| ${md(i.sn)} | ${md(v.status)} | ${md(v.latestTime)} | ${v.minVoltage ?? "缺失"} | ${v.sampledMinutes.toFixed(2)} | ${md(v.sleepEvidence)} | ${md(v.reason)} |`);
  }
  lines.push("", "平台无修复记录、当前设备实际异常和低压休眠是否触发是不同结论。低功耗摘要、正常单点、报警记录中没有某项或心跳未见某事件，均不能单独证明恢复或未触发。跨页数量、SN、日期或字段异常会保留待核实。", "");
  const analysisSettings = Object.fromEntries(Object.keys(EVIDENCE_DEFAULTS).map(key => [key, settings[key]]));
  return { summary, items, uniqueSNCount, overlap, evidenceSNCount, incompleteSNs, concise, analysisSettings, markdown: lines.join("\n") };
}

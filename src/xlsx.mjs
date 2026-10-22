import JSZip from "jszip";
import { alarmTypeOf, formatLocalDateTime, nonEmpty, parsePlatformDateTime } from "./utils.mjs";

const REQUIRED_HEADERS = [
  "最早报警时间",
  "修复时间",
  "电池组编号",
  "报警（级别：类型）",
  "处理状态",
  "BMS厂商",
];

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attribute(attributes, name) {
  return attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? "";
}

function columnIndex(cellReference) {
  const letters = String(cellReference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function textNodes(xml) {
  return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((match) => decodeXml(match[1])).join("");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((match) => textNodes(match[1]));
}

export function parseWorksheetXml(xml, sharedStrings = []) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const values = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const attributes = cellMatch[1];
      const inner = cellMatch[2];
      const reference = attribute(attributes, "r");
      const type = attribute(attributes, "t");
      const raw = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ?? "";
      let value;
      if (type === "s") value = sharedStrings[Number(raw)] ?? "";
      else if (type === "inlineStr") value = textNodes(inner);
      else value = decodeXml(raw);
      values[columnIndex(reference)] = value;
    }
    rows.push(values);
  }
  return rows;
}

export async function parseAlarmWorkbook(buffer, { vendor, start, end, endInclusive = false }) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const sheetEntry = zip.file("xl/worksheets/sheet1.xml") ?? Object.values(zip.files).find((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name));
  if (!sheetEntry) throw new Error("导出文件中没有工作表 XML");
  const [sheetXml, sharedXml] = await Promise.all([
    sheetEntry.async("string"),
    zip.file("xl/sharedStrings.xml")?.async("string") ?? Promise.resolve(""),
  ]);
  if (sheetXml.length > 100_000_000) throw new Error("工作表解压后超过 100MB 安全上限");
  const matrix = parseWorksheetXml(sheetXml, parseSharedStrings(sharedXml));
  if (!matrix.length) throw new Error("导出文件中没有数据行");
  const headers = matrix[0].map((value) => String(value ?? "").trim());
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`导出字段缺失：${missing.join("、")}`);

  const allRows = matrix.slice(1).map((values) => {
    const row = {};
    for (let column = 1; column < headers.length; column += 1) {
      if (headers[column]) row[headers[column]] = values[column] ?? null;
    }
    return row;
  }).filter((row) => Object.values(row).some(nonEmpty));

  const invalidVendor = allRows.find((row) => String(row["BMS厂商"] ?? "").trim().toUpperCase() !== vendor.toUpperCase());
  if (invalidVendor) throw new Error(`导出结果含非 ${vendor} 厂商数据，已停止，避免错误统计`);
  const invalidLevel = allRows.find((row) => !/^保护(?:\s*[:：]|$)/.test(String(row["报警（级别：类型）"] ?? "")));
  if (invalidLevel) throw new Error("导出结果包含非“保护”级别报警，已停止，避免错误统计");

  const rows = allRows.filter((row) => {
    const alarmTime = parsePlatformDateTime(row["最早报警时间"]);
    if (!alarmTime || !nonEmpty(row["电池组编号"])) throw new Error("导出行缺少有效报警日期或SN，停止以防静默漏计");
    return alarmTime && (endInclusive ? alarmTime > start && alarmTime <= end : alarmTime >= start && alarmTime < end);
  });
  for (const row of rows) {
    row["最早报警时间"] = formatLocalDateTime(parsePlatformDateTime(row["最早报警时间"]));
    if (nonEmpty(row["修复时间"])) {
      const repairTime = parsePlatformDateTime(row["修复时间"]);
      if (repairTime) row["修复时间"] = formatLocalDateTime(repairTime);
    }
    row.__alarm_type = alarmTypeOf(row["报警（级别：类型）"]);
  }
  return { allRowCount: allRows.length, rows };
}

export function toRawData(rows) {
  return rows.map((row) => ({
    alarm_time: row["最早报警时间"],
    repair_time: row["修复时间"] || null,
    model: row["型号"] ?? null,
    bms_number: row["电池组编号"],
    soc: row["当前SOC"] ?? null,
    platform_current_status: row["当前状态"] ?? null,
    alarm: row["报警（级别：类型）"],
    processing_status: row["处理状态"],
    max_temperature_c: row["最高温度（℃）"] ?? null,
    min_temperature_c: row["最低温度（℃）"] ?? null,
    temperature_difference_c: row["温差（℃）"] ?? null,
    mos_temperature_c: row["MOS温度（℃）"] ?? null,
    current_a: row["当时电流（A）"] ?? null,
    total_voltage_v: row["当时电压（V）"] ?? null,
    max_cell_voltage_v: row["最高电压（V）"] ?? null,
    min_cell_voltage_v: row["最低电压（V）"] ?? null,
    voltage_difference_v: row["压差（V）"] ?? null,
    work_status: row["工作状态"] ?? null,
    bms_version: row["BMS版本"] ?? null,
    bms_vendor: row["BMS厂商"],
    production_date: row["生产日期"] ?? null,
    remarks: row["备注"] || null,
  }));
}

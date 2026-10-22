import fs from "node:fs/promises";
import path from "node:path";

export const pad2 = (value) => String(value).padStart(2, "0");

export function formatLocalDateTime(date) {
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date);
}

export function parsePlatformDateTime(value) {
  if (value instanceof Date) return value;
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})[-\/]?(\d{1,2})[-\/]?(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const wall = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return Number.isNaN(wall.getTime()) || wall.getUTCFullYear() !== Number(year) || wall.getUTCMonth() !== Number(month) - 1 || wall.getUTCDate() !== Number(day) || wall.getUTCHours() !== Number(hour) || wall.getUTCMinutes() !== Number(minute) || wall.getUTCSeconds() !== Number(second) ? null : new Date(wall.getTime()-8*3600000);
}

export function nonEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function alarmTypeOf(value) {
  return String(value ?? "").replace(/^保护(?:\s*[:：]\s*)?/, "").trim() || "未标注报警类型";
}

export function identityOf(item) {
  const bms = item.bms_number ?? item["电池组编号"] ?? "";
  const type = item.alarm_type ?? alarmTypeOf(item["报警（级别：类型）"]);
  const time = item.alarm_time ?? item["最早报警时间"] ?? "";
  return `${bms}\u0000${type}\u0000${time}`;
}

export function groupCount(items, getter) {
  return new Set(items.map(getter).filter(nonEmpty)).size;
}

export function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, filePath);
}

export async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function md(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export async function withRunLock(lockPath, callback) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await fs.open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      const busy = new Error("已有一个监测任务正在运行；本次退出，避免重复查询。", { cause: error });
      busy.code = "MONITOR_ALREADY_RUNNING";
      throw busy;
    }
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

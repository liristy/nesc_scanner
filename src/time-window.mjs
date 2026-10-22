import { formatLocalDateTime, pad2 } from "./utils.mjs";
import { AUDIT_CUTOFF_TIME } from './calendar.mjs';

function parseCutoffTime(value) {
  const match = String(value ?? AUDIT_CUTOFF_TIME).trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`windowCutoffTime 必须是 HH:mm 格式，当前值为“${value}”`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function moveToPreviousWorkday(date) {
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1);
}

export function buildWorkdayWindow(now = new Date(), cutoffTime = AUDIT_CUTOFF_TIME, { endAtNow = false, mode = "workday" } = {}) {
  if (!["workday", "daily"].includes(mode)) throw new Error("窗口模式必须为 workday 或 daily");
  const { hour, minute } = parseCutoffTime(cutoffTime);

  if (endAtNow) {
    const end = new Date(now);
    end.setMilliseconds(0);
    const start = new Date(end);
    start.setHours(hour, minute, 0, 0);
    start.setDate(start.getDate() - 1);
    if (mode === "workday") moveToPreviousWorkday(start);
    return {
      start,
      end,
      startText: formatLocalDateTime(start),
      endText: formatLocalDateTime(end),
      startDate: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
      endDate: `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`,
      reportDate: `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`,
    };
  }

  const end = new Date(now);
  end.setHours(hour, minute, 0, 0);

  // 手动运行可能发生在截止时间前或周末，此时使用最近一个已经结束的工作日窗口。
  if (now.getTime() < end.getTime()) end.setDate(end.getDate() - 1);
  if (mode === "workday") moveToPreviousWorkday(end);

  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  if (mode === "workday") moveToPreviousWorkday(start);
  return {
    start,
    end,
    startText: formatLocalDateTime(start),
    endText: formatLocalDateTime(end),
    startDate: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
    endDate: `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`,
    reportDate: `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`,
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkdayWindow } from "../src/time-window.mjs";

test("每日模式周六、周日、周一均覆盖前一自然日，窗口连续", () => {
  for (const day of [29, 30, 31]) {
    const result = buildWorkdayWindow(new Date(2026, 7, day, 16, 15), "16:00", { mode: "daily" });
    assert.equal(result.startText, `2026-08-${day - 1} 16:00:00`);
    assert.equal(result.endText, `2026-08-${day} 16:00:00`);
  }
});

test("每日模式截止前取最近完整周期并正确跨月", () => {
  const result = buildWorkdayWindow(new Date(2026, 8, 1, 10), "16:00", { mode: "daily" });
  assert.equal(result.startText, "2026-08-30 16:00:00");
  assert.equal(result.endText, "2026-08-31 16:00:00");
});

test("每日模式支持跨年及手动窗口", () => {
  const result = buildWorkdayWindow(new Date(2027, 0, 1, 16, 15), "16:00", { mode: "daily" });
  assert.equal(result.startText, "2026-12-31 16:00:00");
  assert.equal(result.endText, "2027-01-01 16:00:00");
  const manual = buildWorkdayWindow(new Date(2026, 7, 31, 10), "16:00", { mode: "daily", endAtNow: true });
  assert.equal(manual.startText, "2026-08-30 16:00:00");
  assert.equal(manual.endText, "2026-08-31 10:00:00");
  assert.throws(() => buildWorkdayWindow(new Date(), "16:00", { mode: "invalid" }), /模式/);
});

test("默认周一窗口覆盖上周五16:00到周一16:00", () => {
  const result = buildWorkdayWindow(new Date(2026, 7, 31, 16, 30, 0));
  assert.equal(result.startText, "2026-08-28 16:00:00");
  assert.equal(result.endText, "2026-08-31 16:00:00");
});

test("默认普通工作日窗口为前一日16:00到当天16:00", () => {
  const result = buildWorkdayWindow(new Date(2026, 8, 1, 17, 0, 0));
  assert.equal(result.startText, "2026-08-31 16:00:00");
  assert.equal(result.endText, "2026-09-01 16:00:00");
});

test("周末手动运行使用最近一个已结束的工作日窗口", () => {
  const result = buildWorkdayWindow(new Date(2026, 7, 30, 16, 0, 0));
  assert.equal(result.startText, "2026-08-27 16:00:00");
  assert.equal(result.endText, "2026-08-28 16:00:00");
});

test("截止时间前手动运行不会查询未来窗口", () => {
  const result = buildWorkdayWindow(new Date(2026, 8, 1, 10, 0, 0));
  assert.equal(result.startText, "2026-08-28 16:00:00");
  assert.equal(result.endText, "2026-08-31 16:00:00");
});

test("支持修改窗口截止时间", () => {
  const result = buildWorkdayWindow(new Date(2026, 8, 1, 14, 0, 0), "13:30");
  assert.equal(result.startText, "2026-08-31 13:30:00");
  assert.equal(result.endText, "2026-09-01 13:30:00");
});

test("拒绝无效截止时间", () => {
  assert.throws(() => buildWorkdayWindow(new Date(), "25:00"), /HH:mm/);
});

test("手动运行统计到实际打开时间", () => {
  const result = buildWorkdayWindow(new Date(2026, 8, 2, 10, 23, 45), "16:00", { endAtNow: true });
  assert.equal(result.startText, "2026-09-01 16:00:00");
  assert.equal(result.endText, "2026-09-02 10:23:45");
});

test("手动运行晚于截止时间仍从前一工作日截止点开始", () => {
  const result = buildWorkdayWindow(new Date(2026, 8, 2, 18, 12, 30), "16:00", { endAtNow: true });
  assert.equal(result.startText, "2026-09-01 16:00:00");
  assert.equal(result.endText, "2026-09-02 18:12:30");
});

test("周一手动运行从上周五截止点统计到打开时间", () => {
  const result = buildWorkdayWindow(new Date(2026, 7, 31, 9, 5, 0), "16:00", { endAtNow: true });
  assert.equal(result.startText, "2026-08-28 16:00:00");
  assert.equal(result.endText, "2026-08-31 09:05:00");
});

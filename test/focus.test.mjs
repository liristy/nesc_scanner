import test from "node:test";
import assert from "node:assert/strict";
import { buildFocus, focusCategory } from "../src/focus.mjs";
import { buildReport } from "../src/report.mjs";

const alarm = (sn, type, time = "2026-09-10 10:00:00", repair = "") => ({ 电池组编号: sn, "报警（级别：类型）": `保护:${type}`, 最早报警时间: time, 修复时间: repair });
test("今日三类专项固定显示，SN按类别和总体分别去重，跨日及已修复排除", () => {
  const rows = [alarm("A", "单体压差过大"), alarm("A", "单体压差过大", "2026-09-10 11:00:00"), alarm("A", "电量不足"), alarm("B", "MOSFET高温"), alarm("B", "AFE检测充电高温故障"), alarm("C", "电量不足", "2026-09-09 17:00:00"), alarm("D", "电量不足", undefined, "2026-09-10 11:00:00"), alarm("E", "单体温差过大")];
  const focus = buildFocus({ rows, reportDate: "2026-09-10", endText: "2026-09-10 16:00:00" });
  assert.deepEqual(focus.summary.map(i => [i.recordCount, i.snCount]), [[2, 1], [1, 1], [2, 1]]);
  assert.equal(focus.uniqueSNCount, 2);
  assert.deepEqual(focus.overlap, ["A"]);
  assert.equal(focus.items[1].lowVoltage.status, "证据不足");
  assert.equal(focusCategory("单体温差过大"), null);
  assert.equal(focusCategory("AFE检测充电低温故障"), null);
  const report = buildReport({ window: { reportDate: "2026-09-10", endText: "2026-09-10 16:00:00" }, checkedAt: "2026-09-10 16:00:00", periodRows: rows, tracking: [], changes: [], focus });
  assert.match(report.brief, /单体压差过大：1个SN，2条报警记录/);
  assert.match(report.brief, /电量不足：1个SN，1条报警记录/);
  assert.match(report.brief, /高温相关保护：1个SN，2条报警记录/);
  assert.match(report.markdown, /\| 单体压差过大 \| A \| 2/);
});
test("没有专项记录也显示三个零，已关闭无修复时间仍保留", () => {
  const empty = buildFocus({ rows: [], reportDate: "2026-09-10" });
  assert.equal(empty.summary.length, 3);
  assert.match(empty.concise, /电量不足0条\/0个SN/);
  const focus = buildFocus({ rows: [{ ...alarm("A", "电量不足"), 处理状态: "已关闭" }], reportDate: "2026-09-10" });
  assert.equal(focus.uniqueSNCount, 1);
});
test("截止后才修复的记录按截止时仍未修复计，截止后的报警不纳入", () => {
  const focus = buildFocus({ rows: [alarm("A", "电量不足", undefined, "2026-09-10 17:00:00"), alarm("B", "电量不足", "2026-09-10 16:00:00")], reportDate: "2026-09-10", endText: "2026-09-10 16:00:00" });
  assert.deepEqual(focus.summary[1].sns, ["A"]);
  assert.deepEqual(focus.incompleteSNs, ["A"]);
});

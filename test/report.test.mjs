import assert from "node:assert/strict";
import test from "node:test";
import { buildReport } from "../src/report.mjs";

test("部分心跳失败必须在运行状态和简报显式标明", () => {
  const report = buildReport({ window: { reportDate: "2026-09-10", startText: "2026-09-09 14:00:00", endText: "2026-09-10 16:08:30" }, checkedAt: "2026-09-10 16:08:30",
    periodRows: [], tracking: [], changes: [],
    focus: { incompleteSNs: ["SN1"], markdown: "证据缺失", concise: "专项心跳0/1", items: [] } });
  assert.equal(report.status, "partial_success");
  assert.match(report.brief, /部分完成/);
  assert.match(report.markdown, /待补查SN：SN1/);
});

test("日报按报警类型汇总并把类型统计加入一句话总结", () => {
  const report = buildReport({
    window: { reportDate: "2026-09-03", startText: "2026-09-02 16:00:00", endText: "2026-09-03 16:00:00" },
    checkedAt: "2026-09-03 16:01:00",
    periodRows: [
      { 电池组编号: "BMS-001", "报警（级别：类型）": "保护：单体过压" },
      { 电池组编号: "BMS-001", "报警（级别：类型）": "保护：单体过压" },
      { 电池组编号: "BMS-002", "报警（级别：类型）": "保护：单体过压" },
      { 电池组编号: "BMS-003", "报警（级别：类型）": "保护：电量不足" },
    ],
    tracking: [],
    changes: [],
  });

  assert.deepEqual(report.summary.alarmTypeSummary, [
    { alarmType: "单体过压", alarmCount: 3, bmsCount: 2 },
    { alarmType: "电量不足", alarmCount: 1, bmsCount: 1 },
  ]);
  assert.match(report.markdown, /## 三、报警类型汇总/);
  assert.match(report.markdown, /\| 单体过压 \| 3 \| 2 \| 75\.0% \|/);
  assert.match(report.markdown, /\| 电量不足 \| 1 \| 1 \| 25\.0% \|/);
  assert.match(report.oneLine, /类型分布：单体过压3条（2个BMS）、电量不足1条（1个BMS）/);
});

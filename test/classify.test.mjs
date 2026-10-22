import assert from "node:assert/strict";
import test from "node:test";
import { buildRollingResult, classifyHeartbeat, directRecovery } from "../src/classify.mjs";

test("截止后的摘要不能否定截止前的新鲜同项保护证据", () => {
  const snapshot = { heartbeatTime: "2026-09-10 16:20:00", batteryStatus: "待机中", latestEvidenceTime: "2026-09-10 16:07:00", latestAlarmTypes: ["电量不足"], evidenceComplete: true };
  const options = { alarmType: "电量不足", checkedAt: "2026-09-10 16:08:30" };
  assert.equal(classifyHeartbeat("2026-09-10 15:00:00", snapshot, options).status, "未恢复");
  snapshot.latestEvidenceTime = "2026-09-10 16:09:00";
  assert.equal(classifyHeartbeat("2026-09-10 15:00:00", snapshot, options).status, "状态待确认");
});

test("恢复判断严格优先于心跳", () => {
  assert.deepEqual(directRecovery({ 修复时间: "2026-09-01 12:00:00", 处理状态: "待处理" }).recovered, true);
  assert.deepEqual(directRecovery({ 修复时间: "", 处理状态: "已关闭" }).recovered, false);
  assert.equal(directRecovery({ 修复时间: "2026-09-00 12:00:00" }).recovered, false);
  assert.deepEqual(directRecovery({ 修复时间: "", 处理状态: "待处理" }).recovered, false);
});

test("新鲜心跳明确包含同一保护项才确认未恢复", () => {
  const result = classifyHeartbeat("2026-09-01 10:00:00", { heartbeatTime: "2026-09-01 10:01:00", batteryStatus: "低功耗", latestEvidenceTime: "2026-09-01 10:01:00", latestAlarmTypes: ["电量不足"], evidenceComplete: true }, { alarmType: "电量不足", checkedAt: "2026-09-01 10:02:00" });
  assert.equal(result.status, "未恢复");
});

test("正常摘要和通用保护中均不能确认具体报警已恢复", () => {
  for (const batteryStatus of ["待机中", "低功耗", "充电中", "保护中"]) {
    const result = classifyHeartbeat("2026-09-01 10:00:00", { heartbeatTime: "2026-09-01 10:01:00", batteryStatus }, { alarmType: "单体压差过大", checkedAt: "2026-09-01 10:02:00" });
    assert.equal(result.status, "状态待确认");
  }
});

test("旧心跳或缺失心跳只能待确认", () => {
  assert.equal(classifyHeartbeat("2026-09-01 10:00:00", null).status, "状态待确认");
  assert.equal(classifyHeartbeat("2026-09-01 10:00:00", { heartbeatTime: "2026-09-01 09:59:59", batteryStatus: "待机中" }).status, "状态待确认");
});

test("滚动状态保留首次发现时间，并把未恢复改为持续未恢复", () => {
  const previous = {
    items: [{
      bms_number: "BMS-1",
      alarm_type: "电量不足",
      alarm_time: "2026-08-31 17:00:00",
      first_discovered_time: "2026-08-31 18:00:00",
      processing_status: "待处理",
      current_status: "新增未恢复",
    }],
  };
  const result = buildRollingResult({
    currentRows: [],
    previousState: previous,
    snapshots: new Map([["BMS-1", { heartbeatTime: "2026-09-01 16:00:00", batteryStatus: "保护中", latestEvidenceTime: "2026-09-01 16:00:00", latestAlarmTypes: ["电量不足"], evidenceComplete: true }]]),
    checkedAt: "2026-09-01 16:05:00",
  });
  assert.equal(result.tracking[0].current_status, "持续未恢复");
  assert.equal(result.tracking[0].first_discovered_time, "2026-08-31 18:00:00");
});

test("已关闭但无修复时间的报警保留跟踪", () => {
  const row = {
    电池组编号: "BMS-2",
    "报警（级别：类型）": "保护:电量不足",
    最早报警时间: "2026-09-01 11:00:00",
    修复时间: "",
    处理状态: "已关闭",
  };
  const result = buildRollingResult({ currentRows: [row], previousState: { items: [] }, snapshots: new Map(), checkedAt: "2026-09-01 16:05:00" });
  assert.equal(result.tracking.length, 1);
  assert.equal(result.changes[0].current_status, "状态待确认");
});

test("其他报警类型或旧的保护证据不能证明当前具体项仍异常", () => {
  const snapshot = { heartbeatTime: "2026-09-01 16:00:00", batteryStatus: "保护中", latestEvidenceTime: "2026-09-01 10:01:00", latestAlarmTypes: ["单体压差过大"], evidenceComplete: true };
  assert.equal(classifyHeartbeat("2026-09-01 10:00:00", snapshot, { alarmType: "单体压差过大", checkedAt: "2026-09-01 16:01:00" }).status, "状态待确认");
  snapshot.latestEvidenceTime = snapshot.heartbeatTime;
  assert.equal(classifyHeartbeat("2026-09-01 10:00:00", snapshot, { alarmType: "电量不足", checkedAt: "2026-09-01 16:01:00" }).status, "状态待确认");
});

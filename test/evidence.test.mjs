import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLowVoltage, crossCheckEvidence, numericReading } from "../src/evidence.mjs";

const options = { reportDate: "2026-09-10", endText: "2026-09-10 15:12:00" };
const row = (minute, voltage, event = "心跳数据") => ({ time: `2026-09-10 15:${String(minute).padStart(2, "0")}:00`, minVoltage: voltage, event });
const analyze = records => analyzeLowVoltage({ complete: true, records }, options);

test("严格小于2.5V；空值和占位符不是0V", () => {
  for (const value of ["", null, "-", "无", "2.7abc"]) assert.equal(numericReading(value), null);
  assert.equal(numericReading("2.79[13]"), 2.79);
  assert.equal(analyze([row(10, "2.50")]).status, "最新采样未满足低压条件");
  assert.equal(analyze([row(10, "0.00")]).status, "证据不足");
});

test("30分钟连续可见采样仅证明分析条件，低功耗事件不能证明欠压原因", () => {
  const result = analyzeLowVoltage({ complete: true, records: [...[0, 5, 10, 15, 20, 25, 30].map(m => row(m, "2.4")), row(31, "", "进入低功耗")] }, { ...options, endText: "2026-09-10 15:32:00" });
  assert.equal(result.status, "低压采样满足分析条件");
  assert.equal(result.sampledMinutes, 30);
  assert.match(result.sleepEvidence, /未确认欠压原因/);
});

test("默认时长边界：10分钟及29分59秒不满足，30分钟满足", () => {
  assert.equal(analyze([row(0, "2.4"), row(5, "2.4"), row(10, "2.4")]).status, "证据不足");
  const records = [0, 5, 10, 15, 20, 25].map(m => row(m, "2.49"));
  records.push({ ...row(29, "2.49"), time: "2026-09-10 15:29:59" });
  const settings = { ...options, endText: "2026-09-10 15:31:00" };
  assert.equal(analyzeLowVoltage({ complete: true, records }, settings).status, "证据不足");
  records.push(row(30, "2.49"));
  assert.equal(analyzeLowVoltage({ complete: true, records }, settings).status, "低压采样满足分析条件");
});

test("单点、大间隔、同时间冲突、缺失采样及重新上线均不凑持续时长", () => {
  for (const records of [
    [row(10, "2.4")],
    [row(0, "2.4"), row(10, "2.4")],
    [row(0, "2.4"), row(5, "2.4"), row(10, "2.4"), row(10, "3.1")],
    [row(0, "2.4"), row(5, ""), row(10, "2.4")],
    [row(0, "2.4"), row(5, "2.4"), row(6, "", "注册上线"), row(10, "2.4")],
  ]) assert.equal(analyze(records).status, "证据不足");
});

test("重复时间不增加时长；升压中断低压段", () => {
  assert.equal(analyze([row(10, "2.4"), row(10, "2.4")]).sampleCount, 1);
  assert.equal(analyze([row(0, "2.4"), row(5, "2.9"), row(10, "2.4")]).status, "证据不足");
});

test("部分分页、旧电压、跨日及截止后的记录都不能确认", () => {
  const records = [row(0, "2.4"), row(5, "2.4"), row(10, "2.4")];
  assert.equal(analyzeLowVoltage({ complete: false, records }, options).status, "证据不足");
  assert.equal(analyzeLowVoltage({ complete: true, records }, { ...options, endText: "2026-09-10 16:00:00" }).status, "证据不足");
  assert.equal(analyzeLowVoltage({ complete: true, records }, { ...options, reportDate: "2026-09-11" }).status, "证据不足");
  assert.equal(analyzeLowVoltage({ complete: true, records }, { ...options, endText: "2026-09-10 15:10:00" }).status, "证据不足");
});

test("页面实见的10.21V异常单体值不应生成低压正常结论", () => {
  const records = [{ ...row(10, "2.83[4]"), maxVoltage: "10.21[12]", workStatus: "保护中" }];
  assert.equal(analyze(records).status, "证据不足");
  const cross = crossCheckEvidence({ complete: true, records }, { heartbeatTime: records[0].time, batteryStatus: "待机中" }, ["单体压差过大"], options.endText);
  assert.ok(cross.warnings.some(s => s.includes("状态不一致")));
  assert.ok(cross.warnings.some(s => s.includes("超出")));
  assert.match(cross.status, /不能认定恢复/);
});

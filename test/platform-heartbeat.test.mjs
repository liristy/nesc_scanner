import test from "node:test";
import assert from "node:assert/strict";
import { JYPlatform, openHeartbeatTab, heartbeatDateTitle } from "../src/platform.mjs";
const tabLocator = click => ({filter(){return this;},first(){return this;},count:async()=>1,evaluate:async()=>false,click});

test('报告跨午夜后选择昨天，超出支持日期拒绝猜测', () => {
  const now = new Date('2026-09-24T16:01:00Z');
  assert.equal(heartbeatDateTitle('2026-09-24', 'Asia/Shanghai', now), '昨天');
  assert.equal(heartbeatDateTitle('2026-09-25', 'Asia/Shanghai', now), '今天');
  assert.throws(() => heartbeatDateTitle('2026-09-23', 'Asia/Shanghai', now), /超出/);
});

test("心跳标签首次点击未生效会重试，成功后停止；取消和非超时错误不重试", async () => {
  let clicks = 0;
  const timeout = Object.assign(new Error('Timeout: hidden panel'), { name: 'TimeoutError' });
  const frame = {
    getByText: () => tabLocator(async () => { clicks++; }),
    locator: () => ({ isVisible: async () => false, waitFor: async () => { if (clicks < 2) throw timeout; } }),
  };
  await openHeartbeatTab(frame, 60000);
  assert.equal(clicks, 2);
  const abort = new AbortController(); abort.abort(new Error('已停止'));
  await assert.rejects(openHeartbeatTab(frame, 60000, abort.signal), /已停止/);
  assert.equal(clicks, 2);
  frame.getByText = () => tabLocator(async () => { throw new Error('Frame detached'); });
  await assert.rejects(openHeartbeatTab(frame, 60000), /Frame detached/);
});

test("心跳页始终未打开时限制重试次数，不能继续当作成功", async () => {
  let clicks = 0;
  const frame = {
    getByText: () => tabLocator(async () => { clicks++; }),
    locator: () => ({ isVisible: async () => false, waitFor: async () => { throw Object.assign(new Error('Timeout'), { name: 'TimeoutError' }); } }),
  };
  await assert.rejects(openHeartbeatTab(frame, 60000), /Timeout/);
  assert.ok(clicks>0 && clicks<=100,'即使模拟wait立即失败也有有限次数边界');
});

// Recorded page contract: a modal under ReportCenter, a Today radio,
// visible row-count metadata and a non-stationary next-page button.
function fakePlatform(pages, totals, { stuck = false, header = "SN-1", pendingOverview = false } = {}) {
  let pageIndex = 0;
  let closed = false;
  let clickedSelector;
  const locator = (overrides = {}) => {
    const result = { count: async () => 1, waitFor: async () => {}, click: async () => {}, dblclick: async () => {}, isVisible: async () => true, isChecked: async () => true,
      ...overrides };
    result.first = result.last = result.filter = () => result;
    result.or = () => result;
    return result;
  };
  const frame = {
    waitForLoadState: async () => { if (pendingOverview) throw new Error('Timeout: overview assets block DOMContentLoaded and load'); },
    url: () => 'https://fixture.invalid/Reports/BatteryInfo/BatteryView?a=1',
    page: () => ({ on() {}, off() {}, waitForResponse: async () => ({ ok: () => true,
      json: async () => ({ code: 0, count: totals[pageIndex], data: pages[pageIndex] }) }) }),
    evaluate: async () => true, waitForFunction: async () => true,
    getByText: text => locator({ waitFor: async () => { if (text === "SN-1" && header !== text) throw new Error("SN mismatch"); } }),
    locator: selector => {
      if (selector.includes('username')) return locator({ isVisible: async () => false });
      if (selector.includes("laypage-limits")) return locator({ count: async () => 0 });
      if (selector.includes("laypage-count")) return locator({ textContent: async () => `共 ${totals[pageIndex]} 条` });
      if (selector.includes("layui-none")) return locator({ count: async () => 0 });
      if (selector.includes("laypage-next")) return locator({ click: async () => { if (!stuck) pageIndex++; } });
      return locator();
    },
  };
  const modal = locator({ elementHandle: async () => ({ contentFrame: async () => frame }) });
  const platform = new JYPlatform({ maxHeartbeatPages: 2, queryTimeoutMs: 100 });
  platform.now = () => new Date('2026-09-10T04:00:00Z');
  platform.page = { waitForFunction: async () => true, locator: selector => ({ getByText: () => locator({ dblclick: async () => { clickedSelector = selector; } }) }) };
  platform.detailHost = { locator: selector => selector.startsWith("iframe") ? modal : locator({ click: async () => { closed = true; } }) };
  platform.readRenderedTable = async () => pages[pageIndex];
  return { platform, isClosed: () => closed, clickedSelector: () => clickedSelector };
}
const row = (id, time = "2026-09-10 10:00:00") => ({ BatteryHeartbeatId: id, TCreateTime: time, TMinVoltage: "2.70[1]", TBatteryHeartbeatStatus: "保护:电量不足" });
const collect = platform => platform.fetchTodayHeartbeat("SN-1", "2026-09-10", "2026-09-10 12:00:00");

test('只更新详情仍校验SN并关闭弹窗，不触发心跳查询',async()=>{
  const mock=fakePlatform([[row('a')]],[1]);
  mock.platform.config.auditVersion=2;
  mock.platform.readAuditDetail=async()=>({sn:'SN-1',detailVersion:2});
  mock.platform.readRenderedTable=async()=>{throw new Error('不应扫描心跳');};
  const result=await mock.platform.fetchTodayHeartbeat('SN-1','2026-09-10','2026-09-10 12:00:00',{detailOnly:true});
  assert.equal(result.detail.sn,'SN-1');assert.equal(mock.isClosed(),true);
});

test("DOMContentLoaded未完成仍可读取已就绪的心跳，且保留SN核对", async () => {
  const ready = fakePlatform([[row('a')]], [1], { pendingOverview: true });
  const result = await collect(ready.platform);
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 1);
  assert.equal(ready.isClosed(), true);
  const wrong = fakePlatform([[row('a')]], [1], { pendingOverview: true, header: 'WRONG-SN' });
  await assert.rejects(collect(wrong.platform), /SN mismatch/);
});

test("心跳读取完整分页、限定截止并关闭对应详情", async () => {
  const mock = fakePlatform([[row("a")], [row("b", "2026-09-10 12:10:00")]], [2, 2]);
  const result = await collect(mock.platform);
  assert.equal(result.complete, true);
  assert.equal(result.readCount, 2);
  assert.equal(result.records.length, 1);
  assert.equal(mock.isClosed(), true);
  assert.equal(mock.clickedSelector(), ".layui-table-fixed-l:visible");
});
test("空的今日心跳只能形成零采样完整查询，不能凭空构造电压", async () => {
  const { platform } = fakePlatform([[]], [0]);
  assert.deepEqual((await collect(platform)).records, []);
});
test("总数变化、重复页、重复ID、跨日、字段变化及SN不符拒绝完整标记", async () => {
  const cases = [
    [fakePlatform([[row("a")], [row("b")]], [2, 3]), /总数变化/],
    [fakePlatform([[row("a")], [row("b")]], [2, 1]), /总数变化/],
    [fakePlatform([[row("a")], [row("b")]], [2, 2], { stuck: true }), /分页未推进/],
    [fakePlatform([[row("a")], [row("a", "2026-09-10 10:05:00")]], [2, 2]), /重复记录ID/],
    [fakePlatform([[row("a", "2026-09-09 10:00:00")]], [1]), /日期范围不匹配/],
    [fakePlatform([[{ BatteryHeartbeatId: 'a', TCreateTime: "2026-09-10 10:00:00" }]], [1]), /关键列/],
    [fakePlatform([[row("a")]], [1], { header: "WRONG-SN" }), /SN mismatch/],
  ];
  for (const [mock, expected] of cases) {
    await assert.rejects(collect(mock.platform), expected);
    assert.equal(mock.isClosed(), true);
  }
});

test('总数变化报错包含查询日期、页码、前后总数和分页大小', async () => {
  const mock = fakePlatform([[row('a')], [row('b')]], [2, 3]);
  await assert.rejects(collect(mock.platform), /2026-09-10 第2页，总数 2 → 3，每页50条/);
  assert.equal(mock.isClosed(), true);
});

test('分页变化后整轮重读，不拼接失败尝试的部分记录', async () => {
  const platform = new JYPlatform({}, { warn() {} });
  const attempts = [];
  platform.fetchTodayHeartbeat = async (...args) => {
    const mock = attempts.length
      ? fakePlatform([[row('fresh-a'), row('fresh-b')]], [2])
      : fakePlatform([[row('discarded')], [row('changed')]], [2, 3]);
    attempts.push(mock);
    return mock.platform.fetchTodayHeartbeat(...args);
  };
  const result = await platform.fetchHeartbeatWithRetry('SN-1', '2026-09-10', '2026-09-10 12:00:00');
  assert.equal(result.complete, true);
  assert.equal(result.readCount, 2);
  assert.deepEqual(result.records, (await collect(fakePlatform([[row('fresh-a'), row('fresh-b')]], [2]).platform)).records);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(mock => mock.isClosed()));
});

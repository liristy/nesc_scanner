import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { downloadAlarmRows } from '../src/alarm-export.mjs';
import { withAuditRetries } from '../src/audit-runner.mjs';
import { buildAuditWindow } from '../src/calendar.mjs';

const window = buildAuditWindow(new Date('2026-09-28T16:31:00+08:00'), { last_success_cutoff: '2026-09-24 16:00:00' });
const options = { vendor: 'JY', start: window.start, end: window.end, endInclusive: true };
const headers = ['最早报警时间', '修复时间', '电池组编号', '报警（级别：类型）', '处理状态', 'BMS厂商'];
const row = (time, sn = time) => [time, '', sn, '保护:电量不足', '未处理', 'JY'];
const limitError = () => Object.assign(new Error('超过单次导出上限'), { code: 'EXPORT_LIMIT' });
async function workbook(rows) {
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${[headers, ...rows].map((r, n) =>
    `<row>${r.map((v, i) => `<c r="${String.fromCharCode(65 + i)}${n + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
function fixture(rows, limit = 2) {
  const calls = [];
  const platform = { calls, async queryAlarmAndDownload(range, { bmsNumbers }) {
    calls.push({ ...range, bmsNumbers });
    const selected = rows.filter(r => r[0].slice(0, 10) >= range.startDate && r[0].slice(0, 10) <= range.endDate && (!bmsNumbers.length || bmsNumbers.includes(r[2])));
    if (selected.length > limit) throw limitError();
    return { buffer: await workbook(selected), resultCount: selected.length };
  } };
  return platform;
}

test('跨假期超限按不重叠日期递归分批，保留原始精确截止，边界不丢不重', async () => {
  const rows = [row(window.startText), row('2026-09-24 16:00:01'), row('2026-09-25 00:00:00'),
    row('2026-09-26 23:59:59'), row('2026-09-27 00:00:00'), row(window.endText), row('2026-09-28 16:00:01')];
  const platform = fixture(rows);
  const result = await downloadAlarmRows(platform, window, options);
  assert.equal(result.allRowCount, 7);
  assert.deepEqual(result.rows.map(r => r['电池组编号']), rows.slice(1, -1).map(r => r[2]));
  assert.deepEqual(platform.calls.filter(c => c.startDate === c.endDate).map(c => c.startDate),
    ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
  for (const call of platform.calls) {
    assert.equal(call.start, window.start);
    assert.equal(call.end, window.end);
    assert.equal(call.endText, window.endText);
  }
  assert.equal(new Set(platform.calls.map(c => c.reportDate)).size, platform.calls.length);
});

test('未超限保持单次导出，零条数据仍核对文件结构与数量', async () => {
  for (const rows of [[], [row('2026-09-26 10:00:00')]]) {
    const platform = fixture(rows);
    assert.equal((await downloadAlarmRows(platform, window, options)).allRowCount, rows.length);
    assert.equal(platform.calls.length, 1);
  }
});

test('分批中任一文件漏行即整体失败，不能合并成完整证据', async () => {
  let calls = 0;
  const platform = { async queryAlarmAndDownload() {
    if (++calls === 1) throw limitError();
    return { buffer: await workbook([row('2026-09-26 10:00:00')]), resultCount: calls >= 3 ? 2 : 1 };
  } };
  await assert.rejects(downloadAlarmRows(platform, window, options), /条数与页面不一致/);
});

test('计数不符只重查当前桶，丢弃失败文件；再次严格一致才返回完整结果',async()=>{
  let calls=0;
  const platform={async queryAlarmAndDownload(){
    calls++;
    return {buffer:await workbook([row(calls===1?'2026-09-26 10:00:00':'2026-09-26 11:00:00')]),resultCount:calls===1?2:1};
  }};
  const result=await downloadAlarmRows(platform,window,options);
  assert.equal(calls,2);assert.deepEqual(result.rows.map(r=>r['最早报警时间']),['2026-09-26 11:00:00']);
  calls=0;platform.queryAlarmAndDownload=async()=>{calls++;return {buffer:await workbook([]),resultCount:1};};
  await assert.rejects(downloadAlarmRows(platform,window,options),{code:'ALARM_COUNT_MISMATCH'});
  assert.equal(calls,3);
});

test('单日历史复核超限可按指定SN拆分，保持SN筛选并去除重复输入', async () => {
  const date = '2026-09-26';
  const platform = fixture(['A', 'B', 'C'].map(sn => row(`${date} 10:00:00`, sn)), 1);
  const result = await downloadAlarmRows(platform, { ...window, startDate: date, endDate: date }, options, { bmsNumbers: ['A', 'B', 'C', 'A'] });
  assert.deepEqual(result.rows.map(r => r['电池组编号']), ['A', 'B', 'C']);
  assert.ok(platform.calls.every(c => c.bmsNumbers.length > 0));
});

test('单日仍超限立即停止，不进行60/180秒的重复全流程尝试', async () => {
  const platform = fixture([row('2026-09-26 10:00:00'), row('2026-09-26 11:00:00')], 1);
  let attempts = 0;
  await assert.rejects(withAuditRetries(() => {
    attempts++;
    return downloadAlarmRows(platform, { ...window, startDate: '2026-09-26', endDate: '2026-09-26' }, options);
  }, { wait: () => assert.fail('不应等待重试') }), /单日报警仍超过/);
  assert.equal(attempts, 1);
});

test('普通网络或筛选错误不触发拆分，取消时不再查询', async () => {
  const error = new Error('筛选条件复核失败');
  let calls = 0;
  await assert.rejects(downloadAlarmRows({ async queryAlarmAndDownload() { calls++; throw error; } }, window, options), e => e === error);
  assert.equal(calls, 1);
  const platform = fixture([]);
  platform.config = { signal: AbortSignal.abort(new Error('取消')) };
  await assert.rejects(downloadAlarmRows(platform, window, options), /取消/);
  assert.equal(platform.calls.length, 0);
});

test('长期积压的拆分查询有总次数边界，不能无限循环或返回部分结果', async () => {
  let calls = 0;
  const platform = { async queryAlarmAndDownload(range) {
    calls++;
    if (range.startDate !== range.endDate) throw limitError();
    return { buffer: await workbook([]), resultCount: 0 };
  } };
  await assert.rejects(downloadAlarmRows(platform, { ...window, startDate: '2026-01-01' }, options), /127次上限/);
  assert.equal(calls, 127);
});

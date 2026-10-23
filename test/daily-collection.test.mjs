import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { buildDailyAuditWindow, shiftDay } from '../src/calendar.mjs';
import { runAudit, evidenceName } from '../src/audit-runner.mjs';
import { readDailyCache, collectDailyAlarmRows, loadRollingEvidence } from '../src/daily-collection.mjs';
import { atomicWriteJson, readJson } from '../src/utils.mjs';
import { prepare, finalize, stageEvidence, importEvidence } from '../scripts/cloud-runtime.mjs';
import { JYPlatform } from '../src/platform.mjs';
import { collectHeartbeatHistory } from '../src/heartbeat-history.mjs';
import { analyzeWeek } from '../src/audit-rules.mjs';

const prior = { last_success_cutoff: '2026-09-30 16:00:00', items: [] };
const logger = { info() {}, warn() {}, progress() {} };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jy-daily-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), prior);
  await atomicWriteJson(path.join(root, 'github-config.json'), {});
  return { projectRoot: root, vendor: 'JY', maxTrackingRefreshBatches: 100,
    paths: { state: path.join(root, 'state/current_tracking.json'), reports: path.join(root, 'reports'),
      dailyReports: path.join(root, 'reports/daily_reports'), data: path.join(root, 'data'), lastResult: path.join(root, 'run/last-result.json') } };
}
const headers = ['最早报警时间', '修复时间', '电池组编号', '报警（级别：类型）', '处理状态', 'BMS厂商'];
const row = (sn, date) => Object.fromEntries(headers.map((h, i) => [h, [date, '', sn, '保护:电量不足', '未处理', 'JY'][i]]));
async function workbook(rows) {
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${[headers, ...rows.map(r => headers.map(h => r[h]))].map((r, n) =>
    `<row>${r.map((v, i) => `<c r="${String.fromCharCode(65 + i)}${n + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('国庆七天每天采集，8号只导出新增区间，正式报告仍覆盖9月30日16:00到10月8日16:00', async t => {
  const config = await fixture(t), queries = [];
  const formalBefore = await fs.readFile(config.paths.state, 'utf8');
  const allRows = [row('start-excluded', prior.last_success_cutoff),
    ...Array.from({ length: 8 }, (_, i) => row(`SN-${i + 1}`, `2026-10-0${i + 1} 15:00:00`)),
    row('end-included', '2026-10-08 16:00:00'), row('future-excluded', '2026-10-08 16:00:01')];
  let today;
  class Platform {
    async open() {} async close() {}
    async queryAlarmAndDownload(query, { bmsNumbers }) {
      if (!bmsNumbers.length) queries.push(query);
      const rows = allRows.filter(r => r['最早报警时间'].slice(0, 10) >= query.startDate && r['最早报警时间'].slice(0, 10) <= query.endDate
        && (!bmsNumbers.length || bmsNumbers.includes(r['电池组编号']))).map(r => ({ ...r,
        '修复时间': r['电池组编号'] === 'SN-1' && today >= '2026-10-03' ? '2026-10-03 15:30:00' : '' }));
      return { buffer: await workbook(rows), resultCount: rows.length };
    }
    async fetchBatterySnapshots(sns) {
      this.heartbeatEvidence = new Map(sns.map(sn => [sn, { complete: true, historyComplete: false,
        records: [{ time: `${today} 15:00:00`, minVoltage: 3.4, maxVoltage: 3.5, event: '' }],
        detail: { sn, detailVersion: 2, bms: 'F1-fixture', cellsComplete: true, cells: [{ index: 1, voltage: 3.4 }] } }]));
      return new Map(sns.map(sn => [sn, { detail: this.heartbeatEvidence.get(sn).detail }]));
    }
  }
  for (let day = 1; day <= 8; day++) {
    today = `2026-10-0${day}`;
    const now = new Date(`${today}T16:35:00+08:00`);
    const result = await runAudit(config, logger, { now, clock: () => now, Platform, retryOptions: { delays: [] } });
    assert.equal(result.status, 'success');
    assert.equal(queries.at(-1).startText, day === 1 ? prior.last_success_cutoff : `2026-10-0${day - 1} 16:00:00`);
    assert.equal((await readJson(path.join(config.projectRoot, 'state/daily_collection.json'))).last_collection_cutoff, `${today} 16:00:00`);
    if (day < 8) {
      assert.equal(result.mode, 'collection');
      assert.equal(await fs.readFile(config.paths.state, 'utf8'), formalBefore);
      assert.equal(await fs.access(path.join(config.paths.reports, '今日电池报警简报.md')).then(() => true, () => false), false);
      const duplicate = await runAudit(config, logger, { now, Platform });
      assert.equal(duplicate.status, 'skipped');
    } else {
      assert.deepEqual(result.period, { start: prior.last_success_cutoff, end_inclusive: '2026-10-08 16:00:00' });
      const saved = await readJson(config.paths.state);
      assert.equal(saved.last_success_cutoff, '2026-10-08 16:00:00');
      await fs.access(path.join(config.paths.reports,'20261008-160000/今日电池报警简报.md'));
      assert.deepEqual(saved.items.map(a => a.sn).sort(), ['SN-2', 'SN-3', 'SN-4', 'SN-5', 'SN-6', 'SN-7', 'SN-8', 'end-included']);
      assert.ok(saved.items.every(a => a.origin === '本区间新增'));
      const report = await fs.readFile(path.join(config.paths.reports, '今日电池报警简报.md'), 'utf8');
      assert.match(report, /2026-09-30 16:00:00/);
      assert.match(report, /2026-10-08 16:00:00/);
    }
  }
  assert.equal(queries.length, 8);
});

test('假期采集成功后上传失败回滚每日截止；原正式报告截止、趋势及未完成日期保持不变', async t => {
  const config = await fixture(t), root = config.projectRoot;
  await prepare(root, new Date('2026-10-01T16:00:00+08:00'));
  await atomicWriteJson(path.join(root, 'state/daily_collection.json'), { last_collection_cutoff: '2026-10-01 16:00:00' });
  await atomicWriteJson(config.paths.lastResult, { status: 'success', mode: 'collection' });
  assert.equal((await finalize(root, { monitorOutcome: 'success' })).complete, false);
  assert.deepEqual(await readJson(config.paths.state), prior);
  assert.equal(await readJson(path.join(root, 'state/daily_collection.json')), null);
  const pending = await readJson(path.join(root, 'state/pending_audit.json'));
  assert.equal(pending.endText, '2026-10-01 16:00:00');
  assert.equal(pending.publishReport, false);
  await prepare(root, new Date('2026-10-03T16:00:00+08:00'));
  assert.equal((await readJson(path.join(root, 'run/pending-audit.json'))).endText, pending.endText);
});

test('每日缓存仅随证据包恢复；丢失或截止不匹配时重新覆盖完整正式区间', async t => {
  const config = await fixture(t), root = config.projectRoot;
  const window = buildDailyAuditWindow(new Date('2026-10-08T16:00:00+08:00'), prior);
  const cache = { complete: true, startText: prior.last_success_cutoff, endText: '2026-10-07 16:00:00', rows: [] };
  await atomicWriteJson(path.join(root, 'state/daily_collection.json'), { last_collection_cutoff: cache.endText });
  assert.equal(await readDailyCache(root, window), null);
  await atomicWriteJson(path.join(root, 'run/restored/daily/collection.json'), cache);
  await atomicWriteJson(path.join(root, 'run/restored/daily/session.json'), { cookie: 'fixture' });
  await importEvidence(root); await stageEvidence(root);
  assert.deepEqual(await readDailyCache(root, window), cache);
  assert.deepEqual(await fs.readdir(path.join(root, 'run/cloud-bundle/daily')), ['collection.json']);
  await atomicWriteJson(path.join(root, 'state/daily_collection.json'), { last_collection_cutoff: '2026-10-06 16:00:00' });
  const invalid = await readDailyCache(root, window);
  assert.equal(invalid, null);
  let queried;
  await collectDailyAlarmRows({ async queryAlarmAndDownload(q) { queried = q; return { buffer: await workbook([]), resultCount: 0 }; } }, window, invalid);
  assert.equal(queried.startText, prior.last_success_cutoff);
});

test('跨日心跳只复用完整历史日，上次16:00截止的那天必须补齐晚间数据', async t => {
  const config = await fixture(t), platform = new JYPlatform(config, logger);
  const priorCutoff = '2026-10-07 16:00:00';
  const saved = { sn: 'A', cutoff: priorCutoff, evidence: { complete: true, historyComplete: true,
    historyDays: Array.from({ length: 10 }, (_, i) => shiftDay('2026-10-07', -i)),
    records: Array.from({ length: 10 }, (_, i) => ({ time: `${shiftDay('2026-10-07', -i)} 12:00:00`, minVoltage: 2.4, maxVoltage: 3 })) } };
  await atomicWriteJson(path.join(config.projectRoot, '跟踪数据', evidenceName('A')), saved);
  platform.cachedAuditEvidence = await loadRollingEvidence(config.projectRoot, '2026-10-08 16:00:00');
  const calls = [];
  platform.fetchHeartbeatWithRetry = async (sn, date) => {
    calls.push(date);
    return { sn, complete: true, detail: { sn, cellsComplete: true }, records: [{ time: `${date} ${date === '2026-10-07' ? '20:00:00' : '12:00:00'}`, minVoltage: 2.4, maxVoltage: 3 }] };
  };
  platform.saveAcquisitionCheckpoint = async () => {};
  const result = await platform.fetchAuditEvidence('A', '2026-10-08', '2026-10-08 16:00:00');
  assert.deepEqual(calls, ['2026-10-08', '2026-10-07']);
  assert.equal(result.complete, true);
  assert.equal(result.historyDays.length, 10);
  assert.equal(result.records.length, 10);
  assert.ok(result.records.some(r => r.time === '2026-10-07 20:00:00'));
  assert.equal(result.coverageCutoff, '2026-10-08 16:00:00');
  assert.equal(result.detail.cellsComplete, true);
});

test('失败或无完整日期清单的历史心跳不复用；工作日漏跑及调休补班仍按正式报告处理', async () => {
  const platform = new JYPlatform({}, logger), calls = [];
  platform.cachedAuditEvidence = new Map([['A', { complete: false, coverageCutoff: '2026-10-07 16:00:00', historyDays: ['2026-10-06'], records: [] }]]);
  platform.fetchHeartbeatWithRetry = async (_, date) => { calls.push(date); return { complete: true, records: [] }; };
  platform.saveAcquisitionCheckpoint = async () => {};
  assert.equal((await platform.fetchAuditEvidence('A', '2026-10-08', '2026-10-08 16:00:00')).historyComplete, true);
  assert.equal(calls.length, 10);
  assert.equal(buildDailyAuditWindow(new Date('2026-10-10T16:00:00+08:00'), { last_success_cutoff: '2026-10-09 16:00:00' }).publishReport, true);
  const overdue = buildDailyAuditWindow(new Date('2026-10-01T16:00:00+08:00'), { last_success_cutoff: '2026-09-29 16:00:00' });
  assert.equal(overdue.endText, '2026-09-30 16:00:00');
  assert.equal(overdue.publishReport, true);
});

test('同一截止历史失败后复用已经完整的当前日及历史日，仍刷新详情并补齐缺口',async t=>{
  const config=await fixture(t),p=new JYPlatform(config,logger),calls=[];
  const sn='A',reportDate='2026-10-03',endText=reportDate+' 16:00:00';
  await p.saveAcquisitionCheckpoint(`history-${Buffer.from(sn).toString('hex')}`,new Map(),new Map([[sn,{coverageCutoff:endText,complete:false,historyCoverageVersion:1,historyDays:[reportDate,'2026-10-02'],records:[{time:reportDate+' 12:00:00',minVoltage:'2.4'},{time:'2026-10-02 20:00:00',minVoltage:'2.4'}]}]]),{reportDate,endText});
  let detailRefreshes=0;
  p.fetchTodayHeartbeat=async(_,date,end,options)=>{assert.equal(options.detailOnly,true);detailRefreshes++;return {detail:{customer:'当前客户'}};};
  p.fetchHeartbeatWithRetry=async(_,date)=>{calls.push(date);return {complete:true,records:[]};};
  const e=await p.fetchAuditEvidence(sn,reportDate,endText);assert.equal(e.complete,true);assert.equal(detailRefreshes,1);assert.equal(calls.length,8);assert.ok(!calls.includes(reportDate)&&!calls.includes('2026-10-02'));assert.equal(e.records.length,2);assert.equal(e.detail.customer,'当前客户');
  const cache=await readJson(path.join(config.projectRoot,'run/acquisition',`history-${Buffer.from(sn).toString('hex')}.json`));assert.equal(cache.endText,endText);assert.equal(cache.evidence.A.historyDays.length,10);
});

test('跨日从部分失败证据只复用已核验整日，补齐后与冷启动原始数据及判定一致',async t=>{
  const config=await fixture(t),sn='A',reportDate='2026-10-15',endText=reportDate+' 16:00:00';
  const priorDate='2026-10-14',cutoff=priorDate+' 16:00:00';
  const rows=date=>date==='2026-10-07'?[]:[
    {time:date+' 12:00:00',minVoltage:2.4,maxVoltage:3,event:'保护:电量不足'},
    {time:date+' 12:01:00',minVoltage:2.4,maxVoltage:3,event:'进入低功耗'}];
  const partial=await collectHeartbeatHistory({sn,reportDate:priorDate,coverageCutoff:cutoff,complete:true,records:rows(priorDate)},
    Array.from({length:9},(_,i)=>shiftDay(priorDate,-i-1)),async date=>{
      if(date==='2026-10-06')throw new Error('历史分页超时');
      return {complete:true,records:rows(date)};
    },async()=>{});
  assert.equal(partial.complete,false);assert.equal(partial.historyDays.length,8);
  await atomicWriteJson(path.join(config.projectRoot,'跟踪数据',evidenceName(sn)),{sn,cutoff,evidence:partial});
  const outputs=[];
  for(const reuse of [false,true]) {
    const p=new JYPlatform(config,logger),calls=[];
    if(reuse)p.cachedAuditEvidence=await loadRollingEvidence(config.projectRoot,endText,{compact:true,sns:[sn]});
    p.saveAcquisitionCheckpoint=async()=>{};
    p.fetchHeartbeatWithRetry=async(_,date)=>{
      calls.push(date);
      // The prior cutoff day must be reread, including its evening records.
      return {complete:true,records:[...rows(date),...(date===priorDate?[{time:date+' 20:00:00',minVoltage:2.4,maxVoltage:3,event:''}]:[])]};
    };
    const result=await p.fetchAuditEvidence(sn,reportDate,endText);outputs.push(result);
    assert.equal(result.complete,true);assert.equal(result.historyDays.length,10);
    assert.equal(result.historyMetrics.reusedDays,reuse?7:0);
    if(reuse)assert.deepEqual(calls,[reportDate,priorDate,'2026-10-06']);
    else assert.equal(calls.length,10);
  }
  assert.deepEqual(outputs[1].records,outputs[0].records);
  assert.deepEqual(analyzeWeek(outputs[1],endText),analyzeWeek(outputs[0],endText));
  assert.equal(analyzeWeek(outputs[1],endText).confirmed,true);
});

test('旧版失败证据、错误SN文件与未来证据不作为跨日缓存；旧版当前日需重新读取',async t=>{
  const config=await fixture(t),sn='A',reportDate='2026-10-14',endText=reportDate+' 16:00:00';
  const file=path.join(config.projectRoot,'跟踪数据',evidenceName(sn));
  const evidence={complete:false,historyDays:['2026-10-13'],records:[]};
  for(const saved of [
    {sn,cutoff:'2026-10-13 16:00:00',evidence},
    {sn:'OTHER',cutoff:'2026-10-13 16:00:00',evidence:{...evidence,historyCoverageVersion:1}},
    {sn,cutoff:'2026-10-15 16:00:00',evidence:{...evidence,historyCoverageVersion:1}},
  ]) {
    await atomicWriteJson(file,saved);
    assert.equal((await loadRollingEvidence(config.projectRoot,endText)).size,0);
  }
  const p=new JYPlatform(config,logger),calls=[];
  await p.saveAcquisitionCheckpoint(`history-${Buffer.from(sn).toString('hex')}`,new Map(),new Map([[sn,
    {...evidence,coverageCutoff:endText,historyDays:[reportDate]}]]),{reportDate,endText});
  p.fetchHeartbeatWithRetry=async(_,date)=>{calls.push(date);return {complete:true,records:[]};};
  p.fetchTodayHeartbeat=async()=>assert.fail('旧版检查点不能认证当前日');
  assert.equal((await p.fetchAuditEvidence(sn,reportDate,endText)).complete,true);
  assert.equal(calls[0],reportDate);assert.equal(calls.length,10);
});

test('业务范围在导出总数校验后筛选，完整及部分旧缓存都排除其他类型',async()=>{
  const window={startText:'2026-09-27 16:00:00',endText:'2026-09-28 16:00:00',
    start:new Date('2026-09-27T16:00:00+08:00'),end:new Date('2026-09-28T16:00:00+08:00'),
    startDate:'2026-09-27',endDate:'2026-09-28',reportDate:'2026-09-28'};
  const low=row('low','2026-09-28 12:00:00');
  const diff={...low,'电池组编号':'diff','报警（级别：类型）':'保护:单体压差过大'};
  const other={...low,'电池组编号':'other','报警（级别：类型）':'保护:短路'};
  const full=await collectDailyAlarmRows({queryAlarmAndDownload(){assert.fail('完整缓存不重复导出');}},window,
    {endText:window.endText,rows:[low,diff,other]});
  assert.deepEqual(full.rows,[low,diff]);
  const platform={async queryAlarmAndDownload(){return {buffer:await workbook([diff,other]),resultCount:2};}};
  const partial=await collectDailyAlarmRows(platform,window,{endText:'2026-09-28 11:00:00',rows:[low,other]});
  assert.deepEqual(partial.rows.map(r=>r['电池组编号']),['low','diff']);
  assert.equal(partial.allRowCount,2);
  await assert.rejects(collectDailyAlarmRows({async queryAlarmAndDownload(){return {
    buffer:await workbook([other]),resultCount:2};}},window),/导出条数与页面不一致/);
});

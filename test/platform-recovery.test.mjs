import test from 'node:test';
import assert from 'node:assert/strict';
import { JYPlatform } from '../src/platform.mjs';

test('重复分页只为该SN启用较大分页，成功或失败后均恢复默认策略', async () => {
  for (const retryFails of [false, true]) {
    const platform = new JYPlatform({}, { warn() {} });
    let attempts = 0;
    platform.fetchTodayHeartbeat = async () => {
      if (++attempts === 1) throw new Error('心跳分页未推进');
      assert.equal(platform.heartbeatPageSize, 300);
      if (retryFails) throw new Error('仍然重复');
      return { complete: true };
    };
    if (retryFails) await assert.rejects(platform.fetchHeartbeatWithRetry('SN', 'date'), /仍然重复/);
    else assert.equal((await platform.fetchHeartbeatWithRetry('SN', 'date')).complete, true);
    assert.equal(attempts, 2);
    assert.equal(platform.heartbeatPageSize, undefined);
  }
});

test('总数变化启用较大分页，连续两次变化后可恢复，并记录日期、阶段及原始原因', async () => {
  const warnings = [], sizes = [], argumentsSeen = [];
  const platform = new JYPlatform({}, { warn: message => warnings.push(message) });
  platform.heartbeatPageSize = 100;
  platform.fetchTodayHeartbeat = async (...args) => {
    argumentsSeen.push(args); sizes.push(platform.heartbeatPageSize);
    platform.lastHeartbeatStep = '读取心跳第2页';
    if (sizes.length < 3) throw new Error('心跳分页期间总数变化：2026-09-27 第2页，总数 51 → 52，每页50条，请重新查询');
    return { complete: true, records: [{ id: 'fresh' }] };
  };
  const result = await platform.fetchHeartbeatWithRetry('SN', '2026-09-27', '2026-09-27 16:00:00');
  assert.equal(result.complete, true);
  assert.deepEqual(sizes, [100, 300, 300]);
  assert.equal(platform.heartbeatPageSize, 100);
  assert.deepEqual(argumentsSeen, Array(3).fill(['SN', '2026-09-27', '2026-09-27 16:00:00']));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /SN 2026-09-27 心跳分页期间总数变化.*较大分页.*重试1\/2.*读取心跳第2页.*51 → 52/);
  assert.match(warnings[1], /重试2\/2/);
});

test('持续变化最多读取三次，最终抛错且恢复分页设置', async () => {
  const platform = new JYPlatform({}, { warn() {} });
  let attempts = 0;
  platform.fetchTodayHeartbeat = async () => { attempts++; throw new Error('心跳分页期间总数变化'); };
  await assert.rejects(platform.fetchHeartbeatWithRetry('SN', '2026-09-27'), /总数变化/);
  assert.equal(attempts, 3);
  assert.equal(platform.heartbeatPageSize, undefined);
});

test('超时后发生分页变化仍可切换较大分页恢复，不会沿用上次阶段', async () => {
  const warnings = [], sizes = [];
  const platform = new JYPlatform({}, { warn: message => warnings.push(message) });
  platform.lastHeartbeatStep = '上一个SN阶段';
  platform.fetchTodayHeartbeat = async () => {
    sizes.push(platform.heartbeatPageSize);
    if (sizes.length === 1) throw new Error('Timeout: detail not ready\nstack details');
    if (sizes.length === 2) throw new Error('心跳分页期间总数变化');
    return { complete: true };
  };
  assert.equal((await platform.fetchHeartbeatWithRetry('SN', 'date')).complete, true);
  assert.deepEqual(sizes, [undefined, undefined, 300]);
  assert.match(warnings[0], /阶段：未知；原因：Timeout: detail not ready$/);
  assert.doesNotMatch(warnings[0], /上一个SN阶段|stack details/);
});

test('日期或字段错误不重试；取消后不重新打开详情且恢复分页策略', async () => {
  for (const message of ['心跳SN/日期范围不匹配', '心跳关键列变更或缺失']) {
    const platform = new JYPlatform({}, { warn() {} });
    let attempts = 0;
    platform.fetchTodayHeartbeat = async () => { attempts++; throw new Error(message); };
    await assert.rejects(platform.fetchHeartbeatWithRetry('SN', 'date'), { message });
    assert.equal(attempts, 1);
  }
  const cancellation = new AbortController();
  const platform = new JYPlatform({ signal: cancellation.signal }, { warn() {} });
  let attempts = 0;
  platform.fetchTodayHeartbeat = async () => {
    attempts++;
    if (attempts === 2) cancellation.abort(new Error('已停止'));
    throw new Error('心跳分页期间总数变化');
  };
  await assert.rejects(platform.fetchHeartbeatWithRetry('SN', 'date'), /已停止/);
  assert.equal(attempts, 2);
  assert.equal(platform.heartbeatPageSize, undefined);
  await assert.rejects(platform.fetchHeartbeatWithRetry('SN', 'date'), /已停止/);
  assert.equal(attempts, 2);
});

async function scenario(sns, collect, config = {}, options = {}) {
  const calls = [], closed = [], pages = [], progress = [];
  const platform = new JYPlatform({ heartbeatConcurrency: 2, batteryBatchSize: 1, ...config }, { info() {}, warn() {}, progress:p=>progress.push(p) });
  platform.ensureLogin = async () => {};
  platform.context = { newPage: async () => {
    const id = pages.length + 1;
    pages.push(id);
    return { id, close: async () => { closed.push(id); } };
  } };
  const original = JYPlatform.prototype.fetchBatterySnapshots;
  JYPlatform.prototype.fetchBatterySnapshots = async function(batch, options) {
    this.lastSnapshots = new Map(); this.heartbeatEvidence = new Map();
    const call = { batch, options, page: this.rootPage.id };
    calls.push(call);
    await collect.call(this, call, calls);
    return this.lastSnapshots;
  };
  try {
    const snapshots = await platform.fetchBatterySnapshotsConcurrent(sns, { evidenceSNs: sns, reportDate: '2026-09-24', ...options });
    return { platform, snapshots, calls, closed, pages, progress };
  } finally { JYPlatform.prototype.fetchBatterySnapshots = original; }
}

test('当天待确认策略只读取一次，不重开详情、不发起新页面补查，保留失败原因',async()=>{
  const platform=new JYPlatform({auditPolicy:'current_day_pending'},{warn(){}});let attempts=0;
  platform.fetchTodayHeartbeat=async()=>{attempts++;throw new Error('Timeout');};
  await assert.rejects(platform.fetchHeartbeatWithRetry('SN','date'),/Timeout/);assert.equal(attempts,1);
  const result=await scenario(['A','B','C','D'],function(){throw new Error('批次 Timeout');},{auditPolicy:'current_day_pending'});
  assert.equal(result.calls.length,4);assert.equal(result.snapshots.size,0);
  assert.ok([...result.platform.heartbeatEvidence.values()].every(e=>!e.complete && e.error==='批次 Timeout'));
});

test('续采进度保留之前待确认计数，完成处理不等于全部成功',async()=>{
  const result=await scenario(['remaining'],function(){
    this.lastSnapshots.set('remaining',{});
    this.heartbeatEvidence.set('remaining',{complete:true,records:[]});
  },{auditPolicy:'current_day_pending'},{progressTotal:4,progressCompleted:3,progressFailed:2});
  const final=result.progress.filter(p=>p.completed!=null).at(-1);
  assert.equal(final.completed,4);assert.equal(final.heartbeat_complete,2);
  assert.equal(final.failed,2);assert.equal(final.pending,2);
});

test('设备小批次由空闲通道继续领取，慢批次不阻塞后续设备，每块只读一次',async()=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const sns=['A','B','C','D','E','F','G','H'];
  const result=await scenario(sns,async function({batch}){
    if(batch[0]==='A')await blocked;
    for(const sn of batch){this.lastSnapshots.set(sn,{});this.heartbeatEvidence.set(sn,{sn,complete:true,records:[]});}
    if(batch[0]==='G')release();
  },{auditPolicy:'current_day_pending',batteryBatchSize:45,heartbeatBatchSize:2,heartbeatConcurrency:2});
  assert.deepEqual(result.calls.map(c=>c.batch),[['A','B'],['C','D'],['E','F'],['G','H']]);
  assert.equal(result.snapshots.size,8);assert.equal(result.platform.heartbeatEvidence.size,8);
  assert.equal(result.closed.length,4);
});

test('连续失败换页仅继续未读设备，失败设备不补查，不显示空补查阶段',async()=>{
  // The scenario runs isolated worker pages without accessing the live platform.
  const r=await scenario(['A','B','C','D','E','F'],function({batch}){
    this.pageResetRequested=batch.includes('A');
    for(const sn of this.pageResetRequested?batch.slice(0,3):batch){
      this.lastSnapshots.set(sn,{});
      this.heartbeatEvidence.set(sn,{sn,complete:!this.pageResetRequested,records:[],error:this.pageResetRequested?'Timeout':undefined});
    }
  },{auditPolicy:'current_day_pending',heartbeatConcurrency:1,batteryBatchSize:6});
  assert.deepEqual(r.calls.map(c=>c.batch),[['A','B','C','D','E','F'],['D','E','F']]);
  assert.equal(r.pages.length,2);assert.equal(r.closed.length,2);
  assert.equal(r.platform.heartbeatEvidence.size,6);
  assert.ok(r.progress.every(p=>p.stage!=='并发补查'));
  assert.equal(r.progress.filter(p=>p.stage).at(-1).estimated_remaining_seconds,0);
  assert.equal([...r.platform.heartbeatEvidence.values()].filter(e=>e.complete).length,3);
});

test('失败SN使用新页面补查，已成功SN不重查；批次异常也不丢已读摘要', async () => {
  const result = await scenario(['A', 'B', 'C'], function({ batch }, calls) {
    const sn = batch[0], attempt = calls.filter(c => c.batch[0] === sn).length;
    this.lastSnapshots.set(sn, { batteryStatus: sn });
    if (sn === 'B' && attempt === 1) throw new Error('Timeout: broken frame');
    this.heartbeatEvidence.set(sn, { sn, complete: true, records: [] });
  });
  assert.equal(result.snapshots.size, 3);
  assert.equal(result.calls.length, 4);
  assert.equal(result.calls.filter(c => c.batch[0] === 'A').length, 1);
  assert.equal(result.calls.filter(c => c.batch[0] === 'C').length, 1);
  assert.equal(new Set(result.calls.map(c => c.page)).size, 4);
  assert.equal(result.closed.length, result.pages.length);
  assert.ok([...result.platform.heartbeatEvidence.values()].every(e => e.complete));
});

test('失败队列按配置并发补查，已成功设备不进入补查',async()=>{
  let repairsRunning=0,maxRepairs=0;
  const r=await scenario(['OK','A','B','C'],async function({batch},calls){
    const sn=batch[0],attempt=calls.filter(c=>c.batch[0]===sn).length;
    this.lastSnapshots.set(sn,{});
    if(sn!=='OK'&&attempt===1)throw new Error('Timeout');
    if(attempt===2){repairsRunning++;maxRepairs=Math.max(maxRepairs,repairsRunning);await new Promise(r=>setTimeout(r,20));repairsRunning--;}
    this.heartbeatEvidence.set(sn,{sn,complete:true,records:[]});
  });
  assert.equal(maxRepairs,2);assert.equal(r.calls.filter(c=>c.batch[0]==='OK').length,1);assert.ok([...r.platform.heartbeatEvidence.values()].every(e=>e.complete));
});

test('系统性失败补查最多连续3次，保留成功SN并显式登记所有未完成SN', async () => {
  const sns = ['OK', 'A', 'B', 'C', 'D', 'E'];
  const result = await scenario(sns, function({ batch }) {
    const sn = batch[0];
    if (sn !== 'OK') throw new Error('Timeout');
    this.lastSnapshots.set(sn, {});
    this.heartbeatEvidence.set(sn, { sn, complete: true, records: [] });
  });
  assert.ok(result.calls.length >= sns.length + 3 && result.calls.length <= sns.length + 4, '三次失败后不启动新任务，已有并发允许完成');
  assert.equal(result.snapshots.size, 1);
  assert.equal(result.platform.heartbeatEvidence.size, sns.length);
  assert.equal(result.platform.heartbeatEvidence.get('OK').complete, true);
  for (const sn of sns.slice(1)) assert.equal(result.platform.heartbeatEvidence.get(sn).complete, false);
  assert.match(result.platform.acquisitionWarnings[0], /5 个SN/);
  assert.equal(result.closed.length, result.pages.length);
});

test('取消不会转入补查，关闭全部已创建页面', async () => {
  const cancellation = new AbortController();
  let called = 0;
  await assert.rejects(scenario(['A', 'B', 'C'], function() {
    called++;
    cancellation.abort(new Error('已停止'));
    throw new Error('Timeout');
  }, { heartbeatConcurrency: 1, signal: cancellation.signal }), /已停止/);
  assert.equal(called, 1);
});

test('共享会话失效后不再重开详情或逐SN补查，保留已完成证据',async()=>{
  const result=await scenario(['OK','EXPIRED','LATER'],async function({batch}) {
    const sn=batch[0];
    if(sn==='OK') {
      this.lastSnapshots.set(sn,{});
      this.heartbeatEvidence.set(sn,{sn,complete:true,records:[]});return;
    }
    let attempts=0;
    this.fetchTodayHeartbeat=async()=>{attempts++;throw Object.assign(new Error('登录失效'),{code:'SESSION_EXPIRED'});};
    await assert.rejects(this.fetchHeartbeatWithRetry(sn,'2026-09-24'),{code:'SESSION_EXPIRED'});
    await assert.rejects(this.fetchHeartbeatWithRetry(sn,'2026-09-24'),{code:'SESSION_EXPIRED'});
    assert.equal(attempts,1);
  },{heartbeatConcurrency:1});
  assert.deepEqual(result.calls.map(c=>c.batch[0]),['OK','EXPIRED']);
  assert.equal(result.platform.heartbeatEvidence.get('OK').complete,true);
  for(const sn of ['EXPIRED','LATER']) {
    assert.equal(result.platform.heartbeatEvidence.get(sn).complete,false);
    assert.match(result.platform.heartbeatEvidence.get(sn).error,/会话已失效/);
  }
  assert.equal(result.closed.length,result.pages.length);
});

test('补读客户或电芯只更新详情，复用同截止完整心跳；不复用不完整历史',async()=>{
  const platform=new JYPlatform({}, {info(){}}),calls=[];
  const previous={complete:true,records:[{time:'2026-09-24 12:00:00',minVoltage:'3.0'}],historyComplete:false,detail:{customer:'旧拥有者'}};
  platform.cachedAuditEvidence=new Map([['SN',previous]]);
  platform.fetchTodayHeartbeat=async(...args)=>{calls.push(args);return {detail:{customer:'新客户',detailVersion:2}};};
  platform.fetchHeartbeatWithRetry=async()=>{throw new Error('不应重新扫描完整心跳');};
  const result=await platform.fetchAuditEvidence('SN','2026-09-24','2026-09-24 16:00:00');
  assert.equal(result.records,previous.records);assert.equal(result.detail.customer,'新客户');
  assert.equal(previous.detail.customer,'旧拥有者');assert.deepEqual(calls[0][3],{detailOnly:true});
  platform.cachedAuditEvidence.set('SN',{...previous,historyComplete:true,historyDays:['2026-09-24']});
  await assert.rejects(platform.fetchAuditEvidence('SN','2026-09-24','2026-09-24 16:00:00'),/不应重新扫描完整心跳/);
});

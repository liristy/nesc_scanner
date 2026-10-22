import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { carryHistoricalAlarm } from '../src/historical-review.mjs';
import { loadHistoricalEvidence, loadHistoricalReviewState } from '../src/daily-collection.mjs';
import { hydrateEvidence,trackingName } from '../src/evidence-store.mjs';
import { loadAcquisition } from '../src/audit-runner.mjs';
import { atomicWriteJson } from '../src/utils.mjs';

const prior={sn:'old',type:'电量不足',time:'2026-10-12 10:00:00',vendor:'JY',level:'保护',
  detail:{bms:'F1-real',collectedAt:'2026-10-12 17:00:00'},lowVoltage:{confirmed:true,minVoltage:2.4,latestTime:'2026-10-12 15:00:00',gaps:[]}};
test('历史确认风险保留，但不使用旧电压确认今日风险，复查失败不能判已恢复',()=>{
  const carried=carryHistoricalAlarm(prior,prior,{complete:true,evidenceFile:'fixture',coverageCutoff:'2026-10-12 16:00:00'}, {},
    '2026-10-13 17:00:00','恢复查询失败','2026-10-12 16:00:00');
  assert.equal(carried.lowVoltage.confirmed,false);assert.equal(carried.lowVoltage.historicalConfirmed,true);
  assert.equal(carried.lowVoltage.latestTime,prior.lowVoltage.latestTime);assert.equal(carried.detail.collectedAt,prior.detail.collectedAt);
  assert.equal(carried.review.recoveryPending,true);assert.equal(carried.historicalReview.lastEvidenceCutoff,'2026-10-12 16:00:00');
});
test('原始旧心跳分析不能将未确认对象升级为历史已确认风险',()=>{
  const old={...prior,lowVoltage:{...prior.lowVoltage,confirmed:false},review:{kind:'reading_pending',reason:'电芯未取得'}};
  const result=carryHistoricalAlarm(old,old,{complete:true,evidenceFile:'fixture',coverageCutoff:'2026-10-12 16:00:00',
    week:{...old.lowVoltage,confirmed:true}}, {},'2026-10-13 17:00:00',null,'2026-10-12 16:00:00');
  assert.equal(result.lowVoltage.confirmed,false);assert.equal(result.lowVoltage.historicalConfirmed,false);
  assert.equal(result.review.kind,'reading_pending');
});
test('历史原始证据保留真实截止，不从当轮检查点复用为已采集；拒绝未来/串SN资料',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-history-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const target=path.join(root,'跟踪数据',trackingName('old'));
  const raw={sn:'old',cutoff:'2026-10-13 16:00:00',snapshot:{detail:prior.detail},evidence:{complete:true,carried:true,
    coverageCutoff:'2026-10-12 16:00:00',records:[{time:'2026-10-12 15:00:00',minVoltage:2.4}]}};
  await atomicWriteJson(target,raw);
  const loaded=await loadHistoricalEvidence(root,'2026-10-13 16:00:00',['old']);
  const hydrated=await hydrateEvidence('old',loaded.evidence.get('old'));
  assert.equal(hydrated.coverageCutoff,'2026-10-12 16:00:00');assert.equal(hydrated.carried,true);assert.deepEqual(hydrated.records,raw.evidence.records);
  await atomicWriteJson(path.join(root,'run/acquisition/batch-fixture.json'),{reportDate:'2026-10-13',endText:'2026-10-13 16:00:00',snapshots:{old:raw.snapshot},evidence:{old:hydrated}});
  const cache=await loadAcquisition(root,{reportDate:'2026-10-13',endText:'2026-10-13 16:00:00'});
  assert.equal(cache.evidence.size,0);
  assert.equal(cache.snapshots.size,0);
  await atomicWriteJson(target,{...raw,evidence:{...raw.evidence,coverageCutoff:'2026-10-14 16:00:00'}});
  await assert.rejects(loadHistoricalEvidence(root,'2026-10-13 16:00:00',['old']),/历史证据身份、日期或结构无效/);
  await atomicWriteJson(target,{...raw,sn:'wrong'});
  await assert.rejects(loadHistoricalEvidence(root,'2026-10-13 16:00:00',['old']),/历史证据身份、日期或结构无效/);
});
test('缺失历史证据的未知日期不能在保存和次日复用时自动变成昨天',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-history-missing-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const first=await loadHistoricalEvidence(root,'2026-10-12 16:00:00',['missing']);
  await atomicWriteJson(path.join(root,'跟踪数据',trackingName('missing')),{sn:'missing',cutoff:'2026-10-13 16:00:00',evidence:first.evidence.get('missing')});
  const second=await loadHistoricalEvidence(root,'2026-10-13 16:00:00',['missing']);
  assert.equal((await hydrateEvidence('missing',second.evidence.get('missing'))).coverageCutoff,null);
  const carried=carryHistoricalAlarm({...prior,sn:'missing'},{...prior,sn:'missing'},second.evidence.get('missing'),null,'2026-10-14 16:00:00',null,'2026-10-13 16:00:00');
  assert.equal(carried.historicalReview.lastEvidenceCutoff,null);
});

for(const records of [[],[{time:'2026-10-13 15:00:00',minVoltage:3.4,maxVoltage:3.5,abnormal:true}]])
test(`历史查询完整但${records.length?'只有异常读数':'没有心跳'}时，不能沿用旧正常电压解除待确认`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-history-empty-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const old={...prior,review:undefined,lowVoltage:{confirmed:false,minVoltage:3.4,latestTime:'2026-10-12 15:00:00',gaps:[]}};
  await atomicWriteJson(path.join(root,'跟踪数据',trackingName('old')),{sn:'old',cutoff:'2026-10-13 16:00:00',
    snapshot:{detail:old.detail},evidence:{complete:true,records,detail:old.detail}});
  const loaded=await loadHistoricalEvidence(root,'2026-10-13 16:00:00',['old']);
  const carried=carryHistoricalAlarm(old,old,loaded.evidence.get('old'),loaded.snapshots.get('old'),'2026-10-14 01:00:00',null,'2026-10-12 16:00:00');
  assert.equal(carried.review.status,'待确认');assert.match(carried.review.reason,/有效电压证据缺失/);
  assert.equal(carried.lowVoltage.minVoltage,null);assert.equal(carried.lowVoltage.confirmed,false);
});

test('重跑使用截止内最新复核状态，不把未来、不完整或同基线旧缓存作为更新状态',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-history-state-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const baseline={last_success_cutoff:'2026-10-12 16:00:00',items:[prior]};
  const window={endText:'2026-10-13 16:00:00'};
  const file=path.join(root,'run/daily/collection.json');
  const newer={...prior,review:{kind:'reading_pending',reason:'有效电压证据缺失'}};
  await atomicWriteJson(file,{complete:true,endText:window.endText,items:[newer]});
  assert.deepEqual((await loadHistoricalReviewState(root,window,baseline)).items,[newer]);
  for(const patch of [{endText:'2026-10-14 16:00:00'},{complete:false},{endText:baseline.last_success_cutoff},{endText:'bad'}]){
    await atomicWriteJson(file,{complete:true,endText:window.endText,items:[newer],...patch});
    assert.equal(await loadHistoricalReviewState(root,window,baseline),baseline);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHeartbeatHistory } from '../src/heartbeat-history.mjs';
import { JYPlatform } from '../src/platform.mjs';
import { analyzeWeek } from '../src/audit-rules.mjs';

const dates=Array.from({length:9},(_,i)=>`2026-10-${String(13-i).padStart(2,'0')}`);
const rows=date=>[{time:date+' 15:00:00',minVoltage:2.4,maxVoltage:3.1,event:'保护:电量不足'},
  {time:date+' 14:00:00',minVoltage:2.4,maxVoltage:3.1,event:'进入低功耗'}];
const current={sn:'A',reportDate:'2026-10-14',complete:true,records:rows('2026-10-14')};

test('当前日不完整时不查询历史、不认证当前日，保留原始记录和失败原因',async()=>{
  const partial={...current,complete:false,error:'当前日分页缺行'};
  const saved=[];
  const result=await collectHeartbeatHistory(partial,dates,async()=>assert.fail('不应继续查询历史'),async e=>saved.push(e));
  assert.equal(saved.length,1);assert.deepEqual(result.historyDays,[]);
  assert.equal(result.historyCoverageVersion,1);assert.equal(result.complete,false);
  assert.equal(result.historyComplete,false);assert.equal(result.error,partial.error);
  assert.deepEqual(result.records,partial.records);
  assert.equal(analyzeWeek(result,'2026-10-14 16:30:00').confirmed,false);
  const p=new JYPlatform({},{info(){},progress(){}});
  let calls=0;p.fetchHeartbeatWithRetry=async()=>{calls++;return partial;};
  assert.equal((await p.fetchAuditEvidence('A',current.reportDate,'2026-10-14 16:30:00')).complete,false);
  assert.equal(calls,1);
});

test('历史保存失败和取消向上抛出，不能成为可完成的待确认结果',async()=>{
  let writes=0;
  await assert.rejects(collectHeartbeatHistory(current,dates,async date=>({complete:true,records:rows(date)}),async()=>{
    if(++writes===2)throw new Error('磁盘写入失败');
  },{}),/磁盘写入失败/);
  const controller=new AbortController();
  await assert.rejects(collectHeartbeatHistory(current,dates,async()=>{
    controller.abort(new Error('已取消'));return {complete:true,records:[]};
  },async()=>{}, {signal:controller.signal}),/已取消/);
});

test('历史查询中断保留会话错误类型和已核验日期，供整轮续采区分设备超时',async()=>{
  let reads=0;
  const result=await collectHeartbeatHistory(current,dates,async date=>{
    if(++reads===2)throw Object.assign(new Error('登录失效'),{code:'SESSION_EXPIRED'});
    return {complete:true,records:rows(date)};
  },async()=>{});
  assert.equal(result.errorCode,'SESSION_EXPIRED');assert.equal(result.complete,false);
  assert.deepEqual(result.historyDays,[current.reportDate,dates[0]]);assert.equal(reads,2);
});

test('跨日复用只限完整旧日，旧截止当天重新查询',async()=>{
  const p=new JYPlatform({heartbeatTransport:'source',auditPolicy:'current_day_pending'},{info(){},progress(){}});
  p.heartbeatQueries=new Map([['A',{}]]);
  p.cachedAuditEvidence=new Map([['A',{complete:true,coverageCutoff:'2026-10-13 16:30:00',
    historyDays:dates,records:dates.flatMap(rows)}]]);
  p.fetchHeartbeatWithRetry=async()=>current;
  const queried=[];p.readSourceDay=async(query,sn,date)=>{queried.push(date);return {complete:true,records:rows(date)};};
  const result=await p.fetchAuditEvidence('A',current.reportDate,'2026-10-14 16:30:00');
  assert.deepEqual(queried,['2026-10-13']);assert.equal(result.historyMetrics.reusedDays,8);
  assert.equal(result.historyComplete,true);
});

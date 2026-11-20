import test from 'node:test';
import assert from 'node:assert/strict';
import {JYPlatform} from '../src/platform.mjs';
import {refreshPreviousAlarms} from '../src/tracking-refresh.mjs';

function platform(config={}) {
  const p=new JYPlatform({heartbeatConcurrency:8,...config},{info(){},warn(){}});
  let loggedIn=false;
  p.ensureLogin=async()=>{loggedIn=true;};
  return {p, loggedIn:()=>loggedIn};
}

test('恢复查询共享一个 HTTP 会话，最多三路并发且乱序完成仍按序合并',async()=>{
  const {p,loggedIn}=platform();let active=0,peak=0;
  const results=await p.mapAlarmQueries([0,1,2,3,4,5],async(worker,task)=>{
    assert.ok(loggedIn());assert.equal(worker,p);
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,task===0?30:10));active--;return task;
  });
  assert.deepEqual(results,[0,1,2,3,4,5]);assert.equal(peak,3);
});

test('恢复查询会话失效或取消后不派发新批次',async()=>{
  for(const cancel of [false,true]) {
    const controller=new AbortController(),{p}=platform({heartbeatConcurrency:1,signal:controller.signal});let reads=0;
    await assert.rejects(p.mapAlarmQueries([0,1,2],async()=>{
      reads++;
      if(cancel){controller.abort(new Error('已停止'));throw controller.signal.reason;}
      throw Object.assign(new Error('登录已失效'),{code:'SESSION_EXPIRED'});
    }),cancel?/已停止/:{code:'SESSION_EXPIRED'});
    assert.equal(reads,1);
  }
});

test('恢复复查46SN按45+1划分，恰好上限不误报，超过上限保留错误，空任务不登录',async()=>{
  for(const limit of [0,1,2]) {
    const calls=[],tasks=[];
    const fake={async mapAlarmQueries(items,read){tasks.push(...items);const parts=[];for(let i=0;i<items.length;i++)parts.push(await read(this,items[i],i));return parts;},
      async queryAlarmAndDownload(query,options){calls.push({query,options});throw new Error('计数缺口');}};
    const items=Array.from({length:46},(_,i)=>({bms_number:'SN-'+i,alarm_time:'2026-10-01 12:00:00'}));
    const result=await refreshPreviousAlarms(fake,items,[],{vendor:'JY',maxTrackingRefreshBatches:limit});
    assert.equal(tasks.length,limit);assert.equal(calls.length,limit);
    assert.equal(tasks[0]?.batch.length,limit?45:undefined);
    assert.equal(tasks[1]?.batch.length,limit===2?1:undefined);
    assert.equal(result.errors.some(e=>e.includes('达到上限')),limit<2);
    assert.deepEqual(result.rows,[]);assert.equal(result.errors.length,limit+(limit<2?1:0));
  }
  const {p}=platform();p.ensureLogin=()=>assert.fail('无任务不需要登录');
  assert.deepEqual(await p.mapAlarmQueries([],()=>assert.fail()),[]);
});

test('恢复复查不会吞掉会话失效或取消错误',async()=>{
  const item={bms_number:'SN',alarm_time:'2026-10-01 12:00:00'};
  for(const cancel of [false,true]) {
    const controller=new AbortController();
    await assert.rejects(refreshPreviousAlarms({async queryAlarmAndDownload(){
      if(cancel){controller.abort(new Error('已停止'));throw new Error('timeout');}
      throw Object.assign(new Error('登录失效'),{code:'SESSION_EXPIRED'});
    }},[item],[],{vendor:'JY',maxTrackingRefreshBatches:2,signal:controller.signal}),cancel?/已停止/:{code:'SESSION_EXPIRED'});
  }
});

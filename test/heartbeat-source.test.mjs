import test from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatForm, readHeartbeatSource } from '../src/heartbeat-source.mjs';
import { JYPlatform } from '../src/platform.mjs';

const query = { url:'https://fixture.invalid/Reports/BatteryHeartbeat/Source', detailUrl:'https://fixture.invalid/Reports/BatteryInfo/BatteryView?a=7', batteryId:'7', form:'dataId=7&page=1&limit=50&fastItems=old%3BJY%3Bfilter&csrf=preserved' };
const row = (id, extra = {}) => ({ BatteryHeartbeatId:id, TCreateTime:'2026-10-03 15:00:00', TMinVoltage:'2.40[3]', TMaxVoltage:'3.1', TBatteryHeartbeatStatus:'保护:电量不足', ...extra });
function api(pages, status=200) {
  const calls=[], disposed=[];
  return {calls,disposed,async post(url,options){calls.push({url,options});const p=Number(new URLSearchParams(options.data).get('page'));return {status:()=>status,json:async()=>pages[p-1],dispose:async()=>disposed.push(p)};}};
}
const options = {sn:'SN',reportDate:'2026-10-03',endText:'2026-10-03 16:00:00',pageSize:2};

test('查询保持设备和附加筛选，拒绝跨源或不同设备模板',()=>{
  const form=new URLSearchParams(heartbeatForm(query,'2026-10-03',2,300));
  assert.equal(form.get('dataId'),'7');assert.equal(form.get('fastItems'),'2026-10-03 ~ 2026-10-03;JY;filter');assert.equal(form.get('csrf'),'preserved');assert.equal(form.get('limit'),'300');
  for(const q of [{...query,url:'https://other.invalid/Reports/BatteryHeartbeat/Source'},{...query,batteryId:'8'},{...query,form:'dataId=8&fastItems=old'}])assert.throws(()=>heartbeatForm(q,'2026-10-03',1,300),{code:'HEARTBEAT_SOURCE_INVALID'});
});

test('完整分页按截止包含16点，保留异常与空事件电压，释放所有响应',async()=>{
  const a=api([{code:0,count:3,data:[row(1,{TCreateTime:'2026-10-03 16:00:01'}),row(2,{TCreateTime:'2026-10-03 16:00:00',TMinVoltage:'异常数据'})]},{code:0,count:3,data:[row(3,{TBatteryHeartbeatStatus:'进入低功耗',TMinVoltage:'',TMosTemperature:19.9,TDiffVoltage:null})]}]);
  const e=await readHeartbeatSource(a,query,options);
  assert.equal(e.complete,true);assert.equal(e.readCount,3);assert.equal(e.records.length,2);assert.equal(e.records[0].abnormal,true);assert.equal(e.records[1].minVoltage,'');assert.equal(e.records[1].event,'进入低功耗');assert.equal(e.records[1].mosTemperature,'19.9');assert.equal(e.records[1].voltageDifference,'');assert.deepEqual(a.disposed,[1,2]);assert.equal(e.metrics.requests,2);
});

test('只接受明确无数据，失败、错误日期、重复和缺行都不能标记完整',async()=>{
  for(const [pages,pattern] of [
    [[{code:1,msg:'无权限',count:0,data:[]}],/响应无效/],
    [[{code:0,count:1,data:[row(1,{TCreateTime:'2026-10-02 12:00:00'})]}],/日期范围/],
    [[{code:0,count:3,data:[row(1),row(2)]},{code:0,count:3,data:[row(2)]}],/重复记录ID/],
    [[{code:0,count:3,data:[row(1),row(2)]},{code:0,count:4,data:[row(3),row(4)]}],/总数变化/],
    [[{code:0,count:2,data:[row(1)]}],/行数/],
    [[{code:0,count:1,data:[{BatteryHeartbeatId:1,TCreateTime:'2026-10-03 12:00:00'}]}],/关键列/],
    [[{code:0,count:1,data:[null]}],/响应无效/],
  ]) await assert.rejects(readHeartbeatSource(api(pages),query,options),pattern);
  const empty=await readHeartbeatSource(api([{code:1,msg:'无数据',count:0,data:[]}]),query,options);assert.equal(empty.complete,true);assert.equal(empty.records.length,0);
});

test('超出上限、登录重定向、取消不能重复查询或成为正常空结果',async()=>{
  await assert.rejects(readHeartbeatSource(api([{code:0,count:6001,data:[]}]),query,options),/超过采集上限/);
  for(const status of [302,401]) {const a=api([],status);await assert.rejects(readHeartbeatSource(a,query,options),{code:'SESSION_EXPIRED'});assert.equal(a.calls.length,1);assert.equal(a.disposed.length,1);}
  const cancel=new AbortController();cancel.abort(new Error('已停止'));const a=api([]);await assert.rejects(readHeartbeatSource(a,query,{...options,signal:cancel.signal}),/已停止/);assert.equal(a.calls.length,0);
  await assert.rejects(readHeartbeatSource({post:async()=>{throw new Error('secret request header');}},query,options),error=>error.code==='HEARTBEAT_REQUEST_TIMEOUT'&&!error.message.includes('secret'));
});

test('600条模拟同一数据，300条分页请求数由12降至2，证据一致',async()=>{
  const data=Array.from({length:600},(_,i)=>row(i));
  const collect=async size=>{const a=api(Array.from({length:Math.ceil(data.length/size)},(_,i)=>({code:0,count:data.length,data:data.slice(i*size,(i+1)*size)})));return readHeartbeatSource(a,query,{...options,pageSize:size});};
  const small=await collect(50),large=await collect(300);assert.deepEqual(large.records,small.records);assert.equal(small.metrics.requests,12);assert.equal(large.metrics.requests,2);
});

test('同SN历史日复用已验证的查询模板，不再打开详情或读取电芯',async()=>{
  const p=new JYPlatform({heartbeatTransport:'source',maxHeartbeatPages:20},{info(){}});
  p.context={request:api([{code:0,count:1,data:[row(1)]}])};p.heartbeatQueries=new Map([['SN',query]]);p.auditDetails=new Map([['SN',{bms:'F100',customer:'客户'}]]);
  // No page is available: a repeated detail opening would fail this test.
  const e=await p.fetchTodayHeartbeat('SN','2026-10-03','2026-10-03 16:00:00');assert.equal(e.complete,true);assert.equal(e.detail.bms,'F100');assert.equal(p.context.request.calls.length,1);
});

test('仅截止后新增头部记录时，验证旧首行、去重覆盖及总数后完整读取固定截止',async()=>{
  const original=[row('a',{TCreateTime:'2026-10-03 17:00:00'}),row('b'),row('c',{TCreateTime:'2026-10-03 14:00:00'}),row('d',{TCreateTime:'2026-10-03 13:00:00'})];
  const added=row('new',{TCreateTime:'2026-10-03 17:01:00'}),calls=[];
  const a={async post(_,o){const p=Number(new URLSearchParams(o.data).get('page'));calls.push(p);const data=calls.length===1?original:[added,...original];return {status:()=>200,json:async()=>({code:0,count:data.length,data:data.slice((p-1)*2,p*2)}),dispose:async()=>{}};}};
  const result=await readHeartbeatSource(a,query,{...options,stableCutoff:true});
  assert.equal(result.complete,true);assert.equal(result.stableCutoff,true);assert.equal(result.tableCount,4);assert.equal(result.observedCount,5);
  assert.deepEqual(result.records.map(r=>r.time),original.slice(1).map(r=>r.TCreateTime));assert.deepEqual(calls,[1,2,3,1]);
});

test('截止内新增、计数减少、旧数据变更、无法验证头部和重复整页都不得冒充稳定分页',async()=>{
  for(const failure of ['in-range','decrease','mutate','bad-head','repeated-page']) {
    const original=[row('a',{TCreateTime:'2026-10-03 15:00:00'}),row('b',{TCreateTime:'2026-10-03 14:00:00'}),row('c',{TCreateTime:'2026-10-03 13:00:00'}),row('d',{TCreateTime:'2026-10-03 12:00:00'})];
    let calls=0;
    const a={async post(_,o){const p=Number(new URLSearchParams(o.data).get('page'));calls++;
      let data=calls===1?original:[row('new',{TCreateTime:failure==='in-range'?'2026-10-03 15:30:00':'2026-10-03 17:01:00'}),...original];
      if(calls>1&&failure==='decrease')data=original.slice(0,3);
      if(calls>1&&failure==='mutate')data=data.map(r=>r.BatteryHeartbeatId==='b'?{...r,TMinVoltage:'3.9'}:r);
      if(p===1&&calls>1&&failure==='bad-head')data=[data[0],row('bad',{TCreateTime:'2026-10-03 15:00:00'}),...data.slice(2)];
      const rows=failure==='repeated-page'&&calls>1?original.slice(0,2):data.slice((p-1)*2,p*2);
      return {status:()=>200,json:async()=>({code:0,count:data.length,data:rows}),dispose:async()=>{}};
    }};
    await assert.rejects(readHeartbeatSource(a,query,{...options,stableCutoff:true}),/不能|总数变化|重复/,failure);
  }
});

test('高频历史超过6000条仍逐页完整核验，超过有界扩容上限仍拒绝',async()=>{
  const data=Array.from({length:6001},(_,i)=>row(String(i)));
  const a={async post(_,o){const f=new URLSearchParams(o.data),p=Number(f.get('page'));return {status:()=>200,json:async()=>({code:0,count:data.length,data:data.slice((p-1)*300,p*300)}),dispose:async()=>{}};}};
  const result=await readHeartbeatSource(a,query,{...options,pageSize:300,recordLimit:60000});assert.equal(result.readCount,6001);assert.equal(result.records.length,6001);assert.equal(result.metrics.requests,21);
  await assert.rejects(readHeartbeatSource(a,query,{...options,pageSize:300,recordLimit:6000}),/超过采集上限/);
});

test('第一页允许较长等待，后续分页保留原预算，失败只请求一次且不泄露请求内容',async()=>{
  const a=api([{code:0,count:3,data:[row('a'),row('b')]},{code:0,count:3,data:[row('c')]}]);
  const result=await readHeartbeatSource(a,query,{...options,timeoutMs:20000,firstPageTimeoutMs:60000});
  assert.equal(result.complete,true);assert.deepEqual(a.calls.map(c=>c.options.timeout),[60000,20000]);
  assert.ok(a.calls.every(c=>c.options.maxRetries===0));
  let calls=0;
  await assert.rejects(readHeartbeatSource({async post(){calls++;throw new Error('private token');}},query,
    {...options,firstPageTimeoutMs:60000}),error=>/等待上限60秒/.test(error.message)&&!error.message.includes('private'));
  assert.equal(calls,1);
});

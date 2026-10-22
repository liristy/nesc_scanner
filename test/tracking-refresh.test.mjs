import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { refreshPreviousAlarms } from "../src/tracking-refresh.mjs";
import { buildRollingResult } from "../src/classify.mjs";
import {progressText} from '../src/progress-view.mjs';

const previous = { bms_number: "SN-1", alarm_type: "电量不足", alarm_time: "2026-09-09 10:00:00", current_status: "状态待确认" };
const headers = ["最早报警时间", "修复时间", "电池组编号", "报警（级别：类型）", "处理状态", "BMS厂商"];
const values = ["2026-09-09 10:00:00", "2026-09-10 09:00:00", "SN-1", "保护:电量不足", "已关闭", "JY"];
const currentRow = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
async function workbook(entries=[values]) {
  const zip = new JSZip();
  const xmlRow = (values, n) => `<row r="${n}">${values.map((v, i) => `<c r="${String.fromCharCode(65 + i)}${n}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`;
  zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${xmlRow(headers, 1)}${entries.map((v,i)=>xmlRow(v,i+2)).join('')}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
const config = { vendor: "JY", maxTrackingRefreshBatches: 20 };
test("精确复核历史SN发生日，读取修复事件后退出跟踪且不混入本周期新增", async () => {
  const calls = [];
  const platform = { queryAlarmAndDownload: async (query, opts) => { calls.push([query, opts]); return { buffer: await workbook(), resultCount: 1 }; } };
  const refreshed = await refreshPreviousAlarms(platform, [previous], [], config);
  assert.equal(refreshed.errors.length, 0);
  assert.deepEqual(calls[0][1], { bmsNumbers: ["SN-1"] });
  assert.equal(calls[0][0].startDate, "2026-09-09");
  const rolling = buildRollingResult({ currentRows: [], refreshedPreviousRows: refreshed.rows, previousState: { items: [previous] }, snapshots: new Map(), checkedAt: "2026-09-10 16:00:00" });
  assert.equal(rolling.tracking.length, 0);
  assert.equal(rolling.changes.length, 1);
  assert.equal(rolling.changes[0].current_status, "本周期恢复");
});
test("当前已含相同事件时无需重复历史查询", async () => {
  const result = await refreshPreviousAlarms({ queryAlarmAndDownload: () => { throw new Error("should not call"); } }, [previous], [currentRow], config);
  assert.deepEqual(result, { rows: [], errors: [] });
});
test("历史查询失败或达到限额均保留待核实，不将缺失当恢复", async () => {
  for (const setting of [config, { ...config, maxTrackingRefreshBatches: 0 }]) {
    const refreshed = await refreshPreviousAlarms({ queryAlarmAndDownload: async () => { throw new Error("network failure"); } }, [previous], [], setting);
    assert.equal(refreshed.rows.length, 0);
    assert.equal(refreshed.errors.length, 1);
    const rolling = buildRollingResult({ currentRows: [], refreshedPreviousRows: [], previousState: { items: [previous] }, snapshots: new Map(), checkedAt: "2026-09-10 16:00:00" });
    assert.equal(rolling.tracking[0].current_status, "状态待确认");
  }
});

test('设备100%之后复查从0/2单独计数，展示在途批次，失败不算通过',async()=>{
  const states=[],gates=new Map();let onFirst;
  const first=new Promise(resolve=>{onFirst=resolve;});
  let state={status:'running',total:1091,completed:1091,succeeded:1088,failed:3};
  const platform={logger:{info(){},warn(){},progress(update){state={...state,...update};states.push(state);if(update.recovery.completed===1)onFirst();}},
    mapAlarmQueries:async(tasks,read)=>Promise.all(tasks.map((task,i)=>read(platform,task,i))),
    async queryAlarmAndDownload(query){await new Promise(resolve=>gates.set(query.startDate,resolve));
      if(query.startDate==='2026-09-10')throw new Error('导出网络故障');
      return {buffer:await workbook(),resultCount:1};}};
  const running=refreshPreviousAlarms(platform,[previous,{...previous,alarm_time:'2026-09-10 10:00:00'}],[],config);
  assert.match(progressText(states.at(-1)),/复查 0% 0\/2批/);
  assert.equal(states.at(-1).completed,1091);assert.equal(states.at(-1).recovery.active_batches.length,2);
  gates.get('2026-09-09')();await first;
  assert.match(progressText(states.at(-1)),/复查 50% 1\/2批/);
  assert.deepEqual(states.at(-1).recovery.active_batches.map(b=>b.date),['2026-09-10']);
  gates.get('2026-09-10')();const result=await running;
  assert.equal(result.errors.length,1);
  const final=states.at(-1);assert.equal(final.completed,1091);assert.equal(final.failed,3);
  assert.equal(final.recovery.completed,2);assert.equal(final.recovery.succeeded,1);assert.equal(final.recovery.failed,1);
  assert.equal(final.recovery.status,'incomplete');assert.deepEqual(final.recovery.active_batches,[]);
});

test('复查达到限额或会话中断时明确留下未处理批次，不显示全部通过',async()=>{
  let latest;const logger={progress:update=>{latest=update.recovery;}};
  const result=await refreshPreviousAlarms({logger},[previous],[],{...config,maxTrackingRefreshBatches:0});
  assert.equal(result.errors.length,1);assert.equal(latest.total,1);assert.equal(latest.completed,0);assert.equal(latest.skipped,1);assert.equal(latest.status,'incomplete');
  await assert.rejects(refreshPreviousAlarms({logger,async queryAlarmAndDownload(){throw Object.assign(new Error('失效'),{code:'SESSION_EXPIRED'});}},[previous],[],config),{code:'SESSION_EXPIRED'});
  assert.equal(latest.status,'interrupted');assert.equal(latest.failed,0);assert.equal(latest.completed,0);assert.equal(latest.succeeded,0);assert.equal(latest.active,false);
});

test('续查保留普通失败的待确认结果，中断批次重读；新一轮不复用旧检查点',async()=>{
  const items=[previous,{...previous,alarm_time:'2026-09-10 10:00:00'}],checkpoint=new Map(),calls=[];
  let interrupted=false,latest;
  const platform={logger:{info(){},warn(){},progress:p=>{latest=p.recovery;}},async queryAlarmAndDownload(query){
    calls.push(query.startDate);
    if(query.startDate==='2026-09-09')throw new Error('导出失败');
    if(!interrupted){interrupted=true;throw Object.assign(new Error('会话失效'),{code:'SESSION_EXPIRED'});}
    return {buffer:await workbook([['2026-09-10 10:00:00','','SN-1','保护:电量不足','未处理','JY']]),resultCount:1};
  }};
  await assert.rejects(refreshPreviousAlarms(platform,items,[],config,{checkpoint}),{code:'SESSION_EXPIRED'});
  assert.equal(latest.completed,1);assert.equal(latest.failed,1);assert.equal(latest.status,'interrupted');
  const result=await refreshPreviousAlarms(platform,items,[],config,{checkpoint});
  assert.equal(result.rows.length,1);assert.equal(result.errors.length,1);assert.match(result.errors[0],/导出失败/);
  assert.equal(latest.completed,2);assert.equal(latest.succeeded,1);assert.equal(latest.failed,1);assert.equal(latest.status,'incomplete');
  assert.deepEqual(calls,['2026-09-09','2026-09-10','2026-09-10']);
  await refreshPreviousAlarms(platform,items,[],config);
  assert.deepEqual(calls.slice(-2),['2026-09-09','2026-09-10']);
});

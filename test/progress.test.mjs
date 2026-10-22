import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunLogger } from "../src/progress.mjs";
import { progressText } from '../src/progress-view.mjs';

test("Windows拒绝替换进度文件或日志失败不影响采集，下次更新恢复完整进度", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jy-progress-"));
  let blocked = false;
  const io = { ...fs, renameSync: (...args) => {
    if (blocked) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return fs.renameSync(...args);
  }, appendFileSync: () => { throw new Error("日志文件被占用"); } };
  try {
    const logger = createRunLogger(root, { io, output: { info() {}, warn() {} }, tickMs:0 });
    assert.equal(logger.progress({ total: 8, completed: 0 }), true);
    blocked = true;
    assert.equal(logger.progress({ completed: 1, current_sn: "SN1" }), false);
    assert.doesNotThrow(() => logger.warn("继续查询"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "run/progress.json"))).completed, 0);
    blocked = false;
    assert.equal(logger.progress({ completed: 2 }), true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "run/progress.json")));
    assert.equal(saved.completed, 2);
    assert.equal(saved.total, 8);
    assert.equal(saved.current_sn, "SN1");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('进度条区分已核查与成功，不把失败或未知总数显示为全部完成',()=>{
  const text=progressText({stage:'并发补查',completed:6,total:10,succeeded:5,failed:1,elapsed_seconds:125});
  assert.match(text,/60% 6\/10/);assert.match(text,/心跳完整 5/);assert.match(text,/待补查 5/);assert.match(text,/耗时 2分5秒/);
  assert.match(progressText({total:0,completed:0}),/准备中/);
  assert.match(progressText({total:0,completed:0,collection_scope:{history_recovery_only:10}}),/本轮无需设备完整采集/);
});

test('请求等待时定时刷新耗时并打印通道阶段，关闭后停止计时',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jy-tick-')),lines=[];
  const logger=createRunLogger(root,{tickMs:15,output:{info:x=>lines.push(x),warn:x=>lines.push(x)}});
  try{logger.progress({stage:'并发采集',total:2,completed:0,active_workers:[{lane:1,sn:'SN',stage:'等待接口'}]});
    await new Promise(r=>setTimeout(r,55));assert.ok(lines.filter(x=>x.includes('待补查')).length>=2);assert.ok(lines.some(x=>x.includes('通道 1 → SN：等待接口')));
    logger.close();const count=lines.length;await new Promise(r=>setTimeout(r,35));assert.equal(lines.length,count);
  }finally{logger.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('等待复查接口时持续刷新本阶段耗时，日志包含当前日期及SN',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jy-tick-')),lines=[];
  const logger=createRunLogger(root,{tickMs:15,output:{info:x=>lines.push(x),warn:x=>lines.push(x)}});
  try {
    logger.progress({stage:'报警恢复复查',total:100,completed:100,recovery:{active:true,status:'running',total:5,completed:1,succeeded:1,failed:0,
      elapsed_seconds:0,started_ms:Date.now()-3000,active_batches:[{batch:2,date:'2026-09-28',sns:['SN-1'],stage:'查询'}]}});
    await new Promise(r=>setTimeout(r,55));
    const state=JSON.parse(fs.readFileSync(path.join(root,'run/progress.json')));
    assert.ok(state.recovery.elapsed_seconds>=3);assert.ok(lines.some(x=>x.includes('复查 20% 1/5批')));
    assert.ok(lines.some(x=>x.includes('2026-09-28 · 1块 · SN-1')));
  } finally {await logger.close();fs.rmSync(root,{recursive:true,force:true});}
});

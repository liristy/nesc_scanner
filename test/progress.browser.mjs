import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createProgressServer } from '../scripts/progress-server.mjs';

test('进度网页显示并发阶段、真实计数、错误并安全渲染；不暴露其他文件',{timeout:15000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-view-'));await fs.mkdir(path.join(root,'run'));
  await fs.writeFile(path.join(root,'run/progress.json'),JSON.stringify({status:'running',stage:'并发补查',completed:6,total:10,succeeded:5,failed:1,elapsed_seconds:125,updated_at:'2026-10-03 16:10:00',collection_scope:{current_window:3,history_only:7,total:10,skipped_recovered_normal:2},active_workers:[{lane:1,sn:'<script>bad</script>',stage:'读取心跳第2页'}]}));
  const server=createProgressServer(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    browser=await chromium.launch({headless:true,...(process.env.JY_BROWSER_EXECUTABLE?{executablePath:process.env.JY_BROWSER_EXECUTABLE}:{})});const page=await browser.newPage();
    await page.goto(base);await page.locator('#count').filter({hasText:'60%'}).waitFor();
    assert.equal(await page.locator('#bar').getAttribute('value'),'60');assert.match(await page.locator('#workers').textContent(),/<script>bad<\/script>/);assert.equal(await page.locator('#workers script').count(),0);
    assert.match(await page.locator('#scope').textContent(),/当日报警 3 块＋仅历史跟踪 7 块＝合并去重 10 块/);
    const recovery={stage:'截止范围内报警恢复复查',active:true,status:'running',total:24,completed:12,succeeded:11,failed:1,skipped:0,issues:0,elapsed_seconds:180,
      active_batches:[{batch:13,date:'2026-09-28',sns:['<script>bad</script>','SN-2'],stage:'查询并核对报警导出'}]};
    await fs.writeFile(path.join(root,'run/progress.json'),JSON.stringify({status:'running',stage:recovery.stage,completed:10,total:10,recovery,active_workers:[],collection_scope:{current_window:10,history_only:0,total:10,skipped_recovered_normal:2,history_recovery_only:100},historical_pending_count:60}));
    await page.locator('#recovery-count').filter({hasText:'50%'}).waitFor();
    assert.match(await page.locator('#count').textContent(),/100%/);assert.equal(await page.locator('#recovery-bar').getAttribute('value'),'50');
    assert.match(await page.locator('#scope').textContent(),/历史仅恢复复查 100 块/);assert.match(await page.locator('#scope').textContent(),/历史待确认 60 块/);
    assert.match(await page.locator('#recovery-batches').textContent(),/2026-09-28.*2块.*SN-2/);assert.equal(await page.locator('#recovery script').count(),0);
    await fs.writeFile(path.join(root,'run/progress.json'),JSON.stringify({status:'error',stage:'失败',completed:10,total:10,error:'必要证据未完整取得',active_workers:[],
      recovery:{...recovery,active:false,status:'incomplete',completed:24,succeeded:23,active_batches:[]}}));
    await page.locator('#status').filter({hasText:'失败'}).waitFor();assert.match(await page.locator('#error').textContent(),/必要证据/);
    assert.match(await page.locator('#recovery-title').textContent(),/复查未完整/);assert.equal(await page.locator('#recovery-bar').getAttribute('value'),'100');
    assert.equal((await fetch(base+'/private/credentials.dpapi')).status,404);assert.equal((await fetch(base+'/progress.json',{method:'POST'})).status,405);
  }finally{await browser?.close();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
});

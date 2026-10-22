import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { captureHeartbeatQuery, readHeartbeatSource } from '../src/heartbeat-source.mjs';

test('从真实详情请求捕获模板，共享登录cookie直接分页，不依赖表格渲染',{timeout:15000},async()=>{
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/Reports/BatteryInfo/BatteryView')) {
      res.setHeader('Set-Cookie','fixture_session=valid; Path=/; HttpOnly');res.setHeader('Content-Type','text/html');
      res.end(`<button id="refresh" onclick="fetch('/Reports/BatteryHeartbeat/Source',{method:'POST',body:'dataId=7&page=1&limit=50&fastItems=today%3BJY%3B&csrf=local'})">Refresh</button><div>Table never renders</div>`);return;
    }
    let body='';for await(const part of req)body+=part;
    const form=new URLSearchParams(body);calls.push({form,cookie:req.headers.cookie});
    res.setHeader('Content-Type','application/json');
    if(!req.headers.cookie?.includes('fixture_session=valid')){res.writeHead(401).end('{}');return;}
    const rows=Array.from({length:301},(_,i)=>({BatteryHeartbeatId:String(i),TCreateTime:'2026-10-03 15:00:00',TMinVoltage:'2.4',TBatteryHeartbeatStatus:'保护:电量不足'}));
    const size=Number(form.get('limit')),page=Number(form.get('page'));
    res.end(JSON.stringify({code:0,count:rows.length,data:rows.slice((page-1)*size,page*size)}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.JY_BROWSER_EXECUTABLE?{executablePath:process.env.JY_BROWSER_EXECUTABLE}:{})});
    const context=await browser.newContext(),page=await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/Reports/BatteryInfo/BatteryView?a=7`);
    const query=await captureHeartbeatQuery(page.mainFrame(),()=>page.locator('#refresh').click(),1500);
    const e=await readHeartbeatSource(context.request,query,{sn:'SN',reportDate:'2026-10-03',endText:'2026-10-03 16:00:00'});
    assert.equal(e.complete,true);assert.equal(e.readCount,301);assert.equal(e.metrics.requests,2);
    for(const c of calls.filter(c=>c.form.get('limit')==='300')){assert.equal(c.form.get('dataId'),'7');assert.equal(c.form.get('csrf'),'local');assert.equal(c.form.get('fastItems'),'2026-10-03 ~ 2026-10-03;JY;');}
    assert.equal(page.listenerCount('request'),0);
    await assert.rejects(captureHeartbeatQuery(page.mainFrame(),()=>page.evaluate(()=>fetch('/Reports/BatteryHeartbeat/Source',{method:'POST',body:'dataId=8&fastItems=today'})),150),/参数与当前详情不匹配/);
    assert.equal(page.listenerCount('request'),0);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

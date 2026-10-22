import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { JYPlatform, waitForTableQuery, openDetailTab, refreshCellPayload, queryHeartbeatPage, waitForDetailIdentity } from '../src/platform.mjs';

// Run explicitly with `npm run test:table`. Uses only local HTML fixtures.
let browser, page;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.JY_BROWSER_EXECUTABLE ? { executablePath: process.env.JY_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

test('详情登录失效立即返回会话错误；隐藏登录框不影响真实SN，错误SN仍不能通过',{timeout:2000},async()=>{
  await page.goto('about:blank');
  await page.setContent('<input placeholder="账号">');
  // A 60-second production waiter must settle within the 2-second test budget.
  await assert.rejects(waitForDetailIdentity(page.mainFrame(),'SN-1',60000),{code:'SESSION_EXPIRED'});
  await page.setContent('<input placeholder="账号" style="display:none"><span>SN-1</span>');
  await waitForDetailIdentity(page.mainFrame(),'SN-1',300);
  await assert.rejects(waitForDetailIdentity(page.mainFrame(),'WRONG',100),/Timeout/);
});

test('心跳页码与行号已更新但正文仍旧时，等待本次响应的记录ID全部渲染', async () => {
  await page.route('https://fixture.invalid/**', async route => {
    if (new URL(route.request().url()).pathname.includes('/BatteryHeartbeat/Source')) {
      const query = new URLSearchParams(route.request().postData());
      const current = query.get('dataId') === '1' && query.get('page') === '2' && query.get('fastItems') === '2026-09-27 ~ 2026-09-27;;';
      return route.fulfill({ json: { code: 0, count: 2, data: [{ BatteryHeartbeatId: current ? 'new' : 'wrong' }] } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <button id="next">下一页</button><div class="layui-table-view">
      <span class="layui-laypage-count">共 2 条</span><span class="layui-laypage-curr">2</span>
      <div class="layui-laypage-limits"><select><option value="1">1</option></select></div>
      <div class="layui-table-main"><table><tbody><tr><td data-field="LAY_NUM">2</td><td data-field="BatteryHeartbeatId">old</td></tr></tbody></table></div></div>
      <script>document.querySelector('#next').onclick = async () => {
        for (const params of ['dataId=2&page=2', 'dataId=1&page=1', 'dataId=1&page=2']) {
          await fetch('/Reports/BatteryHeartbeat/Source', {method:'POST', body:params+'&limit=1&fastItems=2026-09-27%20~%202026-09-27%3B%3B'});
        }
        setTimeout(() => document.querySelector('[data-field="BatteryHeartbeatId"]').textContent='new', 250);
      };</script>` });
  });
  try {
    await page.goto('https://fixture.invalid/Reports/BatteryInfo/BatteryView?a=1');
    const result = await queryHeartbeatPage(page.mainFrame(), { pageNumber: 2, pageSize: 1, reportDate: '2026-09-27' }, () => page.locator('#next').click(), 2000);
    assert.equal(result.data[0].BatteryHeartbeatId, 'new');
    assert.equal(await page.locator('[data-field="BatteryHeartbeatId"]').textContent(), 'new');
    assert.equal(page.listenerCount('request'), 0);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('平台明确显示离线时不发送实时电芯指令，保留缺失原因和采集时间', async () => {
  await page.setContent(`<div id="IsOnline" style="background-color:#cec9c9"></div><span id="DataTime">2026-09-24 01:40:17</span>
    <div class="tdCell"><span class="tdLabel">电池组编号</span><span class="tdValue">SN-1</span></div>
    <div class="tdCell"><span class="tdLabel">BMS编号</span><span class="tdValue">F100</span></div>`);
  const platform = new JYPlatform({}, { warn() {} });
  const result = await platform.readAuditDetail(page.mainFrame(), 'SN-1', 300);
  assert.equal(result.online, false);
  assert.equal(result.cellsComplete, false);
  assert.deepEqual(result.cells, []);
  assert.match(result.cellsError, /离线.*2026-09-24 01:40:17/);
});

test('不需要压差核查的在线对象仍读实际身份，但不请求电芯指令',async()=>{
  await page.setContent(`<div id="IsOnline" style="background-color:#39dd2e"></div><div class="tdCell"><span class="tdLabel">电池组编号</span><span class="tdValue">SN</span></div><div class="tdCell"><span class="tdLabel">BMS编号</span><span class="tdValue">F100</span></div>`);
  const p=new JYPlatform({}, {warn(){}});p.cellSNs=new Set();
  const d=await p.readAuditDetail(page.mainFrame(),'SN',300);assert.equal(d.bms,'F100');assert.equal(d.online,true);assert.equal(d.cellsApplicable,false);assert.equal(d.cellsComplete,false);assert.deepEqual(d.cells,[]);
});

test('BMS软件版本读取当前显式字段，忽略隐藏旧值与硬件版本，缺失和冲突不推测',async()=>{
  for(const [fields,expected,conflict] of [
    [[['BMS软件版本号','SW-1'],['硬件版本','HW-1']],'SW-1',false],
    [[['软件版本','SW-2']],'SW-2',false],
    [[['BMS版本','SW-3']],'SW-3',false],
    [[['BMS软件版本','SW-4'],['BMS版本','SW-4']],'SW-4',false],
    [[['BMS软件版本','SW-4'],['BMS版本','SW-5']],'',true],
    [[['硬件版本','HW-1']],'',false],
  ]) {
    await page.goto('about:blank');
    await page.setContent('<div style="display:none"><div class="tdCell"><span class="tdLabel">BMS软件版本号</span><span class="tdValue">wrong</span></div></div>'+[
      ['电池组编号','SN'],['BMS编号','F100'],...fields
    ].map(([key,value])=>`<div class="tdCell"><span class="tdLabel">${key}</span><span class="tdValue">${value}</span></div>`).join(''));
    const platform=new JYPlatform({}, {warn(){}});platform.cellSNs=new Set();
    const d=await platform.readAuditDetail(page.mainFrame(),'SN',300);
    assert.equal(d.bmsSoftwareVersion,expected);assert.equal(Boolean(d.bmsSoftwareVersionError),conflict);
  }
});

test('客户字段与拥有者分开读取，客户缺失或冲突均不以拥有者代替',async()=>{
  for(const customerFields of [[['客户','客户甲']],[['客户名称','客户乙']],[],[['客户','甲'],['所属客户','乙']]]) {
    await page.goto('about:blank');
    await page.setContent('<div id="IsOnline" style="background-color:#cec9c9"></div>'+[
      ['电池组编号','SN'],['BMS编号','F100'],['拥有者','平台组织'],...customerFields
    ].map(([key,value])=>`<div class="tdCell"><span class="tdLabel">${key}</span><span class="tdValue">${value}</span></div>`).join(''));
    const platform=new JYPlatform({}, {warn(){}});
    const d=await platform.readAuditDetail(page.mainFrame(),'SN',300);
    assert.equal(d.owner,'平台组织');assert.equal(d.detailVersion,2);
    assert.equal(d.customer,customerFields.length===1?customerFields[0][1]:'');
    assert.equal(Boolean(d.customerError),customerFields.length!==1);
  }
});

test('心跳code=1且无数据是有效空查询，权限错误不能冒充空结果', async () => {
  let message = '无数据';
  await page.route('https://fixture.invalid/**', route => {
    if (new URL(route.request().url()).pathname.includes('/BatteryHeartbeat/Source')) return route.fulfill({ json: { code: 1, msg: message, count: 0, data: [] } });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <button id="query" onclick="fetch('/Reports/BatteryHeartbeat/Source',{method:'POST',body:'dataId=1&page=1&limit=50&fastItems=2026-09-27%20~%202026-09-27%3B%3B'})">查询</button>
      <div class="layui-table-view"><div class="layui-none">无数据</div></div>` });
  });
  try {
    await page.goto('https://fixture.invalid/Reports/BatteryInfo/BatteryView?a=1');
    const query = () => queryHeartbeatPage(page.mainFrame(), { pageNumber: 1, pageSize: 50, reportDate: '2026-09-27' }, () => page.locator('#query').click(), 1000);
    assert.deepEqual((await query()).data, []);
    message = '无权限';
    await assert.rejects(query(), /心跳查询响应无效/);
    assert.equal(page.listenerCount('request'), 0);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('隐藏标签页的旧总数不能让当前空白查询提前完成', async () => {
  await page.setContent(`
    <div class="layui-table-view" style="display:none"><span class="layui-laypage-count">共 800 条</span></div>
    <div class="layui-table-view" id="current">正在查询</div>`);
  await assert.rejects(waitForTableQuery(page, 200), { name: 'TimeoutError' });
  await page.locator('#current').evaluate(e => { e.innerHTML = '<span class="layui-laypage-count">共 51 条</span>'; });
  await waitForTableQuery(page, 1000);
});

test('隐藏的无数据提示不能让当前查询提前完成，真实空结果可以完成', async () => {
  await page.setContent(`
    <div class="layui-table-view" style="display:none"><div class="layui-none">无数据</div></div>
    <div class="layui-table-view" id="current">正在查询</div>`);
  await assert.rejects(waitForTableQuery(page, 200), { name: 'TimeoutError' });
  await page.locator('#current').evaluate(e => { e.innerHTML = '<div class="layui-none">无数据</div>'; });
  await waitForTableQuery(page, 1000);
});

test('有可见总数但仍在加载时必须继续等待；隐藏旧加载层不影响新查询', async () => {
  await page.setContent(`
    <div style="display:none"><div class="layui-layer-loading">旧加载层</div></div>
    <div class="layui-table-view">
      <span class="layui-laypage-count">共 51 条</span>
      <div class="layui-table-init" id="loading">加载中</div>
    </div>`);
  await assert.rejects(waitForTableQuery(page, 200), { name: 'TimeoutError' });
  await page.locator('#loading').evaluate(e => e.remove());
  await waitForTableQuery(page, 1000);
});

test('基本信息首击发生在绑定事件前时，重新点击打开对应标签页', async () => {
  const started=Date.now();
  await page.setContent(`<button id="tab">基本信息</button><div id="basic" style="display:none">BMS编号</div>
    <script>document.querySelector('#tab').onclick = () => {
      document.querySelector('#tab').onclick = () => document.querySelector('#basic').style.display = 'block';
    };</script>`);
  await openDetailTab(page, '基本信息', page.locator('#basic'), 10000);
  assert.equal(await page.locator('#basic').isVisible(), true);
  assert.ok(Date.now()-started<3000,'首击未绑定时不再空等5秒');
});

test('标签内容始终不出现时仍按总时间上限失败',async()=>{
  await page.setContent('<button>基本信息</button><div id="basic" style="display:none">BMS编号</div>');
  const started=Date.now();
  await assert.rejects(openDetailTab(page,'基本信息',page.locator('#basic'),1100),{name:'TimeoutError'});
  assert.ok(Date.now()-started<2000);
});

test('已选中标签等待异步内容，不用重复点击重置加载',async()=>{
  await page.setContent(`<ul><li id="tab">基本信息</li></ul><div id="basic" style="display:none">BMS编号</div>
    <script>window.clicks=0;let timer;document.querySelector('#tab').onclick=()=>{
      window.clicks++;document.querySelector('#tab').classList.add('layui-this');clearTimeout(timer);
      timer=setTimeout(()=>document.querySelector('#basic').style.display='block',1300);
    };</script>`);
  await openDetailTab(page,'基本信息',page.locator('#basic'),3000);
  assert.equal(await page.evaluate(()=>window.clicks),1);
  assert.equal(await page.locator('#basic').isVisible(),true);
});

test('已选中但内容始终不可见仍失败，报总预算而非最后1ms',async()=>{
  await page.setContent('<ul><li class="layui-this">基本信息</li></ul><div id="basic" style="display:none">BMS编号</div>');
  await assert.rejects(openDetailTab(page,'基本信息',page.locator('#basic'),200),error=>
    error.code==='DETAIL_TAB_TIMEOUT'&&/总等待上限0.2秒/.test(error.message));
});

test('页面迟到初始化重置已选中标签时重新激活，而非一直等隐藏内容',async()=>{
  await page.setContent(`<ul><li id="tab">基本信息</li></ul><div id="basic" style="display:none">BMS编号</div>
    <script>window.clicks=0;document.querySelector('#tab').onclick=()=>{
      window.clicks++;document.querySelector('#tab').classList.add('layui-this');
      if(window.clicks===1)setTimeout(()=>document.querySelector('#tab').classList.remove('layui-this'),300);
      else document.querySelector('#basic').style.display='block';
    };</script>`);
  await openDetailTab(page,'基本信息',page.locator('#basic'),2500);
  assert.equal(await page.evaluate(()=>window.clicks),2);
  assert.equal(await page.locator('#basic').isVisible(),true);
});

test('基本信息存在隐藏同名标签和旧字段时，只点击可见标签并读取当前字段',async()=>{
  await page.setContent(`<div style="display:none">基本信息<div class="tdCell"><label class="tdLabel">BMS编号</label><span class="tdValue">wrong</span></div></div>
    <button onclick="document.querySelector('#basic').style.display='block'">基本信息</button><section id="basic" style="display:none">
    <div class="tdCell"><label class="tdLabel">电池组编号</label><span class="tdValue">SN-1</span></div>
    <div class="tdCell"><label class="tdLabel">BMS编号</label><span class="tdValue">F100-current</span></div></section>`);
  const p=new JYPlatform({}, {warn(){}});p.cellSNs=new Set();
  const detail=await p.readAuditDetail(page.mainFrame(),'SN-1',2000);
  assert.equal(detail.bms,'F100-current');assert.equal(detail.cellsApplicable,false);
});

test('电芯刷新忽略点击前已发出的迟到失败响应，错误返回保留HTTP和平台原因', async () => {
  await page.route('https://fixture.invalid/**', async route => {
    if (new URL(route.request().url()).pathname === '/') return route.fulfill({ contentType: 'text/html', body: `
      <button id="btnRefreshChionInfo" onclick="fetch('/Reports/BatteryChipInfo/Source',{method:'POST',body:'sn=SN-1'})">刷新</button>` });
    const params = new URLSearchParams(route.request().postData());
    if (params.get('initial')) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return route.fulfill({ json: { Success: false, Message: '过期的自动加载' } });
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    return route.fulfill({ json: { Success: true, Data: { Chips: [{ ChipNo: 1, Voltage: 3.2 }] } } });
  });
  try {
    await page.goto('https://fixture.invalid/');
    const started = page.waitForRequest(r => r.postData()?.includes('initial=1'));
    await page.evaluate(() => { void fetch('/Reports/BatteryChipInfo/Source', { method: 'POST', body: 'sn=SN-1&initial=1' }); });
    await started;
    const payload = await refreshCellPayload(page.mainFrame(), 'SN-1', 2000);
    assert.equal(payload.Data.Chips[0].Voltage, 3.2);
    assert.equal(page.listenerCount('request'), 0);
    await page.route('**/Reports/BatteryChipInfo/Source', route => route.fulfill({ status: 200, json: { Success: false, Message: '设备没有电芯数据' } }));
    await assert.rejects(refreshCellPayload(page.mainFrame(), 'SN-1', 2000), /HTTP 200，Success=false，设备没有电芯数据/);
    assert.equal(page.listenerCount('request'), 0);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('平台电芯指令失败时保留已核对的基本信息，缺失电压不能伪造完整', async () => {
  await page.route('https://fixture.invalid/**', route => {
    if (new URL(route.request().url()).pathname !== '/') return route.fulfill({ json: {
      Success: false, Message: null, Status: '执行指令错误,请稍后再试', Data: null,
    } });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <div class="tdCell"><span class="tdLabel">电池组编号</span><span class="tdValue">SN-1</span></div>
      <div class="tdCell"><span class="tdLabel">BMS编号</span><span class="tdValue">F100-real</span></div>
      <div class="tdCell"><span class="tdLabel">型号</span><span class="tdValue">16S</span></div>
      <button id="btnRefreshChionInfo" onclick="fetch('/Reports/BatteryChipInfo/Source',{method:'POST',body:'batteryCode=SN-1'})">刷新</button>` });
  });
  try {
    await page.goto('https://fixture.invalid/');
    const warnings = [];
    const platform = new JYPlatform({}, { warn: message => warnings.push(message) });
    const detail = await platform.readAuditDetail(page.mainFrame(), 'SN-1', 2000);
    assert.equal(detail.bms, 'F100-real');
    assert.equal(detail.model, '16S');
    assert.equal(detail.cellsComplete, false);
    assert.deepEqual(detail.cells, []);
    assert.match(detail.cellsError, /HTTP 200，Success=false，执行指令错误/);
    assert.match(warnings[0], /继续读取历史心跳/);
    await assert.rejects(platform.readAuditDetail(page.mainFrame(), 'WRONG-SN', 2000), /SN与请求对象不一致/);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

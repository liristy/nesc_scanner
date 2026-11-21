import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import JSZip from 'jszip';
import { downloadAlarmRows } from '../src/alarm-export.mjs';
import { JYPlatform } from '../src/platform.mjs';
import { parsePlatformDateTime } from '../src/utils.mjs';

const date = '2026-10-03', cutoff = `${date} 16:00:00`, sn = 'FIXTURE-1';
const alarm = '/Reports/BatteryAlarmRecord', battery = '/Reports/BatteryInfo';
const source = '/Reports/BatteryHeartbeat/Source', cells = '/Reports/BatteryChipInfo/Source';
const tokenName = '__RequestVerificationToken';
const hidden = token => `<input value="${token}" type="hidden" name="${tokenName}">`;
const label = (key, value) => `<div class="tdCell"><label class="tdLabel">${key}</label><label class="tdValue">${value}</label></div>`;
const table = (data, count = data.length) => ({ code: 0, count, data });
const empty = { code: 1, msg: '无数据', count: 0, data: [] };
const alarmFilters = `${date} ~ ${date};${sn};;;3,2;JY;;0;;`;
const heartbeat = (id, time) => ({ BatteryHeartbeatId: id, TCreateTime: `${date} ${time}`,
  TMinVoltage: '3.20[1]', TMaxVoltage: '3.21[2]', TBatteryHeartbeatStatus: '心跳数据' });
const alarmRow = (id, time = '12:00:00') => ({
  BatteryAlarmId: id, TCreateTime: `${date} ${time}`, TFinishTime: null, BatteryCode: sn,
  ErrorLevel: '保护', ErrorText: '电量不足', TError: '保护:电量不足', TProcessStatus: '待处理', TManufacture: 'JY',
});
const window = { startDate: date, endDate: date, reportDate: date };
const parseOptions = { vendor: 'JY', start: parsePlatformDateTime(date), end: parsePlatformDateTime('2026-10-04') };

async function workbook() {
  const rows = [
    ['序号', '最早报警时间', '修复时间', '电池组编号', '报警（级别：类型）', '处理状态', 'BMS厂商'],
    ['1', `${date} 12:00:00`, '', sn, '保护:电量不足', '未恢复', 'JY'],
  ];
  const xml = rows.map((row, index) => `<row>${row.map((cell, column) =>
    `<c r="${'ABCDEFG'[column]}${index + 1}" t="str"><v>${cell}</v></c>`).join('')}</row>`).join('');
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${xml}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function fixture(t, options = {}) {
  const calls = [], errors = [];
  const xlsx = await workbook();
  let detailVisits = 0, sourceRequests = 0, alarmGrowth = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const reply = (body, contentType = 'text/html') => {
      response.setHeader('Content-Type', contentType);
      response.end(body);
    };
    const json = body => reply(JSON.stringify(body), 'application/json');
    try {
      calls.push(`${request.method} ${url.pathname}`);
      const body = [];
      for await (const chunk of request) body.push(chunk);
      const form = new URLSearchParams(Buffer.concat(body).toString());
      if (url.pathname === '/Login/Index') {
        response.setHeader('Set-Cookie', 'antiforgery=fixture; Path=/; HttpOnly');
        return reply(hidden('login-token'));
      }
      assert.match(request.headers.cookie, /antiforgery=fixture/);
      if (url.pathname === '/Login/doLogin') {
        assert.equal(form.get(tokenName), 'login-token');
        assert.equal(form.get('UserName'), 'fixture-user');
        assert.equal(form.get('PassWord'), 'fixture-&-password');
        if (options.slider) return json({ ShowSlider: true });
        response.setHeader('Set-Cookie', ['auth=fixture; Path=/; HttpOnly', 'session=fixture; Path=/; HttpOnly']);
        return json({ Message: null, Url: '/Home/Index', ShowSlider: false });
      }
      assert.match(request.headers.cookie, /auth=fixture/);
      assert.match(request.headers.cookie, /session=fixture/);
      if (request.method === 'POST') {
        assert.equal(request.headers['x-requested-with'], 'XMLHttpRequest');
        assert.equal(new URL(request.headers.origin).host, request.headers.host);
      }
      switch (url.pathname) {
        case '/Home/Index': return reply('<title>Scanner fixture</title>');
        case alarm:
          assert.equal(new URL(request.headers.referer).pathname, '/Home/Index');
          return reply(`<script>const defaults={__RequestVerificationToken: 'alarm-token'};</script>`);
        case `${alarm}/TableSource`:
          assert.equal(form.get(tokenName), 'alarm-token');
          assert.equal(form.get('fastItems'), alarmFilters);
          assert.equal(form.get('sortField'), 'o.BatteryAlarmId');
          if (options.alarmPages) {
            const ascending = form.get('sortType') === 'asc';
            const page = Number(form.get('page')), limit = Number(form.get('limit'));
            const offset = (page - 1) * limit;
            if (ascending && options.newAlarm) alarmGrowth = true;
            const records = alarmGrowth ? [...options.alarmPages, options.newAlarm] : options.alarmPages;
            const sorted = ascending ? records : [...records].reverse();
            const rows = sorted.slice(offset, offset + limit);
            if (ascending && page === 2 && options.duplicateAlarm) rows[0] = records[offset - 1];
            return json(table(rows, records.length));
          }
          return json(options.emptyAlarm ? empty : table([{}], options.alarmCount ?? 1));
        case `${alarm}/DownloadData`:
          assert.equal(url.searchParams.get('fastItems'), alarmFilters);
          return options.htmlExport ? reply('<p>导出失败</p>') : reply(xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        case battery: return reply(hidden('summary-token'));
        case `${battery}/Source`:
          assert.equal(form.get(tokenName), 'summary-token');
          assert.equal(form.get('fastItems').split(';')[0], sn);
          return json(table([{ BatteryCode: sn, BatteryBaseInfoId: 42, DataTime: cutoff,
            DisplayStatus: '待机中', IsLowPower: '否', IsOnline: options.offline ? 0 : 1, BMSID: 'FIXTURE-BMS' }]));
        case `${battery}/BatteryView`:
          assert.equal(url.searchParams.get('a'), '42');
          detailVisits++;
          return reply(label('电池组编号', options.wrongDevice ? 'FIXTURE-OTHER' : sn) +
            label('BMS编号', 'FIXTURE-BMS') + label('客户', '客户 A &amp; B') + label('型号', 'F1') +
            label('BMS软件版本号', 'A.01') + label('组合方式', '2S1P') + `<span id="DataTime">${cutoff}</span>` +
            `<script>const fields = {"${tokenName}": 'device-${detailVisits}'};</script>`);
        case cells:
          assert.equal(form.get(tokenName), `device-${detailVisits}`);
          assert.equal(form.get('batteryCode'), sn);
          assert.equal(new URL(request.headers.referer).searchParams.get('a'), '42');
          return json({ Success: true, Data: { Chips: [
            { ChipNo: 1, Voltage: 3.2 }, { ChipNo: options.duplicateCells ? 1 : 2, Voltage: '3.21' },
          ] } });
        case source:
          sourceRequests++;
          assert.equal(form.get('dataId'), '42');
          assert.equal(form.get(tokenName), `device-${detailVisits}`);
          assert.equal(form.get('fastItems'), `${date} ~ ${date};;`);
          assert.equal(form.get('limit'), '2');
          if (options.expire) {
            response.writeHead(302, { Location: '/Login/Index' }).end();
            return;
          }
          if (options.refreshToken && sourceRequests === 1) {
            response.writeHead(400).end();
            return;
          }
          return json(form.get('page') === '1'
            ? table([heartbeat(3, '17:00:00'), heartbeat(2, '15:00:00')], 3)
            : table([heartbeat(options.duplicateHeartbeat ? 2 : 1, '14:00:00')], 3));
        default: throw new Error('Unexpected HTTP route');
      }
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, queryTimeoutMs: 5000,
    credentials: { username: 'fixture-user', password: 'fixture-&-password' }, auditVersion: 2,
    auditPolicy: 'current_day_pending', heartbeatSourcePageSize: 2, maxHeartbeatRecords: 20,
    maxDownloadRows: options.maxDownloadRows ?? 20 };
  const platform = await new JYPlatform(config, { info() {}, warn() {} }).open();
  t.after(() => platform.close());
  return { platform, calls };
}

const acquire = platform => platform.fetchBatterySnapshots([sn], { evidenceSNs: [sn], reportDate: date, endText: cutoff });
const exportAlarms = platform => downloadAlarmRows(platform, window, parseOptions, { bmsNumbers: [sn] });

test('正式采集入口只用 HTTP 登录、下载 XLSX、读取详情和电芯、核对心跳分页及截止', async t => {
  const { platform, calls } = await fixture(t);
  assert.equal((await exportAlarms(platform)).allRowCount, 1);
  const snapshots = await acquire(platform);
  const evidence = platform.heartbeatEvidence.get(sn);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.readCount, 3);
  assert.deepEqual(evidence.records.map(row => row.time), [`${date} 15:00:00`, `${date} 14:00:00`]);
  assert.equal(snapshots.get(sn).heartbeatTime, cutoff);
  assert.equal(evidence.detail.customer, '客户 A & B');
  assert.equal(evidence.detail.bmsSoftwareVersion, 'A.01');
  assert.equal(evidence.detail.cellsComplete, true);
  assert.deepEqual(evidence.detail.cells, [{ index: 1, voltage: 3.2 }, { index: 2, voltage: 3.21 }]);
  assert.equal(calls.filter(call => call === 'POST /Login/doLogin').length, 1);
  assert.equal(calls.filter(call => call === `POST ${source}`).length, 2);
});

test('防伪令牌被拒仅重读一次详情，重新从心跳首页验证', async t => {
  const { platform, calls } = await fixture(t, { refreshToken: true });
  await acquire(platform);
  assert.equal(platform.heartbeatEvidence.get(sn).complete, true);
  assert.equal(calls.filter(call => call === `GET ${battery}/BatteryView`).length, 2);
  assert.equal(calls.filter(call => call === `POST ${source}`).length, 3);
  assert.equal(calls.filter(call => call === `POST ${cells}`).length, 1);
});

test('认证失败、串设备和重复记录不形成完整证据', async t => {
  for (const [key, error] of [['expire', /会话已失效/], ['slider', /额外登录验证/]]) {
    const { platform, calls } = await fixture(t, { [key]: true });
    await assert.rejects(acquire(platform), error);
    assert.equal(calls.filter(call => call === 'GET /Login/Index').length, 1);
  }
  for (const [key, error] of [['wrongDevice', /不一致/], ['duplicateHeartbeat', /重复记录ID/]]) {
    const { platform, calls } = await fixture(t, { [key]: true });
    await acquire(platform);
    const evidence = platform.heartbeatEvidence.get(sn);
    assert.equal(evidence.complete, false);
    assert.match(evidence.error, error);
    if (key === 'wrongDevice') assert.ok(!calls.some(call => call === `POST ${source}`));
  }
});

test('零报警有明确确认，导出 HTML、条数不符与直接导出超限均拒绝', async t => {
  const emptyResult = await fixture(t, { emptyAlarm: true });
  assert.deepEqual(await exportAlarms(emptyResult.platform), { allRowCount: 0, rows: [] });
  assert.ok(!emptyResult.calls.includes(`GET ${alarm}/DownloadData`));
  for (const [options, error] of [[{ htmlExport: true }, /未返回 XLSX/],
    [{ alarmCount: 2 }, { code: 'ALARM_COUNT_MISMATCH' }]]) {
    const { platform, calls } = await fixture(t, options);
    await assert.rejects(exportAlarms(platform), error);
    assert.ok(calls.includes(`GET ${alarm}/DownloadData`));
  }
  const oversize = await fixture(t, { alarmCount: 2, maxDownloadRows: 1 });
  await assert.rejects(oversize.platform.queryAlarmAndDownload(window, { bmsNumbers: [sn] }), { code: 'EXPORT_LIMIT' });
  assert.ok(!oversize.calls.includes(`GET ${alarm}/DownloadData`));
});

test('单日超过 20,000 条改用分页，保留排序、字段、唯一行数及精确统计截止', async t => {
  const burst = Array.from({ length: 20205 }, (_, index) => alarmRow(index + 1));
  burst[0] = alarmRow(1, '11:59:59');
  burst[1] = alarmRow(2, '12:00:01');
  burst[201] = { ...alarmRow(202, '13:00:00'), TFinishTime: `${date} 14:00:00`, ShowVersion: 'v-fixture' };
  const { platform, calls } = await fixture(t, { alarmPages: burst, maxDownloadRows: 20000 });
  const parsed = await downloadAlarmRows(platform, window, {
    ...parseOptions, start: parsePlatformDateTime(`${date} 12:00:00`),
    end: parsePlatformDateTime(`${date} 13:00:00`), endInclusive: true,
  }, { bmsNumbers: [sn] });
  assert.equal(parsed.allRowCount, 20205);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]['BMS版本'], 'v-fixture');
  assert.equal(parsed.rows[0]['修复时间'], `${date} 14:00:00`);
  assert.deepEqual(parsed.coverage, [{ date, requests: 104, initialCount: 20205,
    uniqueCount: 20205, laterCount: 0, method: 'pages', windowCount: 2 }]);
  assert.ok(!calls.includes(`GET ${alarm}/DownloadData`));
});

test('报警分页仅接受已核对的截止后新增，拒绝截止内新增和重复 ID', async t => {
  const alarmPages = Array.from({ length: 205 }, (_, index) => alarmRow(index + 1));
  const read = platform => downloadAlarmRows(platform, window,
    { ...parseOptions, end: parsePlatformDateTime(cutoff), endInclusive: true }, { bmsNumbers: [sn] });
  const accepted = await fixture(t, { alarmPages, newAlarm: alarmRow(206, '17:00:00') });
  const result = await read(accepted.platform);
  assert.equal(result.allRowCount, 206);
  assert.equal(result.rows.length, 205);
  assert.equal(result.coverage[0].laterCount, 1);
  for (const options of [{ duplicateAlarm: true }, { newAlarm: alarmRow(206, '16:00:00') }]) {
    const { platform } = await fixture(t, { alarmPages, ...options });
    await assert.rejects(read(platform), { code: 'ALARM_PAGINATION_INCOMPLETE' });
  }
});

test('离线设备豁免实时电芯，在线设备电芯编号重复保留待确认', async t => {
  for (const key of ['offline', 'duplicateCells']) {
    const { platform, calls } = await fixture(t, { [key]: true });
    await acquire(platform);
    const evidence = platform.heartbeatEvidence.get(sn);
    assert.equal(evidence.complete, true);
    assert.equal(evidence.detail.cellsComplete, false);
    assert.equal(calls.includes(`POST ${cells}`), key !== 'offline');
  }
});

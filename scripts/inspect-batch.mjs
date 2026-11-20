import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { mapConcurrent } from '../src/concurrency.mjs';
import { shiftDay } from '../src/calendar.mjs';
import { JYPlatform } from '../src/platform.mjs';
import { batteryOnline, tableForm, tablePayload } from '../src/platform-http.mjs';
import { validVoltage } from '../src/audit-rules.mjs';
import { atomicWriteJson, chunk, parsePlatformDateTime } from '../src/utils.mjs';
import { privateStore } from './private-evidence.mjs';

const id = process.env.JY_PRIVATE_QUERY_ID;
if (process.env.REPORT_BRANCH !== 'dev' || !/^[1-9]\d*$/.test(id ?? '')) throw new Error('专项核查需要 dev 和私有请求编号');
const store = privateStore();
await store.verify();
const release = await store.call(`/releases/${id}`);
if (!release.draft || !release.tag_name.startsWith('scanner-query-')) throw new Error('专项请求必须是私有草稿 Release');
const request = JSON.parse(release.body);
const { prefix, model, day } = request;
if (!/^[A-Za-z0-9_-]{8,32}$/.test(prefix) || !/^[A-Za-z0-9_-]{3,32}$/.test(model) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) || !parsePlatformDateTime(day)) throw new Error('专项查询条件无效');

const config = await loadConfig();
const platform = await new JYPlatform(config, { info() {}, warn() {} }).open();
const output = path.join(config.projectRoot, 'run/speed-check/batch-investigation.json');
const result = { prefix, model, day, checkedAt: new Date().toISOString(), inventory: [], alarms: [], details: {}, gaps: [] };
const scalarFields = (row, pattern) => Object.fromEntries(Object.entries(row ?? {}).filter(([key, value]) =>
  pattern.test(key) && ['string', 'number', 'boolean'].includes(typeof value)));
const collectTable = async ({ page, endpoint, filters, sort, sortType = 'desc', identify, cap, inScope = () => true }) => {
  const stage = `${page}/${endpoint}`;
  const rows = [], seen = new Set();
  let total;
  for (let pageNumber = 1; pageNumber <= Math.ceil(cap / 50); pageNumber++) {
    const data = await platform.withSession(() => platform.http.withReportToken(page, async token =>
      tablePayload(await platform.http.read(`${page}/${endpoint}`, {
        form: { ...tableForm(token, filters, sort, 50), sortType, page: String(pageNumber) }, referrer: page, format: 'json',
      }))));
    total ??= data.count;
    if (!data.data.every(inScope)) throw new Error(`${stage} 返回范围以外的设备，总数 ${total}`);
    if (total > cap) throw new Error(`${stage} 返回 ${total} 条，超过专项核查上限 ${cap}`);
    if (data.count !== total || data.data.length !== Math.min(50, total - rows.length)) {
      throw new Error(`${stage} 分页总条数或单页行数不一致`);
    }
    for (const row of data.data) {
      const identity = identify(row);
      if (!identity || seen.has(identity)) throw new Error(`${stage} 缺少唯一行标识或分页重复（第 ${pageNumber} 页，平台总数 ${total}）`);
      seen.add(identity);
      rows.push(row);
    }
    if (rows.length === total) return rows;
  }
  throw new Error(`${stage} 未取得完整分页`);
};

try {
  await platform.ensureLogin();
  const rangeStart = shiftDay(day, -1);
  let inventory;
  try {
    inventory = await collectTable({ page: config.batteryInfoPath, endpoint: 'Source',
      filters: [prefix, '', '', '1', '1', '', '', '', '', '', '', ''].join(';'),
      sort: 'BatteryCode', sortType: 'asc', identify: row => String(row.BatteryBaseInfoId ?? ''), cap: 6000,
      inScope: row => typeof row.BatteryCode === 'string' && row.BatteryCode.startsWith(prefix) });
    result.inventoryScope = 'prefix-complete';
  } catch (error) {
    result.gaps.push({ stage: 'prefix-inventory', message: error.message });
    const report = await fs.readFile(path.join(config.projectRoot, 'reports',
      `${rangeStart.replaceAll('-', '')}-160000`, '电池报警复核清单.md'), 'utf8').catch(e => {
      if (e.code === 'ENOENT') return '';
      throw e;
    });
    const examples = Array.isArray(request.examples) ? request.examples.filter(sn =>
      typeof sn === 'string' && /^[A-Za-z0-9_-]+$/.test(sn) && sn.startsWith(prefix)) : [];
    const known = [...new Set([...examples, ...(report.match(/[A-Za-z0-9_-]{12,64}/g) ?? []).filter(sn => sn.startsWith(prefix))])].slice(0, 150);
    const pages = await mapConcurrent(chunk(known, 45), 3, sns => platform.readBatterySummaries(sns));
    inventory = pages.flatMap(rows => [...rows.values()]);
    result.inventoryScope = 'historical-report-and-screenshot';
    result.knownTargets = known.length;
  }
  if (!inventory.length || inventory.some(row => typeof row.BatteryCode !== 'string' ||
      !row.BatteryCode.startsWith(prefix) || !/^\d+$/.test(String(row.BatteryBaseInfoId ?? '')))) {
    throw new Error('未取得与专项前缀相符的设备清单');
  }
  result.inventory = inventory.map(row => scalarFields(row, /Battery|Model|Time|Status|Power|SOC|Volt|Current|Temper|BMS|Online|Batch|Type|Client|Customer|Owner/i));
  result.inventoryFields = Object.keys(inventory[0]);
  await atomicWriteJson(output, result);

  const batches = new Map(inventory.map(row => [row.BatteryCode,row]));
  await mapConcurrent(chunk([...batches.keys()], 45), 3, async sns => {
    try {
      const alarms = await collectTable({ page: config.alarmPath, endpoint: 'TableSource',
        filters: [`${rangeStart} ~ ${day}`, sns.join(','), '', '', '1,3,2', '', '', '0', '', ''].join(';'),
        sort: 'o.BatteryAlarmId', identify: row => String(row.BatteryAlarmId ?? row.Id ?? ''),
        cap: 500 });
      result.alarms.push(...alarms.map(row => scalarFields(row, /Battery|SN|Code|Alarm|Error|Event|Time|Status|Level|BMS|Manufactur|Recover|Repair|Process|Name|Type/i)));
      if (alarms.length) result.alarmFields = Object.keys(alarms[0]);
    } catch (error) {
      result.gaps.push({ stage: 'alarms', message: error.message });
    }
  });
  await atomicWriteJson(output, result);

  const numeric = value => typeof value === 'number' ? value : /^-?\d+(\.\d+)?$/.test(String(value).trim()) ? Number(value) : NaN;
  const suspected = (row, keys, predicate) => Object.entries(row).some(([key, value]) => keys.test(key) && predicate(numeric(value)));
  const samples = [...new Set([
    ...inventory.filter(row => Array.isArray(request.examples) && request.examples.includes(row.BatteryCode)).slice(0, 3),
    ...inventory.filter(row => /保护/.test(String(row.DisplayStatus ?? ''))).slice(0, 4),
    ...inventory.filter(row => suspected(row, /^T?(?:Battery|Pack|Total)?Vol(?:t?age)?$/i, value => value >= 0 && value < 5)).slice(0, 4),
    ...inventory.filter(row => suspected(row, /^T?(?:Battery)?Current$/i, value => Math.abs(value) > 1000)).slice(0, 3),
    ...inventory.filter(row => batteryOnline(row.IsOnline) === false).slice(0, 2),
    inventory[0],
  ])].slice(0, 12);
  platform.batteries = batches;
  let historySamples = 0;
  for (const row of samples) {
    const sn = row.BatteryCode;
    const detail = { online: batteryOnline(row.IsOnline), recordDays: {} };
    result.details[sn] = detail;
    try {
      const report = await platform.readDevicePage(sn);
      detail.fields = Object.fromEntries(report.fields);
      const readDay = async date => {
        try {
          const evidence = await platform.readSourceDay(report.query, sn, date);
          detail.recordDays[date] = { tableCount: evidence.tableCount, complete: evidence.complete, rows: evidence.records };
          detail.recordDays[date].validVoltageRows = evidence.records.filter(record => validVoltage(record) !== null).length;
        } catch (error) {
          detail.recordDays[date] = { complete: false, error: error.message };
        }
      };
      for (const date of [day, rangeStart]) await readDay(date);
      const latest = [day, rangeStart].flatMap(date => detail.recordDays[date].rows ?? [])
        .filter(record => record.time <= `${day} 16:00:00` && validVoltage(record) !== null)
        .sort((a,b) => b.time.localeCompare(a.time))[0];
      if (latest && validVoltage(latest) < 2.8 && historySamples < 3) {
        historySamples++;
        for (let offset = 2; offset <= 9; offset++) await readDay(shiftDay(day, -offset));
      }
    } catch (error) {
      detail.error = error.message;
    }
    await atomicWriteJson(output, result);
  }
} catch (error) {
  result.gaps.push({ stage: 'inventory', message: error.message });
  await atomicWriteJson(output, result);
  throw error;
} finally {
  await platform.close();
}

import { parsePlatformDateTime } from './utils.mjs';

const pageSize = 200;
const invalid = detail => Object.assign(new Error(detail), { code: 'ALARM_PAGINATION_INCOMPLETE' });

function readAlarmRow(row, { startOfDay, endOfDay, vendor, requested }) {
  const rawId = row?.BatteryAlarmId;
  const id = String(rawId ?? '');
  if (!/^[1-9]\d*$/.test(id) || (typeof rawId === 'number' && !Number.isSafeInteger(rawId))) {
    throw invalid('报警分页记录缺少精确的唯一 ID');
  }
  const time = parsePlatformDateTime(row.TCreateTime);
  const sn = String(row.BatteryCode ?? '').trim();
  const type = String(row.ErrorText ?? '').trim();
  const label = String(row.TError ?? '').trim();
  const actualVendor = String(row.TManufacture ?? '').trim();
  if (!time || time < startOfDay || time >= endOfDay || !sn || (requested.size && !requested.has(sn)) ||
      actualVendor.toUpperCase() !== vendor.toUpperCase() || row.ErrorLevel !== '保护' ||
      !type || label.replace(/^保护\s*[:：]\s*/, '') !== type || !/^保护\s*[:：]/.test(label) ||
      !Object.hasOwn(row, 'TFinishTime') || !Object.hasOwn(row, 'TProcessStatus')) {
    throw invalid('报警分页记录日期、设备、厂商、级别或必要字段与查询不符');
  }
  const repair = String(row.TFinishTime ?? '').trim();
  if (repair && !parsePlatformDateTime(repair)) throw invalid('报警分页记录的修复时间无效');
  return { id: BigInt(id), time, identity: JSON.stringify([sn, type, time.getTime(), actualVendor]),
    row: {
      最早报警时间: row.TCreateTime, 修复时间: repair, 电池组编号: sn, '报警（级别：类型）': label,
      处理状态: row.TProcessStatus, BMS厂商: actualVendor,
      型号: row.BatteryCategoryName, BMS版本: row.ShowVersion, 生产日期: row.TBatteryCreateDate, 备注: row.Comments,
      当前SOC: row.BatterySOC, 当前状态: row.DisplayStatus, 工作状态: row.TWorkStatus,
      '最高温度（℃）': row.TMaxTemperature, '最低温度（℃）': row.TMinTemperature,
      '温差（℃）': row.TDiffTemperature, 'MOS温度（℃）': row.TMosTemperature,
      '当时电流（A）': row.BatteryCurrent, '当时电压（V）': row.BatteryVolage,
      '最高电压（V）': row.TMaxVoltage, '最低电压（V）': row.TMinVoltage, '压差（V）': row.TDiffVoltage,
    } };
}

// Alarm IDs are immutable and increasing. Read the original set in ascending
// order and verify its last ID and rank against the descending starting page.
// A later tail may be accepted only after reading it and proving every added
// row is outside the fixed cutoff. A changed rank, count drop, or duplicate
// invalidates the entire scan.
export async function readAlarmPages(readPage, { date, vendor, bmsNumbers, end, minimumCount = 0 }) {
  const startOfDay = parsePlatformDateTime(date);
  const endOfDay = new Date(startOfDay.getTime() + 86400000);
  const scope = { startOfDay, endOfDay, vendor, requested: new Set(bmsNumbers) };
  let requests = 0;
  const fetchPage = async (page, limit, sortType) => {
    requests++;
    const { count, data } = await readPage({ page, limit, sortType });
    const expected = Math.min(limit, Math.max(0, count - (page - 1) * limit));
    if (!Number.isSafeInteger(count) || count < 0 || data.length !== expected) throw invalid('报警分页行数与平台总数不一致');
    return { count, records: data.map(row => readAlarmRow(row, scope)) };
  };
  const initial = await fetchPage(1, 1, 'desc');
  if (initial.count < minimumCount) throw invalid('报警总数在切换到分页查询时下降');
  const boundary = initial.records[0];
  if (!boundary) return { rows: [], proof: { date, requests, initialCount: 0, uniqueCount: 0, laterCount: 0 } };
  const rows = [];
  let lastId = 0n, latestCount = initial.count;
  for (let page = 1; page <= Math.ceil(initial.count / pageSize); page++) {
    const batch = await fetchPage(page, pageSize, 'asc');
    if (batch.count < latestCount) throw invalid('报警分页期间平台总数下降');
    latestCount = batch.count;
    for (const record of batch.records.slice(0, initial.count - rows.length)) {
      if (record.id <= lastId) throw invalid('报警分页记录 ID 重复或未按升序排列');
      lastId = record.id;
      rows.push(record.row);
      if (rows.length === initial.count && (record.id !== boundary.id || record.identity !== boundary.identity)) {
        throw invalid('报警分页末条与首次查询不一致，无法证明原有记录已读齐');
      }
    }
  }
  if (rows.length !== initial.count || lastId !== boundary.id) throw invalid('报警分页未读齐首次查询总数');

  const added = [];
  let finalCount, highest;
  for (let page = 1;; page++) {
    const tail = await fetchPage(page, pageSize, 'desc');
    finalCount ??= tail.count;
    if (tail.count !== finalCount || finalCount < latestCount) throw invalid('核对报警末页时平台总数变化');
    for (const record of tail.records) {
      if (highest !== undefined && record.id >= highest) throw invalid('报警末页记录 ID 重复或未按降序排列');
      highest = record.id;
      if (record.id === boundary.id) {
        if (record.identity !== boundary.identity || rows.length + added.length !== finalCount) {
          throw invalid('报警分页新增记录覆盖与平台总数不符');
        }
        return { rows: added.concat(rows.reverse()),
          proof: { date, requests, initialCount: initial.count, uniqueCount: finalCount, laterCount: added.length } };
      }
      if (record.id < boundary.id || added.length >= finalCount - initial.count || !end || record.time <= end) {
        throw invalid('报警分页出现截止内新增记录，或无法核对原有末条');
      }
      added.push(record.row);
    }
    if (!tail.records.length) throw invalid('未能核对报警分页末页');
  }
}

import { heartbeatRecord } from './evidence.mjs';
import { parsePlatformDateTime } from './utils.mjs';

const SOURCE_PATH = '/Reports/BatteryHeartbeat/Source';
const DISPLAY_FIELDS = ['TCreateTime', 'TBatteryHeartbeatStatus', 'TBatteryStatus', 'TMinVoltage', 'TMaxVoltage', 'TDiffVoltage', 'TMaxTemperatureNo', 'TMosTemperature', 'TMOSStatus', 'TDataStatus'];
const fault = (message, code = 'HEARTBEAT_SOURCE_INVALID') => Object.assign(new Error(message), { code });

// Only replay a query issued by the verified device's own detail frame. Keep
// platform filters/CSRF fields in memory, never serialize the request template.
export async function captureHeartbeatQuery(frame, action, timeoutMs = 10000) {
  const page = frame.page(), detail = new URL(frame.url());
  const batteryId = detail.searchParams.get('a');
  if (!batteryId || !detail.pathname.startsWith('/Reports/BatteryInfo/BatteryView')) throw fault('心跳详情缺少已核对的设备ID');
  let observed;
  const pending = page.waitForRequest(request => {
    const url = new URL(request.url());
    if (request.frame() !== frame || url.origin !== detail.origin || url.pathname !== SOURCE_PATH) return false;
    const form = new URLSearchParams(request.postData() ?? '');
    observed = { idMatches: form.get('dataId') === batteryId, hasRange: form.has('fastItems') };
    return request.method() === 'POST' && observed.idMatches && observed.hasRange;
  }, { timeout: timeoutMs });
  pending.catch(() => {});
  try {
    const [request] = await Promise.all([pending, action()]);
    return { url: request.url(), detailUrl: frame.url(), batteryId, form: request.postData() };
  } catch {
    throw fault(observed ? '心跳请求参数与当前详情不匹配，不能读取其他设备替代' : '心跳查询请求未发出，需重新打开详情', 'HEARTBEAT_QUERY_NOT_SENT');
  }
}

export function heartbeatForm(query, reportDate, pageNumber, pageSize) {
  const url = new URL(query.url), detail = new URL(query.detailUrl);
  if (url.origin !== detail.origin || url.pathname !== SOURCE_PATH || detail.searchParams.get('a') !== query.batteryId) throw fault('心跳查询目标与详情设备不一致');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !parsePlatformDateTime(`${reportDate} 00:00:00`)) throw fault('心跳查询日期无效');
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 300) throw fault('心跳分页参数无效');
  const form = new URLSearchParams(query.form);
  if (form.get('dataId') !== query.batteryId || !form.has('fastItems')) throw fault('心跳查询模板缺少设备或日期字段');
  const filters = form.get('fastItems').split(';');
  filters[0] = `${reportDate} ~ ${reportDate}`;
  form.set('fastItems', filters.join(';'));
  form.set('page', String(pageNumber)); form.set('limit', String(pageSize));
  return form.toString();
}

export function validateHeartbeatPayload(payload, status) {
  const empty = Number(payload?.code) === 1 && payload?.msg === '无数据' && payload?.count === 0 && Array.isArray(payload?.data) && payload.data.length === 0;
  if (status < 200 || status >= 300 || (Number(payload?.code) !== 0 && !empty) || !Array.isArray(payload?.data) || !Number.isInteger(payload.count) || payload.count < 0 ||
      payload.data.some(row => !row || row.BatteryHeartbeatId === undefined || row.BatteryHeartbeatId === null || String(row.BatteryHeartbeatId) === '')) {
    throw fault(`心跳查询响应无效：HTTP ${status}`);
  }
  return payload;
}

function sourceRecord(row, reportDate) {
  if (!['TCreateTime', 'TMinVoltage', 'TBatteryHeartbeatStatus'].every(key => Object.hasOwn(row, key))) throw fault(`心跳关键列变更或缺失；字段：${Object.keys(row).join('、')}`);
  const displayed = { ...row };
  for (const key of DISPLAY_FIELDS) if (Object.hasOwn(row, key)) displayed[key] = String(row[key] ?? '').trim();
  const record = heartbeatRecord(displayed);
  if (typeof record.time !== 'string' || !parsePlatformDateTime(record.time) || !record.time.startsWith(reportDate)) throw fault('心跳SN/日期范围不匹配，可能查询过期或任务跨日');
  return record;
}

export async function readHeartbeatSource(request, query, { sn, reportDate, endText, pageSize = 300, recordLimit = 6000, timeoutMs = 20000, firstPageTimeoutMs = timeoutMs, signal, progress = () => {}, stableCutoff = false } = {}) {
  if (!Number.isInteger(recordLimit) || recordLimit < 1) throw fault('心跳采集上限无效');
  if(!Number.isFinite(firstPageTimeoutMs)||firstPageTimeoutMs<=0)throw fault('心跳第一页等待上限无效');
  const records = [], ids = new Set(), signatures = new Set(), fingerprints = new Map();
  let expected, initialCount, firstIds, changed = false, requests = 0;
  const frozen = stableCutoff && endText?.startsWith(reportDate) && endText < `${reportDate} 23:59:59`;
  let descending = true, latestTime;
  const started = Date.now();
  const fetchPage = async page => {
    signal?.throwIfAborted(); progress(`心跳接口 ${reportDate} 第${page}页`);
    const body = heartbeatForm(query, reportDate, page, pageSize);
    const requestTimeout=page===1?Math.max(timeoutMs,firstPageTimeoutMs):timeoutMs;
    let response;
    try {
      response = await request.post(query.url, { data: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: query.detailUrl },
        timeout: requestTimeout, maxRedirects: 0, maxRetries: 0, ...(signal ? { signal } : {}) });
      requests++;
    } catch {
      signal?.throwIfAborted();
      // Playwright errors can contain request headers: emit only safe context.
      throw fault(`心跳接口请求失败或超时：${reportDate} 第${page}页，等待上限${requestTimeout / 1000}秒`, 'HEARTBEAT_REQUEST_TIMEOUT');
    }
    let payload;
    try {
      const status = response.status();
      if (status === 401 || status >= 300 && status < 400) throw fault('并发采集会话已失效，保留进度后由主流程重新登录', 'SESSION_EXPIRED');
      payload = await response.json().catch(() => { throw fault(`心跳接口返回非JSON：HTTP ${status}`); });
      validateHeartbeatPayload(payload, status);
    } finally { await response.dispose?.(); }
    if (payload.count > recordLimit) throw fault(`心跳记录超过采集上限${recordLimit}条，不能将部分记录当作完整结果`);
    const rowsExpected = Math.min(pageSize, Math.max(0, payload.count - (page - 1) * pageSize));
    if (payload.data.length !== rowsExpected) throw fault('心跳接口行数与总数不一致，不能标记完整');
    return payload;
  };
  for (let page = 1; page <= Math.ceil(recordLimit / pageSize); page++) {
    const payload = await fetchPage(page);
    if (expected === undefined) { expected = initialCount = payload.count; firstIds = payload.data.map(row => String(row.BatteryHeartbeatId)); }
    if (payload.count !== expected) {
      if (!frozen || payload.count < expected) throw fault(`心跳分页期间总数变化：${reportDate} 第${page}页，总数 ${expected} → ${payload.count}，每页${pageSize}条，请重新查询`);
      changed = true; expected = payload.count;
    }
    const signature = JSON.stringify(payload.data.map(row => String(row.BatteryHeartbeatId)));
    if (signatures.has(signature)) throw fault('心跳分页未推进，不能重复计数');
    signatures.add(signature);
    const pageIds = new Set();
    for (const row of payload.data) {
      const id = String(row.BatteryHeartbeatId);
      const record = sourceRecord(row, reportDate);
      if (pageIds.has(id)) throw fault('心跳分页出现重复记录ID，不能保证完整性');
      pageIds.add(id);
      if (ids.has(id)) {
        if (!changed || fingerprints.get(id)!==JSON.stringify(record)) throw fault('心跳分页出现重复记录ID或旧记录变更，不能保证完整性');
        continue; // New records at the head shift page offsets; verify below.
      }
      ids.add(id);
      fingerprints.set(id,JSON.stringify(record));
      if (latestTime && record.time > latestTime) descending = false;
      latestTime = record.time;
      if (!endText || record.time <= endText) records.push(record);
    }
    if (page * pageSize >= expected) {
      let observedCount = expected;
      if (changed) {
        // Prove that all original rows were collected and the only growth was
        // a new prefix strictly AFTER the fixed cutoff. Never simply ignore a
        // changing total, nor accept unstable in-range additions/deletions.
        const head = await fetchPage(1), added = head.count - initialCount;
        const headIds = head.data.map(row => String(row.BatteryHeartbeatId));
        const newIds = headIds.slice(0, added);
        const suffix = headIds.slice(added);
        if (!descending || head.count < expected || added < 1 || added >= pageSize || ids.size !== initialCount ||
            new Set(headIds).size !== headIds.length || newIds.some(id => ids.has(id)) ||
            suffix.some((id, index) => id !== firstIds[index]) ||
            head.data.slice(added).some(row=>fingerprints.get(String(row.BatteryHeartbeatId))!==JSON.stringify(sourceRecord(row,reportDate))) ||
            head.data.slice(0, added).some(row => sourceRecord(row, reportDate).time <= endText)) {
          throw fault('心跳分页总数变化且无法证明仅新增截止后记录，不能标记完整');
        }
        observedCount = head.count;
      } else if (ids.size !== expected) throw fault('心跳接口唯一记录数与总数不一致，不能标记完整');
      return { sn, reportDate, complete: true, tableCount: initialCount, readCount: ids.size, records, transport: 'source',
        ...(changed ? { stableCutoff: true, observedCount } : {}), metrics: { requests, pageSize, elapsedMs: Date.now() - started } };
    }
  }
  throw fault('心跳分页达到上限，不能将部分记录当作完整结果');
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson, chunk, nonEmpty, parsePlatformDateTime, readJson } from './utils.mjs';
import { readHeartbeatSource } from './heartbeat-source.mjs';
import { checkpointPath, evidenceSummary, hydrateEvidence } from './evidence-store.mjs';
import { mapConcurrent } from './concurrency.mjs';
import { collectHeartbeatHistory } from './heartbeat-history.mjs';
import { beijingText, shiftDay } from './calendar.mjs';
import { validVoltage } from './audit-rules.mjs';
import { fault, parseReportPage, PlatformHttp, sessionExpired, tableForm, tablePayload, tokenName } from './platform-http.mjs';

const validSN = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && parsePlatformDateTime(value);

export class JYPlatform {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.sessionState = { expired: false };
  }

  async open() {
    this.config.signal?.throwIfAborted();
    this.http = new PlatformHttp(this.config);
    this.sessionState = { expired: false };
    return this;
  }

  async close() {
    this.http = undefined;
    this.loginPending = undefined;
  }

  async ensureLogin() {
    this.config.signal?.throwIfAborted();
    if (this.sessionState.expired) throw sessionExpired();
    if (this.isWorker) return;
    this.loginPending ??= this.http.login();
    try {
      await this.loginPending;
    } catch (error) {
      this.loginPending = undefined;
      throw error;
    }
  }

  async withSession(operation) {
    this.config.signal?.throwIfAborted();
    if (this.sessionState.expired) throw sessionExpired();
    try {
      return await operation();
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED') this.sessionState.expired = true;
      throw error;
    }
  }

  async mapAlarmQueries(tasks, read) {
    if (!tasks.length) return [];
    await this.ensureLogin();
    return mapConcurrent(tasks, Math.min(this.config.heartbeatConcurrency ?? 3, 3),
      (task, index) => this.withSession(() => read(this, task, index)), { signal: this.config.signal });
  }

  async queryAlarmAndDownload({ startDate, endDate }, { bmsNumbers = [] } = {}) {
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate || bmsNumbers.some(sn => !validSN(sn))) {
      throw fault('报警查询日期或设备编号无效');
    }
    await this.ensureLogin();
    const page = this.config.alarmPath ?? '/Reports/BatteryAlarmRecord';
    const fastItems = [`${startDate} ~ ${endDate}`, bmsNumbers.join(','), '', '', '3,2',
      this.config.vendor ?? 'JY', '', '0', '', ''].join(';');
    const sortField = 'o.BatteryAlarmId';
    return this.withSession(async () => {
      const { count: resultCount, code, data } = await this.http.withReportToken(page, async token =>
        tablePayload(await this.http.read(`${page}/TableSource`, {
          form: tableForm(token, fastItems, sortField, 1), referrer: page, format: 'json',
        })));
      if (data.length !== Math.min(1, resultCount)) throw fault('报警列表行数与总数不一致');
      const maxRows = Math.min(this.config.maxDownloadRows ?? 20000, 20000);
      if (resultCount > maxRows) throw fault(`筛选后共有 ${resultCount} 条，超过单次导出上限 ${maxRows}`, 'EXPORT_LIMIT');
      if (resultCount === 0 && code === 1) return { resultCount, confirmedEmpty: true };
      const query = new URLSearchParams({ otherWhere: '', fastItems, sortField, sortType: 'desc', title: '电池报警记录' });
      const buffer = await this.http.read(`${page}/DownloadData?${query}`, { referrer: page, format: 'binary' });
      if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw fault('报警导出未返回 XLSX');
      return { buffer, resultCount };
    });
  }

  async readBatterySummaries(batch) {
    if (batch.some(sn => !validSN(sn))) throw fault('电池摘要查询设备编号无效');
    const page = this.config.batteryInfoPath ?? '/Reports/BatteryInfo';
    const fastItems = [batch.join(','), '', '', '1', '1', '', '', '', '', '', this.config.vendor ?? 'JY', ''].join(';');
    const { count, data } = await this.withSession(() => this.http.withReportToken(page, async token =>
      tablePayload(await this.http.read(`${page}/Source`, {
        form: tableForm(token, fastItems, 'DataTime', batch.length), referrer: page, format: 'json',
      }))));
    if (count !== data.length) throw fault('电池摘要行数与总数不一致');
    const requested = new Set(batch), result = new Map(), ids = new Set();
    for (const row of data) {
      const sn = row?.BatteryCode;
      const id = String(row?.BatteryBaseInfoId ?? '');
      if (!requested.has(sn) || result.has(sn) || !/^\d+$/.test(id) || ids.has(id)) {
        throw fault('电池摘要返回了重复或未请求的设备，无法证明身份');
      }
      if (!['DataTime', 'DisplayStatus'].every(key => Object.hasOwn(row, key))) {
        throw fault('电池摘要缺少采集时间或电池状态字段');
      }
      result.set(sn, row);
      ids.add(id);
    }
    return result;
  }

  async readDevicePage(sn) {
    const battery = this.batteries?.get(sn);
    if (!battery) throw fault('电池查询未返回该SN，不能读取其他设备替代');
    const batteryId = String(battery.BatteryBaseInfoId);
    const batteryPath = this.config.batteryInfoPath ?? '/Reports/BatteryInfo';
    const detailPath = `${batteryPath}/BatteryView?${new URLSearchParams({ a: batteryId })}`;
    const { fields, token, lastDataTime } = parseReportPage(
      await this.withSession(() => this.http.read(detailPath, { timeout: this.config.heartbeatDetailTimeoutMs ?? 45000 })),
      { detail: true },
    );
    if (fields.get('电池组编号') !== sn ||
        (battery.BMSID && fields.get('BMS编号') && fields.get('BMS编号') !== String(battery.BMSID).trim())) {
      throw fault('基本信息SN或BMS编号与设备摘要不一致');
    }
    const detailUrl = this.http.url(detailPath);
    const query = { url: this.http.url('/Reports/BatteryHeartbeat/Source'), detailUrl, batteryId,
      form: new URLSearchParams({ ...tableForm(token, ';;', 'BatteryHeartbeatId', 1), dataId: batteryId }).toString() };
    return { battery, fields, token, lastDataTime, detailUrl, query };
  }

  async readAuditDetail(sn, page) {
    const { fields, lastDataTime, detailUrl } = page;
    const customerFields = ['客户', '客户名称', '所属客户'].filter(key => fields.get(key));
    const customers = new Set(customerFields.map(key => fields.get(key)));
    const softwareFields = ['BMS软件版本号', 'BMS软件版本', '软件版本号', '软件版本', 'BMS版本'].filter(key => fields.get(key));
    const softwareVersions = new Set(softwareFields.map(key => fields.get(key)));
    const onlineFlag = page.battery.IsOnline;
    const online = [1, '1', true].includes(onlineFlag) ? true : [0, '0', false].includes(onlineFlag) ? false : null;
    const detail = { sn, bms: fields.get('BMS编号') || '', model: fields.get('型号') || '',
      bmsSoftwareVersion: softwareVersions.size === 1 ? [...softwareVersions][0] : '',
      bmsSoftwareVersionSource: softwareVersions.size === 1 ? softwareFields.join('／') : '',
      bmsSoftwareVersionError: softwareVersions.size > 1 ? '平台BMS软件版本字段不一致，需人工复核' : '',
      customer: customers.size === 1 ? [...customers][0] : '',
      customerSource: customers.size === 1 ? customerFields.join('／') : '',
      customerError: customers.size > 1 ? '平台客户字段不一致，需人工复核' : customers.size === 0 ? '平台客户字段为空或未提供' : '',
      owner: fields.get('拥有者') || '', detailVersion: 2, site: fields.get('站点') || '', url: detailUrl,
      collectedAt: beijingText(new Date()), cells: [], cellsComplete: false, online, lastDataTime };
    if (this.cellSNs && !this.cellSNs.has(sn)) return { ...detail, cellsApplicable: false };
    if (online === false) {
      detail.cellsError = '平台显示设备离线，无法读取实时逐节电压';
      return detail;
    }
    try {
      this.logger.progress?.({ detail_stage: '读取电芯接口' });
      const read = token => this.withSession(() => this.http.read('/Reports/BatteryChipInfo/Source', {
        form: { batteryCode: sn, [tokenName]: token }, referrer: detailUrl, format: 'json',
        timeout: this.config.heartbeatDetailTimeoutMs ?? 45000,
      }));
      const payload = await read(page.token).catch(async error => {
        if (error.code !== 'PLATFORM_TOKEN_REJECTED') throw error;
        const refreshed = await this.readDevicePage(sn);
        Object.assign(page.query, refreshed.query);
        return read(refreshed.token);
      });
      if (payload?.Success !== true || !Array.isArray(payload.Data?.Chips)) throw fault('平台未返回实时电芯数据');
      detail.cells = payload.Data.Chips.map(chip => ({
        index: Number(chip?.ChipNo),
        voltage: ['string', 'number'].includes(typeof chip?.Voltage) && String(chip.Voltage).trim() !== '' &&
          Number.isFinite(Number(chip.Voltage)) ? Number(chip.Voltage) : null,
      }));
      const expected = Number(/^(\d+)S/i.exec(fields.get('组合方式') ?? '')?.[1]);
      detail.cellsComplete = detail.cells.length > 0 && new Set(detail.cells.map(cell => cell.index)).size === detail.cells.length &&
        (!expected || detail.cells.length === expected) &&
        detail.cells.every(cell => Number.isInteger(cell.index) && cell.index >= 1 &&
          (!expected || cell.index <= expected) && Number.isFinite(cell.voltage));
      if (!detail.cellsComplete) detail.cellsError = '电芯电压数据缺失或不完整';
    } catch (error) {
      this.config.signal?.throwIfAborted();
      if (error.code === 'SESSION_EXPIRED') throw error;
      detail.cellsError = error.message;
    }
    return detail;
  }

  async readSourceDay(query, sn, reportDate, endText, progress) {
    const read = () => this.withSession(() => readHeartbeatSource(this.http, query, {
      sn, reportDate, endText, pageSize: this.heartbeatPageSize ?? this.config.heartbeatSourcePageSize ?? 300,
      recordLimit: this.config.maxHeartbeatRecords ?? (this.config.maxHeartbeatPages ?? 20) * 300,
      stableCutoff: this.config.heartbeatStableCutoff ?? false,
      timeoutMs: this.config.heartbeatRequestTimeoutMs ?? 20000,
      firstPageTimeoutMs: this.config.heartbeatFirstPageTimeoutMs ?? 60000,
      signal: this.config.signal, progress,
    }));
    const result = await read().catch(async error => {
      if (error.code !== 'PLATFORM_TOKEN_REJECTED') throw error;
      Object.assign(query, (await this.readDevicePage(sn)).query);
      return read();
    });
    this.logger.info(`SN ${sn} ${reportDate} 心跳接口读取${result.readCount}条，${result.metrics.requests}次请求，${(result.metrics.elapsedMs / 1000).toFixed(1)}秒。`);
    return result;
  }

  async fetchTodayHeartbeat(sn, reportDate, endText, { detailOnly = false } = {}) {
    const step = detail_stage => {
      this.lastHeartbeatStep = detail_stage;
      this.logger.progress?.({ detail_stage });
    };
    this.heartbeatQueries ??= new Map();
    this.auditDetails ??= new Map();
    if (!this.heartbeatQueries.has(sn)) {
      step('核对设备基本信息');
      const page = await this.readDevicePage(sn);
      if (this.config.auditVersion === 2) this.auditDetails.set(sn, await this.readAuditDetail(sn, page));
      this.heartbeatQueries.set(sn, page.query);
    }
    const detail = this.auditDetails.get(sn);
    if (detailOnly) return { detail };
    return { ...await this.readSourceDay(this.heartbeatQueries.get(sn), sn, reportDate, endText, step), detail };
  }

  async fetchBatterySnapshots(bmsNumbers, { evidenceSNs = [], reportDate, endText, cachedEvidence, cellSNs, progressTotal, progressCompleted, progressFailed } = {}) {
    this.config.signal?.throwIfAborted();
    if (!this.isWorker) return this.fetchBatterySnapshotsConcurrent(bmsNumbers, { evidenceSNs, reportDate, endText, cachedEvidence, cellSNs, progressTotal, progressCompleted, progressFailed });
    this.cachedAuditEvidence = cachedEvidence;
    this.cellSNs = new Set(cellSNs ?? evidenceSNs);
    const unique = [...new Set(bmsNumbers.filter(nonEmpty))];
    if (!unique.length) return new Map();
    const snapshots = new Map();
    this.lastSnapshots = snapshots;
    this.heartbeatEvidence = new Map();
    this.auditDetails = new Map();
    this.heartbeatQueries = new Map();
    this.batteries = new Map();
    const evidenceSet = new Set(evidenceSNs);
    this.batchResetRequested = false;
    let consecutiveFailures = 0, failed = 0;
    const heartbeatStartedAt = Date.now();
    const safeBatchSize = Math.min(Math.max(Number(this.config.batteryBatchSize) || 45, 1), 45);
    for (const batch of chunk(unique, safeBatchSize)) {
      this.config.signal?.throwIfAborted();
      if (this.sessionState?.expired) throw sessionExpired();
      this.logger.progress?.({ detail_stage: '查询本批电池摘要' });
      for (const [sn, battery] of await this.readBatterySummaries(batch)) {
        this.batteries.set(sn, battery);
        snapshots.set(sn, { heartbeatTime: String(battery.DataTime ?? '').trim(),
          batteryStatus: String(battery.DisplayStatus ?? '').trim(), sleeping: String(battery.IsLowPower ?? '') });
      }
      for (const sn of batch.filter(sn => evidenceSet.has(sn))) {
        this.config.signal?.throwIfAborted();
        if (this.sessionState?.expired) return snapshots;
        let evidence;
        const snStartedAt=Date.now();
        this.logger.progress?.({ stage: "心跳查询", current_sn: sn, completed: this.heartbeatEvidence.size, total: evidenceSet.size, failed, succeeded: this.heartbeatEvidence.size - failed });
        try {
          evidence = this.config.auditVersion === 2 ? await this.fetchAuditEvidence(sn, reportDate, endText) : await this.fetchHeartbeatWithRetry(sn, reportDate, endText);
        } catch (error) {
          this.config.signal?.throwIfAborted();
          const detail = this.auditDetails.get(sn);
          evidence = { sn, reportDate, complete: false, records: [], error: String(error.message),
            errorCode: error.code, ...(detail ? { detail } : {}) };
          this.logger.warn(`SN ${sn} 心跳证据待核实：${String(error.message).split("\n")[0]}`);
        }
        if(evidence.complete)consecutiveFailures=0;
        else {failed++;consecutiveFailures++;}
        const snapshot = snapshots.get(sn);
        if (snapshot) {
          if (evidence.detail) snapshot.detail = evidence.detail;
          const physical = evidence.records.filter(r => r.minVoltage !== "" || r.maxVoltage !== "" || r.workStatus !== "");
          const latestTime = physical.map(r => r.time).sort().at(-1);
          const latest = physical.filter(r => r.time === latestTime);
          snapshot.latestEvidenceTime = latestTime ?? null;
          snapshot.latestAlarmTypes = [...new Set(latest.filter(r => /^保护\s*[:：]/.test(r.event)).map(r => r.event.replace(/^保护\s*[:：]\s*/, "").trim()))];
          snapshot.evidenceComplete = evidence.complete;
          snapshot.evidenceError = evidence.error ?? "";
        }
        await this.saveAcquisitionCheckpoint(`batch-sn-${createHash('sha256').update(sn).digest('hex').slice(0, 24)}`, new Map(snapshot ? [[sn, snapshot]] : []), new Map([[sn, evidence]]), { reportDate, endText });
        this.heartbeatEvidence.set(sn, this.config.boundedEvidenceMemory && this.config.projectRoot ? evidenceSummary(evidence,endText,checkpointPath(this.config.projectRoot,sn)) : evidence);
        const completed = this.heartbeatEvidence.size;
        const seconds = (Date.now() - heartbeatStartedAt) / 1000;
        const remainingSeconds = completed ? Math.round(seconds / completed * (evidenceSet.size - completed)) : null;
        this.logger.progress?.({ stage: "心跳查询", current_sn: sn, completed, total: evidenceSet.size, succeeded: completed - failed, failed, estimated_remaining_seconds: remainingSeconds });
        this.logger.info(`心跳证据进度：${completed}/${evidenceSet.size} 个SN；心跳完整${completed - failed}，心跳待核实${failed}；${sn} ${evidence.complete ? "已读取" : "待核实"}${this.cellSNs.has(sn) && evidence.detail && !evidence.detail.cellsComplete ? '；电芯证据仍缺失' : ''}；本SN含详情/历史耗时${((Date.now()-snStartedAt)/1000).toFixed(1)}秒；预估剩余${Math.ceil(remainingSeconds / 60)}分钟`);
        if (consecutiveFailures >= 3) {
          this.batchResetRequested = this.config.auditPolicy === 'current_day_pending';
          this.logger.warn(this.batchResetRequested
            ? '当前批次连续3个SN失败，已失败对象保留待确认；更换批次后继续尚未读取的设备。'
            : '当前批次连续3个SN失败，保留已采集证据，剩余设备交由新批次补查。');
          return snapshots;
        }
      }
    }
    if (unique.length && snapshots.size === 0 && this.config.auditPolicy !== 'current_day_pending') {
      throw new Error(`需复核 ${unique.length} 个 BMS，但电池查询未读取到任何最新心跳摘要；本周期状态核验不完整`);
    }
    this.logger.info(`心跳复核：需要 ${unique.length} 个 BMS，成功匹配 ${snapshots.size} 个。`);
    return snapshots;
  }

  async fetchBatterySnapshotsConcurrent(bmsNumbers, options) {
    const unique = [...new Set(bmsNumbers.filter(nonEmpty))], snapshots = new Map();
    this.lastSnapshots = snapshots;
    this.heartbeatEvidence = new Map();
    this.acquisitionWarnings = [];
    if (!unique.length) return snapshots;
    await this.ensureLogin();
    const batches = chunk(unique, Math.min(Math.max(Number(this.config.heartbeatBatchSize ?? this.config.batteryBatchSize) || 45, 1), 45, Math.max(1, Math.ceil(unique.length / (this.config.heartbeatConcurrency ?? 3)))));
    const active = new Map(), started = Date.now();
    const evidenceSet = new Set(options.evidenceSNs), base = options.progressCompleted ?? 0;
    const total = options.progressTotal ?? evidenceSet.size;
    let phase = '并发采集', repairFailures = 0;
    const publishProgress = () => {
      const attempted = [...this.heartbeatEvidence.values()].filter(e => e.attempted !== false);
      const completed = attempted.length + base, failed = attempted.filter(e => !e.complete).length + (options.progressFailed ?? 0);
      this.logger.progress?.({ stage: phase, current_sn: [...active.values()].map(a => a.sn).join('、'),
        active_workers: [...active].map(([lane, item]) => ({ lane: lane + 1, ...item })), concurrency: this.config.heartbeatConcurrency ?? 3,
        completed, total, failed, succeeded: completed - failed, heartbeat_complete: completed - failed, pending: total - completed + failed,
        estimated_remaining_seconds: completed > base ? Math.round((Date.now() - started) / 1000 / (completed - base) * (total - completed + (this.config.auditPolicy==='current_day_pending'?0:failed))) : null });
    };
    const runBatch = async (batch, index, lane, repair = false) => {
        if (this.sessionState.expired) return;
        if (repair && repairFailures >= 3) return;
        active.set(lane, { sn: repair ? batch[0] : `批次${index + 1}（${batch.length}块）`, stage: '创建查询批次' });
        publishProgress();
        const worker = new JYPlatform(this.config, {
            info: message => this.logger.info(`[并发 ${lane + 1}] ${message}`),
            warn: message => this.logger.warn(`[并发 ${lane + 1}] ${message}`),
            progress: update => {
              if (update.current_sn) active.set(lane, { sn: update.current_sn, stage: update.detail_stage || '读取心跳' });
              else if (update.detail_stage && active.has(lane)) active.get(lane).stage = update.detail_stage;
              for (const [sn, evidence] of worker.heartbeatEvidence ?? []) this.heartbeatEvidence.set(sn, evidence);
              publishProgress();
            },
        });
        worker.isWorker = true;
        worker.http = this.http;
        worker.sessionState = this.sessionState;
        let remaining=[];
        const neededEvidence = batch.filter(sn => evidenceSet.has(sn) && (!repair || !this.heartbeatEvidence.get(sn)?.complete));
        try {
          if (repair) this.logger.info(`新批次并发补查 ${index + 1}：${batch.join('、')}`);
          const result = await worker.fetchBatterySnapshots(batch, { ...options, evidenceSNs: neededEvidence });
          for (const [sn, snapshot] of result) snapshots.set(sn, snapshot);
          if(this.config.auditPolicy==='current_day_pending' && worker.batchResetRequested && !this.sessionState.expired) {
            remaining=neededEvidence.filter(sn=>!worker.heartbeatEvidence?.has(sn));
            // Continue only after recording at least one device in the batch.
            if(remaining.length===neededEvidence.length)remaining=[];
          }
          if (repair) {
            if (batch.some(sn => !result.has(sn) || neededEvidence.includes(sn) && !worker.heartbeatEvidence?.get(sn)?.complete)) repairFailures++;
            else repairFailures = 0;
          }
        } catch (error) {
          this.config.signal?.throwIfAborted();
          if(error.code==='AUTH_REQUIRED' || error.code==='SESSION_EXPIRED')throw error;
          if (repair) repairFailures++;
          this.logger.warn(`批次 ${index + 1} 查询异常，${this.config.auditPolicy==='current_day_pending'?'归类待确认':'保存进度并安排补查'}：${String(error.message).split('\n')[0]}`);
          if(this.config.auditPolicy==='current_day_pending')for(const sn of neededEvidence)if(!worker.heartbeatEvidence?.has(sn)) {
            worker.heartbeatEvidence ??= new Map();
            worker.heartbeatEvidence.set(sn,{sn,complete:false,attempted:true,records:[],error:String(error.message).split('\n')[0]});
          }
          for (const [sn, snapshot] of worker.lastSnapshots ?? []) snapshots.set(sn, snapshot);
        } finally {
          for (const [sn, snapshot] of worker.lastSnapshots ?? []) snapshots.set(sn, snapshot);
          for (const [sn, evidence] of worker.heartbeatEvidence ?? []) this.heartbeatEvidence.set(sn, evidence);
          await this.saveAcquisitionCheckpoint(`${repair ? 'repair' : 'batch'}-${index}`, worker.lastSnapshots ?? new Map(), worker.heartbeatEvidence ?? new Map(), options);
          active.delete(lane);
          publishProgress();
        }
        if(remaining.length)await runBatch(remaining,index,lane);
    };
    try {
      publishProgress();
      await mapConcurrent(batches, this.config.heartbeatConcurrency ?? 3, runBatch, { signal: this.config.signal });
      // Bounded concurrent repair, with independent state per SN. Successfully
      // verified devices never enter the repair queue. Stop issuing new work
      // after three failures; already in-flight lanes finish and checkpoint.
      const pending = this.config.auditPolicy==='current_day_pending'?[]:unique.filter(sn => !snapshots.has(sn) || (evidenceSet.has(sn) && !this.heartbeatEvidence.get(sn)?.complete));
      if(pending.length) {
        phase = '并发补查'; publishProgress();
        await mapConcurrent(pending, this.config.heartbeatConcurrency ?? 3, (sn, index, lane) => runBatch([sn], index, lane, true), { signal: this.config.signal });
      }
      if (repairFailures >= 3) this.logger.warn('新批次补查连续3次失败，停止发起新补查，保留明确标记的部分报告。');
      for (const sn of evidenceSet) {
        if (!this.heartbeatEvidence.has(sn)) this.heartbeatEvidence.set(sn, { sn, reportDate: options.reportDate, complete: false, attempted: false, records: [], error: this.sessionState.expired ? sessionExpired().message : '批次异常，本次未完成补查' });
      }
      publishProgress();
      const missing = unique.filter(sn => !snapshots.has(sn));
      if (missing.length) this.acquisitionWarnings.push(`电池摘要有 ${missing.length} 个SN未取得：${missing.join('、')}；缺失证据保留待核实。`);
      if(this.sessionState.expired && this.config.auditPolicy==='current_day_pending')throw sessionExpired();
      if (!snapshots.size && this.config.auditPolicy!=='current_day_pending') throw new Error('所有电池摘要均未取得，已保存采集进度，未覆盖滚动状态');
      return snapshots;
    } finally {
      this.logger.progress?.({ active_workers: [], current_sn: '' });
    }
  }

  async saveAcquisitionCheckpoint(key, snapshots, evidence, options) {
    if (!this.config.projectRoot) return;
    if(this.config.boundedEvidenceMemory && /^(batch|repair)-\d+$/.test(key))return;
    const directory = path.join(this.config.projectRoot, 'run', 'acquisition');
    await fs.mkdir(directory, { recursive: true });
    await atomicWriteJson(path.join(directory, `${key}.json`), {
      reportDate: options.reportDate, endText: options.endText,
      snapshots: Object.fromEntries(snapshots), evidence: Object.fromEntries(evidence),
    });
  }

  async fetchHeartbeatWithRetry(sn, reportDate, endText) {
    const previousSize = this.heartbeatPageSize;
    const maxAttempts = this.config.auditPolicy==='current_day_pending'?1:3;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.config.signal?.throwIfAborted();
        if(this.sessionState?.expired)throw sessionExpired();
        this.lastHeartbeatStep = undefined;
        try { return await this.fetchTodayHeartbeat(sn, reportDate, endText); }
        catch (error) {
          this.config.signal?.throwIfAborted();
          if(error.code==='SESSION_EXPIRED') {if(this.sessionState)this.sessionState.expired=true;throw error;}
          const message = String(error.message);
          const unstablePagination = /分页未推进|重复记录ID|总数变化/.test(message);
          const retryable = unstablePagination || /Timeout|超时/.test(message);
          if (!retryable || attempt === maxAttempts) throw error;
          // Reopen and discard the failed scan. A larger page reduces the
          // window for live inserts to shift offsets; all completeness checks
          // still apply, including on the final attempt.
          if (unstablePagination) this.heartbeatPageSize = 300;
          const reason = /总数变化/.test(message) ? '心跳分页期间总数变化' : unstablePagination ? '出现重复分页' : '页面响应不稳定';
          const retryAction = `重新查询心跳接口${unstablePagination ? '并尝试较大分页' : ''}`;
          this.logger.warn(`SN ${sn} ${reportDate} ${reason}，${retryAction}（重试${attempt}/${maxAttempts - 1}）；阶段：${this.lastHeartbeatStep ?? '未知'}；原因：${message.split('\n')[0]}`);
        }
      }
    } finally { this.heartbeatPageSize = previousSize; }
  }

  async fetchAuditEvidence(sn, reportDate, endText) {
    // Refresh identity/live cells without scanning already verified days again.
    // Rolling evidence may also contain individually verified days from a
    // partial scan; it is never reused as a complete device result.
    const reusable=await hydrateEvidence(sn,this.cachedAuditEvidence?.get(sn));
    if(reusable?.complete && (!reusable.coverageCutoff || reusable.coverageCutoff===endText) && (!reusable.historyComplete || reusable.historyDays?.length>=10)) {
      const {detail}=await this.fetchTodayHeartbeat(sn,reportDate,endText,{detailOnly:true});
      this.logger.info(`SN ${sn} 复用截止${endText}已核验心跳，仅更新基本信息和电芯。`);
      return {...reusable,detail};
    }
    const cache=this.config.projectRoot?await readJson(path.join(this.config.projectRoot,'run/acquisition',`history-${Buffer.from(sn).toString('hex')}.json`)).catch(()=>null):null;
    const saved=cache?.endText===endText && cache?.reportDate===reportDate?cache.evidence?.[sn]:null;
    // A completed current day survives failures in an older day. Refresh live
    // identity/cells while reusing only explicitly checkpointed day coverage.
    const current=saved?.historyCoverageVersion===1 && saved.coverageCutoff===endText && saved.historyDays?.includes(reportDate)
      ? {...saved,complete:true,records:saved.records.filter(r=>r.time.startsWith(reportDate)),detail:(await this.fetchTodayHeartbeat(sn,reportDate,endText,{detailOnly:true})).detail}
      :await this.fetchHeartbeatWithRetry(sn,reportDate,endText);
    if(!current.complete)return {...current,complete:false,historyComplete:false,coverageCutoff:endText};
    const latest=current.records.filter(r=>validVoltage(r)!==null).sort((a,b)=>a.time.localeCompare(b.time)).at(-1);
    if(latest && validVoltage(latest)>=2.8)return {...current,historyComplete:false,coverageCutoff:endText};
    // Reuse the verified device query while reading historical dates serially.
    const query=this.heartbeatQueries?.get(sn);
    const dates=Array.from({length:9},(_,i)=>shiftDay(reportDate,-i-1));
    let reusedDays=0,networkDays=0;
    const started=Date.now();
    const base={...current,reportDate,coverageCutoff:endText};delete base.error;
    const cachedDays=new Map();
    for(const date of dates) {
      const priorDay=(reusable?.complete || reusable?.historyCoverageVersion===1) && reusable.coverageCutoff<endText && date<reusable.coverageCutoff.slice(0,10)
        && reusable.historyDays?.includes(date);
      if(saved?.coverageCutoff===endText && saved?.historyDays?.includes(date)) {
        reusedDays++;cachedDays.set(date,{complete:true,records:saved.records.filter(r=>r.time.startsWith(date))});
      }
      else if(priorDay){reusedDays++;cachedDays.set(date,{complete:true,records:reusable.records.filter(r=>r.time.startsWith(date))});}
    }
    const result=await collectHeartbeatHistory(base,dates,async date=>{
      this.config.signal?.throwIfAborted();
      if(this.sessionState?.expired)throw sessionExpired();
      if(cachedDays.has(date))return cachedDays.get(date);
      networkDays++;
      return query ? this.readSourceDay(query,sn,date,endText,stage=>this.logger.progress?.({detail_stage:stage}))
        : this.fetchHeartbeatWithRetry(sn,date,endText);
    },evidence=>this.saveAcquisitionCheckpoint(`history-${Buffer.from(sn).toString('hex')}`,new Map(),new Map([[sn,evidence]]),{reportDate,endText}),
    {signal:this.config.signal});
    result.historyMetrics={mode:'days',concurrency:1,networkDays,reusedDays,elapsedMs:Date.now()-started};
    if(reusedDays)this.logger.info(`SN ${sn} 复用${reusedDays}天完整历史心跳，已补查新增日期及上次截止后的时段。`);
    return result;
  }

}

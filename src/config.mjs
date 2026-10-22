import { readCredentials } from './private-store.mjs';
import { LOW_VOLTAGE_RULE } from './audit-rules.mjs';
import { AUDIT_CUTOFF_TIME } from './calendar.mjs';
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


async function readTrimmed(filePath) {
  if (!filePath) return "";
  return (await fs.readFile(filePath, "utf8")).trim();
}

async function loadCredentials(dataRoot, runtime) {
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
  const usernamePath = process.env.JY_ALARM_USERNAME_FILE || (credentialDirectory ? path.join(credentialDirectory, "username") : "");
  const passwordPath = process.env.JY_ALARM_PASSWORD_FILE || (credentialDirectory ? path.join(credentialDirectory, "password") : "");
  const username = usernamePath ? await readTrimmed(usernamePath) : String(process.env.JY_ALARM_USERNAME ?? "").trim();
  const password = passwordPath ? await readTrimmed(passwordPath) : String(process.env.JY_ALARM_PASSWORD ?? "");
  if (!username && !password && runtime !== 'github') return await readCredentials(dataRoot) ?? {};
  if (!username || !password) {
    throw new Error("外部登录凭据不完整，账号和密码必须同时提供。");
  }
  return { username, password };
}

export async function loadConfig() {
  const dataRoot = path.resolve(process.env.JY_ALARM_DATA_DIR || projectRoot);
  const defaults = {
    baseUrl: "https://cloud.cnano.com.cn",
    alarmPath: "/Reports/BatteryAlarmRecord",
    batteryInfoPath: "/Reports/BatteryInfo",
    timezone: "Asia/Shanghai",
    vendor: "JY",
    headless: true,
    scheduleTime: AUDIT_CUTOFF_TIME,
    windowCutoffTime: AUDIT_CUTOFF_TIME,
    windowMode: "workday",
    auditPolicy: 'current_day_pending',
    historicalReviewMode: 'recovery_only',
    largeResultThreshold: 2000,
    maxDownloadRows: 20000,
    batteryBatchSize: 45,
    heartbeatConcurrency: 3,
    heartbeatBatchSize: 9,
    heartbeatTransport: 'source',
    heartbeatSourcePageSize: 300,
    heartbeatRequestTimeoutMs: 20000,
    heartbeatFirstPageTimeoutMs: 60000,
    heartbeatDetailTimeoutMs: 45000,
    navigationTimeoutMs: 60000,
    queryTimeoutMs: 120000,
    ...LOW_VOLTAGE_RULE,
    maxSampleGapMinutes: 1440,
    maxEvidenceAgeMinutes: 1440,
    maxHeartbeatPages: 20,
    maxHeartbeatRecords: 60000,
    heartbeatStableCutoff: true,
    maxTrackingRefreshBatches: 20,
  };
  const configPath = process.env.JY_ALARM_CONFIG || path.join(dataRoot, "config.json");
  let fileConfig = {};
  try {
    // Windows PowerShell 5 写出的 UTF-8 JSON 可能带 BOM。
    fileConfig = JSON.parse((await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const config = { ...defaults, ...fileConfig, vendor: 'JY', timezone: 'Asia/Shanghai', scheduleTime: AUDIT_CUTOFF_TIME, windowCutoffTime: AUDIT_CUTOFF_TIME, auditVersion: 2 };
  config.historicalReviewMode=fileConfig.historicalReviewMode ?? (config.auditPolicy==='current_day_pending'?'recovery_only':'full');
  config.auditDate=process.env.JY_AUDIT_DATE || undefined;
  if (!["workday", "daily"].includes(config.windowMode)) throw new Error("windowMode 必须为 workday 或 daily");
  if (!['continuous', 'current_day_pending'].includes(config.auditPolicy)) throw new Error('auditPolicy 必须为 continuous 或 current_day_pending');
  if (!['full', 'recovery_only'].includes(config.historicalReviewMode)) throw new Error('historicalReviewMode 必须为 full 或 recovery_only');
  if (!['source', 'rendered'].includes(config.heartbeatTransport)) throw new Error('heartbeatTransport 必须为 source 或 rendered');
  if(!Number.isInteger(config.maxHeartbeatRecords)||config.maxHeartbeatRecords<6000||config.maxHeartbeatRecords>120000)throw new Error('心跳单日采集上限必须为6000～120000的整数');
  if(typeof config.heartbeatStableCutoff!=='boolean')throw new Error('heartbeatStableCutoff 必须为布尔值');
  if (!Number.isInteger(config.heartbeatSourcePageSize) || config.heartbeatSourcePageSize < 1 || config.heartbeatSourcePageSize > 300) throw new Error('心跳接口每页条数应为1～300的整数');
  for (const key of ['heartbeatRequestTimeoutMs', 'heartbeatFirstPageTimeoutMs', 'heartbeatDetailTimeoutMs']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`${key} 必须为正数`);
  }
  if(!Number.isInteger(config.heartbeatBatchSize)||config.heartbeatBatchSize<1||config.heartbeatBatchSize>45)throw new Error('设备任务批次应为1～45');
  if (!Number.isInteger(config.heartbeatConcurrency) || config.heartbeatConcurrency < 1 || config.heartbeatConcurrency > 8) throw new Error("并发数应为 1～8 的整数");
  for (const key of ["lowVoltageThresholdV", "lowVoltageDurationMinutes", "maxSampleGapMinutes", "maxEvidenceAgeMinutes", "maxHeartbeatPages", "maxTrackingRefreshBatches"]) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`${key} 必须为正数`);
  }
  for (const key of ["scheduleTime", "windowCutoffTime"]) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(config[key] ?? ""))) {
      throw new Error(`${key} 必须是 HH:mm 格式，例如 ${AUDIT_CUTOFF_TIME}`);
    }
  }
  config.projectRoot = dataRoot;
  config.paths = {
    reports: path.join(dataRoot, "reports"),
    errors: path.join(dataRoot, "reports", "error"),
    dailyReports: path.join(dataRoot, "reports", "daily_reports"),
    data: path.join(dataRoot, "data"),
    state: path.join(dataRoot, "state", "current_tracking.json"),
    downloads: path.join(dataRoot, "downloads"),
    profile: path.join(dataRoot, "private", "browser-profile"),
    lock: path.join(dataRoot, "run", "monitor.lock"),
    lastResult: path.join(dataRoot, "run", "last-result.json"),
  };
  config.runtime = process.env.JY_ALARM_RUNTIME || config.runtime || 'desktop';
  config.credentials = await loadCredentials(dataRoot, config.runtime);
  return config;
}

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { atomicWriteJson, chunk, nonEmpty, parsePlatformDateTime, readJson } from "./utils.mjs";
import { createHash } from 'node:crypto';
import { captureHeartbeatQuery, readHeartbeatSource } from './heartbeat-source.mjs';
import { checkpointPath, evidenceSummary, hydrateEvidence } from './evidence-store.mjs';
import { heartbeatRecord } from "./evidence.mjs";
import { mapConcurrent } from './concurrency.mjs';
import { collectHeartbeatHistory } from './heartbeat-history.mjs';
import { readPrivate, savePrivate } from './private-store.mjs';
import { beijingText, shiftDay } from './calendar.mjs';
import { validVoltage } from './audit-rules.mjs';

const ALLOWED_PATH_PREFIXES = ["/Reports/BatteryAlarmRecord", "/Reports/BatteryInfo", "/Home/Index", "/Login"];

const LOGIN_INPUTS = 'input[placeholder="账号"], input[name="username"], #username';
const sessionExpired = () => Object.assign(new Error('并发采集会话已失效，保留进度后由主流程重新登录'), { code: 'SESSION_EXPIRED' });

export async function waitForDetailIdentity(frame, sn, timeoutMs) {
  const identity = frame.getByText(sn, { exact: true }).filter({ visible: true }).first();
  const login = frame.locator(LOGIN_INPUTS).filter({ visible: true }).first();
  // A redirected detail frame displays a login form instead of the SN. Detect
  // either outcome with one waiter, without leaving losing timeout promises.
  await identity.or(login).first().waitFor({ state: 'visible', timeout: timeoutMs });
  if (/\/Login(?:[/?#]|$)/i.test(frame.url()) || await login.isVisible()) throw sessionExpired();
  await identity.waitFor({ state: 'visible', timeout: timeoutMs });
}

export function heartbeatDateTitle(reportDate, timezone = 'Asia/Shanghai', now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (reportDate === today) return '今天';
  if (reportDate === yesterday.toISOString().slice(0, 10)) return '昨天';
  throw new Error(`心跳日期 ${reportDate} 超出今天/昨天可核查范围，停止以免读取错误日期`);
}

export async function openHeartbeatTab(frame, timeoutMs, signal) {
  return openDetailTab(frame, '心跳记录', frame.locator('#btnRefreshHeartbeat'), timeoutMs, signal);
}

export async function openDetailTab(frame, title, ready, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  const tab=frame.getByText(title, { exact: true }).filter({visible:true}).first();
  const remaining=()=>Math.max(1,deadline-Date.now());
  const selected=async()=>await tab.count()>0 && await tab.evaluate(el=>
    !!el.closest('li')?.classList.contains('layui-this') || el.classList.contains('layui-this'),undefined,{timeout:remaining()});
  // The tab can be visible before the platform attaches its click handler.
  // Retry only this read-only tab activation and verify its resulting panel.
  for(let attempt=0;attempt<Math.max(12,Math.ceil(timeoutMs/750)) && Date.now()<deadline;attempt++) {
    signal?.throwIfAborted();
    if (await ready.isVisible()) return;
    try {
      // A selected tab has already accepted activation. Repeated clicks can
      // restart its asynchronous display work; wait for the actual panel.
      if(!await selected())await tab.click({ timeout: Math.min(5000,remaining()) });
      // A late page initializer can reset the selection. Poll readiness so
      // the next pass can reactivate a reset tab, without re-clicking one
      // that remains selected while its content is loading.
      await ready.waitFor({ state: "visible", timeout: Math.min(750,remaining()) });
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name !== "TimeoutError") throw error;
    }
  }
  throw Object.assign(new Error(`${title}标签页等待超时：总等待上限${timeoutMs/1000}秒，所需内容仍不可见`),
    {name:'TimeoutError',code:'DETAIL_TAB_TIMEOUT'});
}

export async function refreshCellPayload(frame, sn, timeoutMs) {
  const page = frame.page(), requests = new Set();
  const onRequest = request => {
    const url = new URL(request.url());
    if (request.frame() === frame && url.origin === new URL(frame.url()).origin &&
        url.pathname === '/Reports/BatteryChipInfo/Source' &&
        [...new URLSearchParams(request.postData() ?? '').values()].includes(sn)) requests.add(request);
  };
  page.on('request', onRequest);
  try {
    const responsePromise = page.waitForResponse(r => requests.has(r.request()), { timeout: timeoutMs });
    const [response] = await Promise.all([responsePromise, frame.locator('#btnRefreshChionInfo').click({ timeout: timeoutMs })]);
    const status = response.status();
    const payload = await response.json().catch(() => { throw new Error(`电芯详情读取失败：HTTP ${status}，响应不是JSON`); });
    if (!response.ok() || payload?.Success === false) {
      const message = String(payload?.Message || payload?.Msg || payload?.message || payload?.Status || '平台未提供原因').replace(/[\r\n\t]+/g, ' ').slice(0, 200);
      throw new Error(`电芯详情读取失败：HTTP ${status}，Success=${payload?.Success}，${message}`);
    }
    if (!Array.isArray(payload?.Data?.Chips)) throw new Error(`电芯详情读取失败：HTTP ${status}，缺少Data.Chips数组`);
    return payload;
  } finally { page.off('request', onRequest); }
}

function ensureReadOnlyUrl(url, baseUrl) {
  const parsed = new URL(url, baseUrl);
  const base = new URL(baseUrl);
  if (parsed.origin !== base.origin || !ALLOWED_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))) {
    throw new Error(`安全检查拒绝访问非只读目标：${parsed.origin}${parsed.pathname}`);
  }
  return parsed.toString();
}

async function setInputValue(page, selector, value) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: "attached" });
  await locator.evaluate((element, nextValue) => {
    const prototype = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, nextValue);
    else element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function setDateRangeValues(page, startValue, endValue) {
  const startSelector = "#fastFilter_timeSpan1";
  const endSelector = "#fastFilter_timeSpan2";
  await page.locator(startSelector).waitFor({ state: "attached" });
  await page.locator(endSelector).waitFor({ state: "attached" });
  const values = await page.evaluate(({ startSelector, endSelector, startValue, endValue }) => {
    const startElement = document.querySelector(startSelector);
    const endElement = document.querySelector(endSelector);
    const write = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    };
    // LayDate 会在逐个 change 时联动修正另一个日期。两个值必须同步写入，
    // 查询按钮会通过 getFastWhere() 直接读取它们，无需触发 change。
    write(startElement, startValue);
    write(endElement, endValue);
    return { start: startElement.value, end: endElement.value };
  }, { startSelector, endSelector, startValue, endValue });
  if (values.start !== startValue || values.end !== endValue) {
    throw new Error(`日期控件写入失败：${values.start} ~ ${values.end}`);
  }
}

function submittedDateRange(request) {
  const parameters = new URLSearchParams(request.postData() ?? "");
  return String(parameters.get("fastItems") ?? "").split(";", 1)[0].trim();
}

async function setCheckbox(page, title, expected) {
  const input = page.locator(`input[type="checkbox"][title="${title}"]`).first();
  await input.waitFor({ state: "attached" });
  if (await input.isChecked() !== expected) {
    const styled = page.locator(`input[type="checkbox"][title="${title}"] + .layui-form-checkbox`).first();
    if (await styled.count()) await styled.click();
    else await input.evaluate((element) => element.click());
  }
  if (await input.isChecked() !== expected) throw new Error(`筛选项“${title}”未能设置为${expected ? "勾选" : "取消"}`);
}

export async function waitForTableQuery(page, timeoutMs) {
  await page.waitForFunction(() => {
    const visible = element => element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const loading = [...document.querySelectorAll(".layui-layer-loading, .layui-table-init")].some(visible);
    const views = [...document.querySelectorAll('.layui-table-view')].filter(visible);
    return !loading && views.some(view =>
      [...view.querySelectorAll('.layui-laypage-count')].some(visible) ||
      [...view.querySelectorAll('.layui-none')].some(e => visible(e) && e.textContent.includes('无数据')));
  }, null, { timeout: timeoutMs });
}

async function triggerTableAction(page, action, timeoutMs) {
  await page.evaluate(() => {
    window.__jyTableChanged = false;
    window.__jyTableObserver?.disconnect();
    window.__jyTableObserver = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return target?.closest?.(".layui-table-view, .layui-laypage") || [...mutation.addedNodes].some((node) => node instanceof Element && node.matches?.(".layui-table-view, .layui-table-view *, .layui-laypage, .layui-laypage *"));
      })) window.__jyTableChanged = true;
    });
    window.__jyTableObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  try {
    await action();
    await page.waitForFunction(() => window.__jyTableChanged === true, null, { timeout: timeoutMs });
    await waitForTableQuery(page, timeoutMs);
  } finally {
    await page.evaluate(() => window.__jyTableObserver?.disconnect()).catch(() => {});
  }
}

export async function waitForHeartbeatPage(frame, pageNumber, timeoutMs, payload) {
  await frame.waitForFunction(({ expectedPage, responseIds, responseCount }) => {
    const visible = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const view = [...document.querySelectorAll('.layui-table-view')].find(visible);
    if (!view || [...view.querySelectorAll('.layui-table-init')].some(visible)) return false;
    const totalText = view.querySelector('.layui-laypage-count')?.textContent ?? '';
    const totalMatch = totalText.match(/共\s*([\d,]+)\s*条/);
    if (!totalMatch) return (responseCount === undefined || responseCount === 0) && !![...view.querySelectorAll('.layui-none')].find(e => visible(e) && e.textContent.includes('无数据'));
    const total = Number(totalMatch[1].replaceAll(',', ''));
    if (responseCount !== undefined && total !== responseCount) return false;
    const size = Number(view.querySelector('.layui-laypage-limits select')?.value);
    const current = Number(view.querySelector('.layui-laypage-curr')?.textContent.trim());
    if (current !== expectedPage || !size) return false;
    const rows = [...view.querySelectorAll('.layui-table-main tbody tr')].filter(tr => tr.querySelector('td[data-field]'));
    const expectedRows = Math.max(0, Math.min(size, total - (expectedPage - 1) * size));
    if (rows.length !== expectedRows) return false;
    // Layui can update pagination before replacing the old tbody. Page labels
    // and row numbers alone do not identify the response that was rendered.
    if (responseIds && (rows.length !== responseIds.length || rows.some((tr, i) =>
      tr.querySelector('td[data-field="BatteryHeartbeatId"]')?.textContent.trim() !== responseIds[i]))) return false;
    const indexCell = rows[0]?.querySelector('td[data-field="LAY_NUM"]');
    return !indexCell || Number(indexCell.textContent.trim()) === (expectedPage - 1) * size + 1;
  }, { expectedPage: pageNumber, responseIds: payload?.data.map(row => String(row.BatteryHeartbeatId)), responseCount: payload?.count }, { timeout: timeoutMs });
}

export async function queryHeartbeatPage(frame, { pageNumber, pageSize, reportDate }, action, timeoutMs) {
  const page = frame.page(), requests = new Set();
  const batteryId = new URL(frame.url()).searchParams.get('a');
  const onRequest = request => {
    const url = new URL(request.url());
    const params = new URLSearchParams(request.postData() ?? '');
    if (request.frame() === frame && url.origin === new URL(frame.url()).origin &&
        url.pathname === '/Reports/BatteryHeartbeat/Source' && params.get('dataId') === batteryId &&
        params.get('fastItems')?.split(';')[0].trim() === `${reportDate} ~ ${reportDate}` &&
        Number(params.get('page')) === pageNumber && Number(params.get('limit')) === pageSize) requests.add(request);
  };
  page.on('request', onRequest);
  try {
    const responsePromise = page.waitForResponse(r => requests.has(r.request()), { timeout: timeoutMs });
    const [response] = await Promise.all([responsePromise, action()]);
    const payload = await response.json();
    // This platform uses code=1,msg=无数据 for a successful empty query.
    // Other nonzero codes must remain failures, even with an empty array.
    const emptyResult = Number(payload?.code) === 1 && payload?.msg === '无数据' && payload?.count === 0 && Array.isArray(payload?.data) && payload.data.length === 0;
    if (!response.ok() || (Number(payload?.code) !== 0 && !emptyResult) || !Array.isArray(payload?.data) ||
        !Number.isInteger(payload.count) || payload.count < 0 ||
        payload.data.some(row => row.BatteryHeartbeatId === undefined || row.BatteryHeartbeatId === null)) {
      throw new Error(`心跳查询响应无效：HTTP ${response.status()}`);
    }
    await waitForHeartbeatPage(frame, pageNumber, timeoutMs, payload);
    return payload;
  } finally { page.off('request', onRequest); }
}

async function visibleText(locator) {
  return String(await locator.textContent() ?? "").trim();
}

export class JYPlatform {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.now = () => new Date();
  }

  async open() {
    this.config.signal?.throwIfAborted();
    await fs.mkdir(this.config.paths.profile, { recursive: true });
    const browserOptions = {
      ...(process.env.JY_BROWSER_EXECUTABLE ? { executablePath: process.env.JY_BROWSER_EXECUTABLE } : {}),
      headless: this.config.headless,
      acceptDownloads: true,
      locale: "zh-CN",
      timezoneId: this.config.timezone,
      viewport: { width: 1440, height: 1000 },
    };
    if (this.config.auditVersion === 2) {
      this.browser = await chromium.launch({headless:this.config.headless,...(process.env.JY_BROWSER_EXECUTABLE?{executablePath:process.env.JY_BROWSER_EXECUTABLE}:{})});
      const storageState = this.config.runtime === 'github' ? null : await readPrivate(path.join(this.config.projectRoot,'private/session.dpapi'));
      this.context = await this.browser.newContext({acceptDownloads:true,locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1440,height:1000},...(storageState?{storageState}:{})});
    } else this.context = await chromium.launchPersistentContext(this.config.paths.profile, browserOptions);
    this.context.setDefaultTimeout(30000);
    this.config.signal?.addEventListener('abort', () => { this.context?.close().catch(() => {}); }, { once: true });
    this.config.signal?.throwIfAborted();
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.rootPage = this.page;
    this.rootPage.on("pageerror", error => this.logger.warn(`平台网页脚本异常：${String(error.message).split("\n")[0]}`));
    return this;
  }

  async close() {
    if (this.config.auditVersion === 2 && this.config.runtime !== 'github' && this.context) {
      try { await savePrivate(path.join(this.config.projectRoot,'private/session.dpapi'),await this.context.storageState()); }
      catch { this.logger.warn('会话未能加密保存，下次将使用本机凭据重新登录'); }
    }
    await this.context?.close();
    await this.browser?.close();
  }

  async ensureLogin(targetPath = this.config.alarmPath) {
    const target = ensureReadOnlyUrl(targetPath, this.config.baseUrl);
    await this.page.goto(target, { waitUntil: "domcontentloaded" });
    const usernameInput = this.page.locator('input[placeholder="账号"], input[name="username"], #username').first();
    const needsLogin = /\/Login/i.test(this.page.url()) || await usernameInput.isVisible().catch(() => false);
    if (needsLogin) {
      if (!this.config.credentials?.username || !this.config.credentials?.password) throw Object.assign(new Error('请在任务与设置中配置本机登录凭据'), {code:'AUTH_REQUIRED'});
      if (this.isWorker) { if(this.sessionState)this.sessionState.expired=true; throw sessionExpired(); }
      this.logger.info("登录状态已失效，正在使用受限凭据文件重新登录。" );
      await usernameInput.fill(this.config.credentials.username);
      const passwordInput = this.page.locator('input[placeholder="密码"], input[type="password"], #password').first();
      await passwordInput.fill(this.config.credentials.password);
      const loginButton = this.page.getByRole("button", { name: /^登录$/ }).first();
      await loginButton.click();
      const loginCompleted = await this.page.waitForFunction(() => {
        const input = document.querySelector('input[placeholder="账号"], input[name="username"], #username');
        const visible = input && input.getClientRects().length > 0 && getComputedStyle(input).visibility !== "hidden";
        return !/\/Login/i.test(location.pathname) && !visible;
      }, null, { timeout: this.config.navigationTimeoutMs }).then(() => true).catch(() => false);
      if (!loginCompleted) {
        const pageMessage = await this.page.locator(".layui-layer-content, .validation-summary-errors, .login-error, [role=alert]")
          .evaluateAll((elements) => elements
            .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden")
            .map((element) => element.textContent?.trim() ?? "")
            .find(Boolean)?.slice(0, 200) ?? "")
          .catch(() => "");
        const detail = pageMessage ? `；页面提示：${pageMessage}` : "";
        throw Object.assign(new Error('自动登录被拒绝或需要额外验证；请在任务与设置中处理登录，已停止重试。'), {code:'AUTH_REQUIRED'});
      }
      await this.page.goto(target, { waitUntil: "domcontentloaded" });
    }
    await this.page.reload({ waitUntil: "domcontentloaded" });
    if (/\/Login/i.test(this.page.url())) throw sessionExpired();
  }

  async mapAlarmQueries(tasks, read) {
    if(!tasks.length)return [];
    this.config.signal?.throwIfAborted();
    // open() creates a new context, not an authenticated session. A cached
    // export can skip the login that used to happen before recovery queries.
    await this.ensureLogin(this.config.alarmPath);
    this.sessionState={expired:false};
    const workers=new Map();
    try {
      return await mapConcurrent(tasks,Math.min(this.config.heartbeatConcurrency ?? 3,3),async(task,index,lane)=>{
        this.config.signal?.throwIfAborted();
        if(this.sessionState.expired)throw sessionExpired();
        let worker=workers.get(lane);
        if(!worker) {
          worker=new JYPlatform(this.config,this.logger);
          worker.context=this.context;worker.isWorker=true;worker.sessionState=this.sessionState;
          worker.page=worker.rootPage=await this.context.newPage();workers.set(lane,worker);
        }
        try {return await read(worker,task,index);}
        catch(error) {if(error.code==='SESSION_EXPIRED')this.sessionState.expired=true;throw error;}
      },{signal:this.config.signal});
    } finally {
      this.downloadFiles ??= new Set();
      for(const worker of workers.values())for(const file of worker.downloadFiles ?? [])this.downloadFiles.add(file);
      await Promise.allSettled([...workers.values()].map(worker=>worker.rootPage.close()));
    }
  }

  async queryAlarmAndDownload(window, { bmsNumbers = [] } = {}) {
    this.config.signal?.throwIfAborted();
    await this.ensureLogin(this.config.alarmPath);
    await this.page.locator("#btnRefresh").waitFor({ state: "visible" });
    // 页面会在 DOMContentLoaded 之后异步初始化 LayDate 和首轮表格；若过早写入，
    // 首轮初始化会把日期悄悄覆盖回当天。
    await waitForTableQuery(this.page, this.config.queryTimeoutMs);
    await setInputValue(this.page, "#fastFilter_manufacture", this.config.vendor);
    await setInputValue(this.page, "#fastFilter", bmsNumbers.join(","));
    await setCheckbox(this.page, "提示", false);
    await setCheckbox(this.page, "保护", true);
    await setCheckbox(this.page, "同一设备相同报警仅显示最新一条", false);
    await setDateRangeValues(this.page, window.startDate, window.endDate);
    const expectedDateRange = `${window.startDate} ~ ${window.endDate}`;
    const requestPromise = this.page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST" && url.pathname === `${this.config.alarmPath}/TableSource`;
    }, { timeout: this.config.queryTimeoutMs });
    await triggerTableAction(this.page, () => this.page.locator("#btnRefresh").click(), this.config.queryTimeoutMs);
    const queryRequest = await requestPromise;
    const actualDateRange = submittedDateRange(queryRequest);
    if (actualDateRange !== expectedDateRange) {
      throw new Error(`后台查询日期复核失败：实际=${actualDateRange || "空"}，预期=${expectedDateRange}`);
    }

    const verified = await this.verifyAlarmFilters(window, bmsNumbers);
    if (!verified.ok) throw new Error(`筛选条件复核失败：${verified.errors.join("；")}`);
    const countText = await visibleText(this.page.locator(".layui-laypage-count").last());
    const resultCount = Number(countText.match(/([\d,]+)/)?.[1]?.replace(/,/g, "") ?? NaN);
    if (!Number.isFinite(resultCount)) throw new Error(`无法读取报警结果数量：${countText}`);
    if (resultCount > this.config.maxDownloadRows) throw Object.assign(new Error(`筛选后共有 ${resultCount} 条，超过单次导出上限 ${this.config.maxDownloadRows}`), { code: 'EXPORT_LIMIT' });
    if (resultCount >= this.config.largeResultThreshold) {
      this.logger.warn(`筛选后共有 ${resultCount} 条，已按防呆规则再次复核全部筛选条件。`);
      const secondCheck = await this.verifyAlarmFilters(window, bmsNumbers);
      if (!secondCheck.ok) throw new Error(`大数据量二次复核失败：${secondCheck.errors.join("；")}`);
    }

    await fs.mkdir(this.config.paths.downloads, { recursive: true });
    const capture = await this.page.evaluate(() => {
      window.__jyCapturedDownloadUrl = "";
      window.__jyOriginalOpen = window.open;
      window.open = (url) => {
        window.__jyCapturedDownloadUrl = String(url ?? "");
        return null;
      };
      return true;
    });
    if (!capture) throw new Error("无法建立只读导出捕获器");
    try {
      await this.page.locator("#btnDownload").click();
      await this.page.waitForFunction(() => Boolean(window.__jyCapturedDownloadUrl), null, { timeout: 15000 });
    } finally {
      await this.page.evaluate(() => {
        if (window.__jyOriginalOpen) window.open = window.__jyOriginalOpen;
        delete window.__jyOriginalOpen;
      }).catch(() => {});
    }
    const relativeUrl = await this.page.evaluate(() => window.__jyCapturedDownloadUrl);
    const downloadUrl = ensureReadOnlyUrl(relativeUrl, this.config.baseUrl);
    if (!new URL(downloadUrl).pathname.startsWith("/Reports/BatteryAlarmRecord/DownloadData")) {
      throw new Error("导出按钮产生了非预期地址，已停止");
    }
    const response = await this.context.request.get(downloadUrl);
    let body, contentType;
    try {
      if (!response.ok()) throw new Error(`报警导出失败：HTTP ${response.status()}`);
      contentType=response.headers()['content-type'] || '未知';
      body = await response.body();
    } finally { await response.dispose?.(); }
    if (body.length < 1000) throw new Error(`报警导出文件异常小（${body.length} 字节）`);
    if(body.readUInt32LE(0)!==0x04034b50)throw new Error(`报警导出未返回XLSX：Content-Type=${contentType}，页面${resultCount}条，文件${body.length}字节，文件头${body.subarray(0,4).toString('hex')}；未将该响应当成报警证据`);
    const downloadPath = path.join(this.config.paths.downloads, `${window.reportDate}_alarm.xlsx`);
    await fs.writeFile(downloadPath, body);
    this.downloadFiles ??= new Set();this.downloadFiles.add(downloadPath);
    return { buffer: body, resultCount, downloadPath };
  }

  async verifyAlarmFilters(window, bmsNumbers = []) {
    const values = await this.page.evaluate(({ startSelector, endSelector, vendorSelector }) => {
      const read = (selector) => document.querySelector(selector)?.value ?? "";
      const checked = (title) => Boolean(document.querySelector(`input[type="checkbox"][title="${title}"]`)?.checked);
      return {
        start: read(startSelector),
        end: read(endSelector),
        vendor: read(vendorSelector),
        sns: read("#fastFilter"),
        tip: checked("提示"),
        protection: checked("保护"),
        latestOnly: checked("同一设备相同报警仅显示最新一条"),
      };
    }, { startSelector: "#fastFilter_timeSpan1", endSelector: "#fastFilter_timeSpan2", vendorSelector: "#fastFilter_manufacture" });
    const errors = [];
    if (!values.start.includes(window.startDate)) errors.push(`开始日期=${values.start}`);
    if (!values.end.includes(window.endDate)) errors.push(`结束日期=${values.end}`);
    if (values.vendor.trim().toUpperCase() !== this.config.vendor.toUpperCase()) errors.push(`BMS厂商=${values.vendor}`);
    if (values.tip) errors.push("提示仍被勾选");
    if (!values.protection) errors.push("保护未勾选");
    if (values.latestOnly) errors.push("同设备同报警仅最新一条被启用");
    if (values.sns !== bmsNumbers.join(",")) errors.push("SN筛选未正确提交");
    return { ok: errors.length === 0, errors, values };
  }

  async fetchBatterySnapshots(bmsNumbers, { evidenceSNs = [], reportDate, endText, cachedEvidence, cellSNs, progressTotal, progressCompleted, progressFailed } = {}) {
    this.config.signal?.throwIfAborted();
    if (!this.isWorker) return this.fetchBatterySnapshotsConcurrent(bmsNumbers, { evidenceSNs, reportDate, endText, cachedEvidence, cellSNs, progressTotal, progressCompleted, progressFailed });
    this.cachedAuditEvidence = cachedEvidence;
    this.cellSNs = new Set(cellSNs ?? evidenceSNs);
    const unique = [...new Set(bmsNumbers.filter(nonEmpty))];
    if (!unique.length) return new Map();
    // BatteryView calls parent.getDetailViewNavigatorSource(). Opening the
    // standalone BatteryInfo URL leaves its heartbeat pane blank. Use the real
    // report-center hierarchy, as verified in the platform UI.
    this.page = this.rootPage ?? this.page;
    this.logger.progress?.({ detail_stage: '登录并打开电池查询' });
    await this.ensureLogin("/Home/Index#top=reportCenter");
    await this.page.getByText("报表中心", { exact: true }).click();
    const centerElement = this.page.locator("#iframereportCenter");
    await centerElement.waitFor({ state: "visible" });
    this.detailHost = await (await centerElement.elementHandle()).contentFrame();
    await this.detailHost.getByText("电池查询", { exact: true }).click();
    const batteryElement = this.detailHost.locator("#iframeBatteryInfo");
    await batteryElement.waitFor({ state: "visible" });
    this.page = await (await batteryElement.elementHandle()).contentFrame();
    await this.page.locator("#btnRefresh").waitFor({ state: "visible" });
    // 电池页也会在 DOMContentLoaded 后异步执行一次默认全量查询。必须等待它
    // 完成后再写入 BMS 批次，否则首次自动运行时筛选值可能被页面初始化覆盖。
    await waitForTableQuery(this.page, this.config.queryTimeoutMs);
    const snapshots = new Map();
    this.lastSnapshots = snapshots;
    this.heartbeatEvidence = new Map();
    const evidenceSet = new Set(evidenceSNs);
    this.pageResetRequested = false;
    let consecutiveFailures = 0;
    let failed = 0;
    const heartbeatStartedAt = Date.now();
    // 电池查询默认每页 50 行，而该平台在无界面模式下分页按钮可能不推进。
    // 将批次硬限制为 45，使每批都能在首页完整读取，同时保留分页校验作防线。
    const safeBatchSize = Math.min(Math.max(Number(this.config.batteryBatchSize) || 45, 1), 45);
    for (const batch of chunk(unique, safeBatchSize)) {
      this.config.signal?.throwIfAborted();
      this.logger.progress?.({ detail_stage: '查询本批电池摘要' });
      await setInputValue(this.page, "#fastFiler", batch.join(","));
      if (await this.page.locator("#fastFilter_BMSCJ").count()) await setInputValue(this.page, "#fastFilter_BMSCJ", this.config.vendor);
      if (await this.page.locator('input[type="checkbox"][title="含半成品"]').count()) await setCheckbox(this.page, "含半成品", true);
      if (await this.page.locator('input[type="checkbox"][title="含在途设备"]').count()) await setCheckbox(this.page, "含在途设备", true);
      if (await this.page.locator('input[type="checkbox"][title="仅在库设备"]').count()) await setCheckbox(this.page, "仅在库设备", false);
      await triggerTableAction(this.page, () => this.page.locator("#btnRefresh").click(), this.config.queryTimeoutMs);
      // Each batch fits the platform's default 50 rows. Resizing can race a
      // late response and leave the dropdown and rendered rows inconsistent.
      const countText = await visibleText(this.page.locator(".layui-table-view:visible .layui-laypage-count:visible").first());
      const tableTotal = Number(countText.match(/([\d,]+)/)?.[1]?.replace(/,/g, "") ?? 0);
      const rowMap = new Map();
      const pageSignatures = new Set();
      for (let pageNumber = 1; pageNumber <= 30; pageNumber += 1) {
        const pageRows = await this.readBatteryTable();
        const pageSignature = JSON.stringify(pageRows);
        if (pageSignatures.has(pageSignature)) throw new Error(`电池摘要分页第 ${pageNumber} 页未发生变化，已停止，避免重复读取`);
        pageSignatures.add(pageSignature);
        for (const row of pageRows) rowMap.set(JSON.stringify(row), row);
        if (!tableTotal || rowMap.size >= tableTotal) break;
        const next = this.page.locator(".layui-table-view:visible .layui-laypage-next:not(.layui-disabled):visible").first();
        if (!await next.count()) break;
        await triggerTableAction(this.page, () => next.click(), this.config.queryTimeoutMs);
        if (pageNumber === 30) throw new Error("电池摘要分页超过 30 页，已停止长时间循环");
      }
      const rows = [...rowMap.values()];
      if (tableTotal && rows.length < tableTotal) {
        throw new Error(`电池摘要页面共有 ${tableTotal} 条，但分页仅完整读取 ${rows.length} 条；本周期状态核验不完整`);
      }
      this.logger.info(`心跳批次：查询 ${batch.length} 个 BMS，页面共 ${tableTotal || "未知"} 条，读取 ${rows.length} 行电池摘要。`);
      const batchSet = new Set(batch);
      for (const row of rows) {
        const bms = String(row["电池组编号"] ?? "").trim();
        const heartbeatTime = String(row["采集时间"] ?? "").trim();
        const batteryStatus = String(row["电池状态"] ?? "").trim();
        if (!Object.hasOwn(row, "电池组编号") || !Object.hasOwn(row, "采集时间") || !Object.hasOwn(row, "电池状态")) {
          throw new Error("电池摘要缺少SN、采集时间或电池状态字段；禁止猜测其他日期/状态替代");
        }
        if (!bms || !batchSet.has(bms)) throw new Error("电池摘要包含未请求的SN，查询可能尚未刷新；停止以免串设备");
        const existing = snapshots.get(bms);
        const nextTime = parsePlatformDateTime(heartbeatTime)?.getTime() ?? 0;
        const priorTime = parsePlatformDateTime(existing?.heartbeatTime)?.getTime() ?? 0;
        if (!existing || nextTime >= priorTime) snapshots.set(bms, { heartbeatTime, batteryStatus, sleeping: row["是否休眠"] ?? "" });
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
          evidence = { sn, reportDate, complete: false, records: [], error: String(error.message), errorCode:error.code };
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
          this.pageResetRequested = this.config.auditPolicy === 'current_day_pending';
          this.logger.warn(this.pageResetRequested
            ? '当前页面连续3个SN失败，已失败对象保留待确认；更换页面后继续尚未读取的设备。'
            : '当前页面连续3个SN失败，保留已采集证据，剩余设备交由新页面补查。');
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
    this.page = this.rootPage ?? this.page;
    await this.ensureLogin('/Home/Index#top=reportCenter');
    const batches = chunk(unique, Math.min(Math.max(Number(this.config.heartbeatBatchSize ?? this.config.batteryBatchSize) || 45, 1), 45, Math.max(1, Math.ceil(unique.length / (this.config.heartbeatConcurrency ?? 3)))));
    const workers = new Map(), active = new Map(), started = Date.now();
    const evidenceSet = new Set(options.evidenceSNs), base = options.progressCompleted ?? 0;
    const total = options.progressTotal ?? evidenceSet.size;
    this.sessionState = { expired: false };
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
        active.set(lane, { sn: repair ? batch[0] : `批次${index + 1}（${batch.length}块）`, stage: '创建查询页面' });
        publishProgress();
        let worker = workers.get(lane);
        if (!worker) {
          worker = new JYPlatform(this.config, {
            info: message => this.logger.info(`[并发 ${lane + 1}] ${message}`),
            warn: message => this.logger.warn(`[并发 ${lane + 1}] ${message}`),
            progress: update => {
              if (update.current_sn) active.set(lane, { sn: update.current_sn, stage: update.detail_stage || '读取心跳' });
              else if (update.detail_stage && active.has(lane)) active.get(lane).stage = update.detail_stage;
              for (const [sn, evidence] of worker.heartbeatEvidence ?? []) this.heartbeatEvidence.set(sn, evidence);
              publishProgress();
            },
          });
          worker.isWorker = true; worker.context = this.context;
          worker.sessionState = this.sessionState;
          worker.page = worker.rootPage = await this.context.newPage(); workers.set(lane, worker);
        }
        let remaining=[];
        const neededEvidence = batch.filter(sn => evidenceSet.has(sn) && (!repair || !this.heartbeatEvidence.get(sn)?.complete));
        try {
          if (repair) this.logger.info(`新页面并发补查 ${index + 1}：${batch.join('、')}`);
          const result = await worker.fetchBatterySnapshots(batch, { ...options, evidenceSNs: neededEvidence });
          for (const [sn, snapshot] of result) snapshots.set(sn, snapshot);
          if(this.config.auditPolicy==='current_day_pending' && worker.pageResetRequested && !this.sessionState.expired) {
            remaining=neededEvidence.filter(sn=>!worker.heartbeatEvidence?.has(sn));
            // Require forward progress before replacing a broken page.
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
          this.logger.warn(`批次 ${index + 1} 页面异常，${this.config.auditPolicy==='current_day_pending'?'归类待确认':'保存进度并安排补查'}：${String(error.message).split('\n')[0]}`);
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
          await worker.rootPage.close().catch(() => {});
          workers.delete(lane);
          publishProgress();
        }
        if(remaining.length)await runBatch(remaining,index,lane);
    };
    try {
      publishProgress();
      await mapConcurrent(batches, this.config.heartbeatConcurrency ?? 3, runBatch, { signal: this.config.signal });
      // Bounded concurrent repair, with a fresh page per SN. Successfully
      // verified devices never enter the repair queue. Stop issuing new work
      // after three failures; already in-flight lanes finish and checkpoint.
      const pending = this.config.auditPolicy==='current_day_pending'?[]:unique.filter(sn => !snapshots.has(sn) || (evidenceSet.has(sn) && !this.heartbeatEvidence.get(sn)?.complete));
      if(pending.length) {
        phase = '并发补查'; publishProgress();
        await mapConcurrent(pending, this.config.heartbeatConcurrency ?? 3, (sn, index, lane) => runBatch([sn], index, lane, true), { signal: this.config.signal });
      }
      if (repairFailures >= 3) this.logger.warn('新页面补查连续3次失败，停止发起新补查，保留明确标记的部分报告。');
      for (const sn of evidenceSet) {
        if (!this.heartbeatEvidence.has(sn)) this.heartbeatEvidence.set(sn, { sn, reportDate: options.reportDate, complete: false, attempted: false, records: [], error: this.sessionState.expired ? sessionExpired().message : '页面异常，本次未完成补查' });
      }
      publishProgress();
      const missing = unique.filter(sn => !snapshots.has(sn));
      if (missing.length) this.acquisitionWarnings.push(`电池摘要有 ${missing.length} 个SN未取得：${missing.join('、')}；缺失证据保留待核实。`);
      if(this.sessionState.expired && this.config.auditPolicy==='current_day_pending')throw sessionExpired();
      if (!snapshots.size && this.config.auditPolicy!=='current_day_pending') throw new Error('所有电池摘要均未取得，已保存采集进度，未覆盖滚动状态');
      return snapshots;
    } finally {
      await Promise.allSettled([...workers.values()].map(worker => worker.rootPage.close()));
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

  async readSourceDay(query, sn, reportDate, endText, progress) {
    try {
      const result = await readHeartbeatSource(this.context.request, query, { sn, reportDate, endText,
        pageSize: this.config.heartbeatSourcePageSize ?? 300, recordLimit: this.config.maxHeartbeatRecords ?? this.config.maxHeartbeatPages * 300,
        stableCutoff: this.config.heartbeatStableCutoff ?? false,
        timeoutMs: this.config.heartbeatRequestTimeoutMs ?? 20000, firstPageTimeoutMs: this.config.heartbeatFirstPageTimeoutMs ?? 60000, signal: this.config.signal, progress });
      this.logger.info(`SN ${sn} ${reportDate} 心跳接口读取${result.readCount}条，${result.metrics.requests}次请求，${(result.metrics.elapsedMs / 1000).toFixed(1)}秒。`);
      return result;
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED') { if (this.sessionState) this.sessionState.expired = true; this.heartbeatQueries?.clear(); }
      throw error;
    }
  }

  async fetchTodayHeartbeat(sn, reportDate, endText, { detailOnly = false } = {}) {
    this.config.signal?.throwIfAborted();
    const detailTimeout = Math.min(this.config.queryTimeoutMs, this.config.heartbeatTransport === 'source' ? this.config.heartbeatDetailTimeoutMs ?? 45000 : 60000);
    const step = name => { this.lastHeartbeatStep = name; this.logger.progress?.({ detail_stage: name }); };
    // Subsequent history days use the same verified device query; opening ten
    // identical detail panes adds no evidence and exposes ten more UI races.
    if (!detailOnly && this.config.heartbeatTransport === 'source' && this.heartbeatQueries?.has(sn)) {
      return { ...await this.readSourceDay(this.heartbeatQueries.get(sn), sn, reportDate, endText, step), detail: this.auditDetails?.get(sn) };
    }
    // Only use an SN visibly present in the current exact batch. Never advance
    // with the detail's next/previous buttons, which can retain stale tables.
    step("等待电池列表加载");
    await waitForTableQuery(this.page, Math.min(this.config.queryTimeoutMs, 15000));
    // Layui duplicates pinned columns over the main table. Click the topmost
    // pinned SN, not the covered copy underneath it. Never force a click.
    const fixedCell = this.page.locator(".layui-table-fixed-l:visible").getByText(sn, { exact: true }).first();
    const cell = await fixedCell.count() && await fixedCell.isVisible()
      ? fixedCell : this.page.locator(".layui-table-main").getByText(sn, { exact: true }).first();
    if (!await cell.count()) throw new Error("电池查询未返回该SN，不能读取其他设备代替");
    const host = this.detailHost ?? this.page;
    const iframe = host.locator('iframe[src*="/Reports/BatteryInfo/BatteryView"]').last();
    let frame;
    try {
      step("打开SN详情");
      await cell.dblclick({ timeout: 8000 });
      await iframe.waitFor({ state: "visible", timeout: 10000 });
      frame = await (await iframe.elementHandle()).contentFrame();
      // Third-party overview assets can delay even DOMContentLoaded. Gate on
      // the requested SN and actual heartbeat controls, not a page-wide event.
      // Query completion, date, row counts and pagination are verified below.
      step('核对详情SN');
      await waitForDetailIdentity(frame, sn, detailTimeout);
      let detail;
      if (this.config.auditVersion === 2) {
        this.auditDetails ??= new Map();
        if (!this.auditDetails.has(sn)) this.auditDetails.set(sn,await this.readAuditDetail(frame,sn,detailTimeout));
        detail=this.auditDetails.get(sn);
      }
      if(detailOnly)return {detail};
      step("打开今日心跳");
      await openHeartbeatTab(frame, detailTimeout, this.config.signal);
      if (this.config.heartbeatTransport === 'source') {
        step('捕获当前设备心跳查询');
        const query = await captureHeartbeatQuery(frame, () => frame.locator('#btnRefreshHeartbeat').click(), Math.min(detailTimeout, 10000));
        this.heartbeatQueries ??= new Map(); this.heartbeatQueries.set(sn, query);
        return { ...await this.readSourceDay(query, sn, reportDate, endText, step), ...(detail ? { detail } : {}) };
      }
      // Let the tab's initial automatic query finish before issuing our own.
      // Otherwise its late response can reset the page size during collection.
      await waitForTableQuery(frame, detailTimeout);
      let dateTitle;
      try { dateTitle = heartbeatDateTitle(reportDate, this.config.timezone, this.now()); }
      catch (error) { if (this.config.auditVersion !== 2) throw error; dateTitle = '更早'; }
      const today = frame.locator(`input[name="dateRange"][title="${dateTitle}"]`);
      await today.waitFor({ state: "attached" });
      if (!await today.isChecked()) await today.locator("+ .layui-form-radio").click();
      if (!await today.isChecked()) throw new Error(`心跳日期未选中${dateTitle}`);
      if (dateTitle === '更早') {
        await frame.evaluate(date=>{document.querySelector('#heartStartDate').value=date;document.querySelector('#heartEndDate').value=date;},reportDate);
        const range=await frame.evaluate(()=>[document.querySelector('#heartStartDate').value,document.querySelector('#heartEndDate').value]);
        if(range.some(d=>d!==reportDate))throw new Error('历史心跳日期控件未正确写入');
      }
      step("刷新今日心跳");
      const limits = frame.locator(".layui-table-view:visible .layui-laypage-limits select");
      let responsePage = await queryHeartbeatPage(frame, { pageNumber: 1, pageSize: await limits.count() ? Number(await limits.first().inputValue()) : 50, reportDate },
        () => frame.locator('#btnRefreshHeartbeat').click(), detailTimeout);
      if (this.heartbeatPageSize && await limits.count()) {
        const sizes = await limits.first().locator('option').evaluateAll(elements => elements.map(e => Number(e.value)));
        const size = Math.max(...sizes.filter(value => Number.isInteger(value) && value <= this.heartbeatPageSize));
        if (size > Number(await limits.first().inputValue())) {
          step('分页不稳定后切换较大分页');
          responsePage = await queryHeartbeatPage(frame, { pageNumber: 1, pageSize: size, reportDate }, () => limits.first().selectOption(String(size)), detailTimeout);
        }
      }
      const pageSize = await limits.count() ? Number(await limits.first().inputValue()) : 50;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 300) throw new Error('心跳分页大小异常');
      // Preserve the former maxHeartbeatPages * 300 record budget while using
      // the stable server default (normally 50); keep every page/count check.
      const recordLimit = this.config.maxHeartbeatPages * 300;
      const pageLimit = Math.ceil(recordLimit / pageSize);
      const records = [];
      const signatures = new Set();
      const recordIds = new Set();
      let expected;
      let rawCount = 0;
      for (let p = 1; p <= pageLimit; p++) {
        step(`读取心跳第${p}页`);
        const countLocator = frame.locator(".layui-table-view:visible .layui-laypage-count:visible").first();
        const countText = await countLocator.count() ? await countLocator.textContent() : "";
        const countMatch = String(countText).match(/共\s*([\d,]+)\s*条/);
        const emptyLocator = frame.locator(".layui-table-view:visible .layui-none:visible").first();
        const empty = await emptyLocator.count() ? await emptyLocator.textContent() : "";
        const count = countMatch ? Number(countMatch[1].replaceAll(",", "")) : /无数据/.test(empty) ? 0 : NaN;
        if (!Number.isFinite(count)) throw new Error("心跳列表总数未知");
        if (count > recordLimit) throw new Error('心跳记录超过采集上限，不能将部分记录当作完整结果');
        if (expected === undefined) expected = count;
        if (count !== expected) throw new Error(`心跳分页期间总数变化：${reportDate} 第${p}页，总数 ${expected} → ${count}，每页${pageSize}条，请重新查询`);
        // Read after checking the entire rendered ID sequence against this
        // exact request, then verify again to catch a late competing response.
        const rows = await this.readRenderedTable(frame);
        if (rows.length !== responsePage.data.length || rows.some((row, i) => row.BatteryHeartbeatId !== String(responsePage.data[i].BatteryHeartbeatId))) throw new Error('心跳页面被其他查询覆盖，请重新查询');
        if (rows.length && !["TCreateTime", "TMinVoltage", "TBatteryHeartbeatStatus"].every(key => Object.hasOwn(rows[0], key))) throw new Error("心跳关键列变更或缺失");
        const signature = JSON.stringify(rows);
        if (signatures.has(signature)) throw new Error("心跳分页未推进，不能重复计数");
        signatures.add(signature);
        rawCount += rows.length;
        for (const row of rows) {
          const id = row.BatteryHeartbeatId;
          if (id && recordIds.has(id)) throw new Error("心跳分页出现重复记录ID，不能保证完整性");
          if (id) recordIds.add(id);
          const record = heartbeatRecord(row);
          if (!parsePlatformDateTime(record.time) || !record.time.startsWith(reportDate)) throw new Error("心跳SN/日期范围不匹配，可能查询过期或任务跨日");
          if (!endText || record.time <= endText) records.push(record);
        }
        if (rawCount === expected) {
          // Recheck the actual displayed identity after the whole read.
          await frame.getByText(sn, { exact: true }).filter({ visible: true }).first().waitFor({ state: "visible" });
          return { sn, reportDate, complete: true, tableCount: expected, readCount: rawCount, records, ...(detail?{detail}:{}) };
        }
        if (rawCount > expected || !rows.length) throw new Error("心跳行数与总数不一致");
        const next = frame.locator(".layui-table-view:visible .layui-laypage-next:not(.layui-disabled):visible").first();
        if (!await next.count()) throw new Error("心跳还有未读取记录但无下一页");
        responsePage = await queryHeartbeatPage(frame, { pageNumber: p + 1, pageSize, reportDate }, () => next.click(), detailTimeout);
      }
      throw new Error("心跳分页达到上限，不能将部分记录当作完整结果");
    } catch (error) {
      if(error.code==='SESSION_EXPIRED' && this.sessionState)this.sessionState.expired=true;
      if (this.config.projectRoot && frame) {
        const diagnostic = await frame.evaluate(() => ({
          readyState: document.readyState,
          tabs: [...document.querySelectorAll('li, a, button')].filter(e=>e.getClientRects().length && /^(基本信息|电芯信息|心跳记录)$/.test(e.textContent.trim())).map(e=>({tag:e.tagName,id:e.id,cls:e.className,text:e.textContent.trim()})),
          bmsLabels: [...document.querySelectorAll('.tdLabel')].filter(e=>/BMS/.test(e.textContent)).map(e=>({text:e.textContent.trim(),visible:!!e.getClientRects().length})),
          frames: [...document.querySelectorAll('iframe')].map(e => ({ src: e.getAttribute('src'), visible: !!e.getClientRects().length })),
          heartbeat: document.querySelector('#btnRefreshHeartbeat')?.parentElement?.outerHTML.slice(0, 4000),
          tables: [...document.querySelectorAll('.layui-table-view')].map(e => ({ visible: !!e.getClientRects().length, rows: e.querySelectorAll('.layui-table-main tbody tr').length })),
          markers: [...document.querySelectorAll('.layui-layer-loading, .layui-table-init, .layui-laypage-count, .layui-none')].map(e => ({ cls: e.className, visible: !!e.getClientRects().length, text: e.textContent.trim().slice(0, 200) })),
        })).catch(() => ({}));
        const directory = path.join(this.config.projectRoot, 'run', 'heartbeat-diagnostics');
        await fs.mkdir(directory, { recursive: true });
        const prefix = `${sn.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`;
        const file = path.join(directory, `${prefix}.json`);
        await fs.writeFile(file, JSON.stringify({ sn, reportDate, endText, stage: this.lastHeartbeatStep, error: String(error.message), ...diagnostic }, null, 2)).catch(() => {});
        await this.rootPage?.screenshot({ path: path.join(directory, `${prefix}.png`) }).catch(() => {});
      }
      throw error;
    } finally {
      const close = host.locator(".layui-layer-close:visible").last();
      if (await close.count()) await close.click();
      await iframe.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    }
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
          const retryable = error.code === 'HEARTBEAT_QUERY_NOT_SENT' || unstablePagination || /Timeout|超时|net::ERR_|电芯详情读取失败|基本信息SN与请求对象不一致|被其他查询覆盖/.test(message);
          if (!retryable || attempt === maxAttempts) throw error;
          // Reopen and discard the failed scan. A larger page reduces the
          // window for live inserts to shift offsets; all completeness checks
          // still apply, including on the final attempt.
          if (unstablePagination) this.heartbeatPageSize = 300;
          const reason = /总数变化/.test(message) ? '心跳分页期间总数变化' : unstablePagination ? '出现重复分页' : '页面响应不稳定';
          const retryAction = this.config.heartbeatTransport === 'source' && this.heartbeatQueries?.has(sn) ? '重新查询心跳接口' : `重新打开详情${unstablePagination ? '并尝试较大分页' : ''}`;
          this.logger.warn(`SN ${sn} ${reportDate} ${reason}，${retryAction}（重试${attempt}/${maxAttempts - 1}）；阶段：${this.lastHeartbeatStep ?? '未知'}；原因：${message.split('\n')[0]}`);
        }
      }
    } finally { this.heartbeatPageSize = previousSize; }
  }

  async readAuditDetail(frame, sn, timeoutMs = Math.min(this.config.queryTimeoutMs, 60000)) {
    const step = name => { this.lastHeartbeatStep = name; this.logger.progress?.({ detail_stage: name }); };
    step('打开基本信息');
    await openDetailTab(frame, '基本信息', frame.locator('.tdLabel').filter({hasText:/^BMS编号$/}).filter({visible:true}).first(), timeoutMs, this.config.signal);
    const fields=await frame.locator('.tdCell:visible').evaluateAll(cells=>Object.fromEntries(cells.map(c=>[c.querySelector('.tdLabel')?.textContent.trim(),c.querySelector('.tdValue')?.textContent.trim()])));
    if(fields['电池组编号']!==sn)throw new Error('基本信息SN与请求对象不一致');
    const customerFields=['客户','客户名称','所属客户'].filter(key=>fields[key]);
    const customers=new Set(customerFields.map(key=>fields[key]));
    const softwareVersionFields=['BMS软件版本号','BMS软件版本','软件版本号','软件版本','BMS版本'].filter(key=>fields[key]);
    const softwareVersions=new Set(softwareVersionFields.map(key=>fields[key]));
    const result={sn,bms:fields['BMS编号'] || '',model:fields['型号'] || '',
      bmsSoftwareVersion:softwareVersions.size===1?[...softwareVersions][0]:'',
      bmsSoftwareVersionSource:softwareVersions.size===1?softwareVersionFields.join('／'):'',
      bmsSoftwareVersionError:softwareVersions.size>1?'平台BMS软件版本字段不一致，需人工复核':'',
      customer:customers.size===1?[...customers][0]:'',customerSource:customers.size===1?customerFields.join('／'):'',
      customerError:customers.size>1?'平台客户字段不一致，需人工复核':customers.size===0?'平台客户字段为空或未提供':'',
      owner:fields['拥有者'] || '',detailVersion:2,site:fields['站点'] || '',url:frame.url(),collectedAt:beijingText(new Date()),cells:[],cellsComplete:false};
    const status = await frame.evaluate(() => {
      const indicator = document.querySelector('#IsOnline');
      // These are the platform's explicit online/offline colors, including
      // its live refresh attribute. Do not infer offline from data age alone.
      const color = indicator?.getAttribute('background-color') || indicator?.style.backgroundColor;
      return { online: ['#cec9c9', 'rgb(206, 201, 201)'].includes(color) ? false :
        ['#39dd2e', 'rgb(57, 221, 46)'].includes(color) ? true : null,
        lastDataTime: document.querySelector('#DataTime')?.textContent.trim() || null };
    });
    Object.assign(result, status);
    if (this.cellSNs && !this.cellSNs.has(sn)) return { ...result, cellsApplicable: false };
    if (status.online === false) {
      result.cellsError = `平台显示设备离线，无法读取实时逐节电压${status.lastDataTime ? `；最近采集 ${status.lastDataTime}` : ''}`;
      this.logger.warn(`SN ${sn} ${result.cellsError}；保留待复核标记，继续读取历史心跳。`);
      return result;
    }
    try {
      step('打开电芯信息');
      await openDetailTab(frame, '电芯信息', frame.locator('#btnRefreshChionInfo'), timeoutMs, this.config.signal);
      // This refresh can fail with a device command error while historical
      // heartbeats remain readable. Preserve basic identity and collect them.
      // The initial chart can interpolate min/max; never use it as evidence.
      step('刷新并读取电芯接口');
      const payload=await refreshCellPayload(frame,sn,timeoutMs);
      result.cells=payload.Data.Chips.map(c=>({index:c.ChipNo,voltage:c.Voltage!=='' && c.Voltage!==null && Number.isFinite(Number(c.Voltage))?Number(c.Voltage):null}));
      const expected=Number(/^(\d+)S/i.exec(fields['组合方式'] ?? '')?.[1]);
      result.cellsComplete=result.cells.length>0 && new Set(result.cells.map(c=>c.index)).size===result.cells.length && (!expected || result.cells.length===expected) && result.cells.every(c=>Number.isFinite(c.voltage));
      if (!result.cellsComplete) result.cellsError = '电芯电压数据缺失或不完整';
    } catch (error) {
      this.config.signal?.throwIfAborted();
      result.cellsError = String(error.message).split('\n')[0];
    }
    if (result.cellsError) this.logger.warn(`SN ${sn} 电芯证据待复核：${result.cellsError}；保留基本信息，继续读取历史心跳。`);
    return result;
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
    const query=this.config.auditPolicy==='current_day_pending' && this.config.heartbeatTransport==='source'
      ? this.heartbeatQueries?.get(sn) : null;
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

  async readRenderedTable(frame) {
    return frame.locator(".layui-table-view:visible .layui-table-main tbody tr").evaluateAll(trs => trs.map(tr => {
      const row = {};
      for (const td of tr.querySelectorAll("td[data-field]")) {
        const field = td.getAttribute("data-field");
        if (field === "LAY_NUM") continue;
        row[field] = td.innerText.trim();
      }
      return row;
    }).filter(row => Object.keys(row).length));
  }

  pick(row, names) {
    for (const name of names) {
      if (nonEmpty(row[name])) return String(row[name]).trim();
    }
    const normalizedNames = names.map((name) => name.replace(/[\s()（）]/g, "").toLowerCase());
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.replace(/[\s()（）]/g, "").toLowerCase();
      if (nonEmpty(value) && normalizedNames.some((name) => normalizedKey === name || normalizedKey.includes(name))) {
        return String(value).trim();
      }
    }
    return "";
  }

  async readBatteryTable() {
    return this.page.evaluate(() => {
      const views = [...document.querySelectorAll(".layui-table-view")];
      const view = views.find((item) => item.getAttribute("lay-id") === "reportViewTable" && item.getClientRects().length > 0)
        || views.find((item) => item.getClientRects().length > 0);
      if (!view) return [];
      const fieldNames = {};
      for (const header of view.querySelectorAll(".layui-table-header th[data-field]")) {
        const field = header.getAttribute("data-field");
        const title = header.querySelector(".layui-table-cell")?.textContent?.replace(/[▲▼]/g, "").trim();
        if (field && title) fieldNames[field] = title;
      }
      const rows = [];
      for (const tr of view.querySelectorAll(".layui-table-main tbody tr")) {
        const row = {};
        for (const cell of tr.querySelectorAll("td[data-field]")) {
          const field = cell.getAttribute("data-field");
          const title = fieldNames[field] || field;
          row[title] = cell.querySelector(".layui-table-cell")?.textContent?.trim() ?? "";
        }
        if (Object.keys(row).length) rows.push(row);
      }
      return rows;
    });
  }
}

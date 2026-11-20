import { parse } from 'parse5';
import { CookieJar } from 'tough-cookie';

export const tokenName = '__RequestVerificationToken';
export const sessionExpired = () => fault('平台会话已失效，保留进度后重新登录', 'SESSION_EXPIRED');
export const fault = (message, code) => Object.assign(new Error(message), { code });

function* descendants(node) {
  for (const child of node.childNodes ?? []) {
    yield child;
    yield* descendants(child);
  }
}

const attribute = (node, name) => node.attrs?.find(attr => attr.name === name)?.value;
const hasClass = (node, name) => attribute(node, 'class')?.split(/\s+/).includes(name);
const textOf = node => [...descendants(node)].filter(child => child.nodeName === '#text')
  .map(child => child.value).join('').trim();
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const scriptToken = /(?:"__RequestVerificationToken"|'__RequestVerificationToken'|\b__RequestVerificationToken\b)\s*[:=]\s*(["'])([A-Za-z0-9_-]+)\1/;

export function parseReportPage(html, { detail = false, pageName = '平台页面' } = {}) {
  const nodes = [...descendants(parse(html))];
  let formToken, inlineToken;
  const fields = new Map();
  let lastDataTime = null;
  for (const node of nodes) {
    if (node.tagName === 'input' && [attribute(node, 'name'), attribute(node, 'id')].includes(tokenName)) {
      const value = attribute(node, 'value');
      if (validToken(value)) formToken ??= value;
    }
    if (node.tagName === 'script') {
      inlineToken ??= scriptToken.exec(textOf(node))?.[2];
    }
    if (!detail) continue;
    if (hasClass(node, 'tdCell')) {
      const labels = [...descendants(node)];
      const label = labels.find(child => hasClass(child, 'tdLabel'));
      const value = labels.find(child => hasClass(child, 'tdValue'));
      if (label && value) {
        const key = textOf(label), text = textOf(value);
        if (fields.has(key) && fields.get(key) !== text) throw fault('详情页含相互冲突的基本信息字段');
        fields.set(key, text);
      }
    }
    if (attribute(node, 'id') === 'DataTime') lastDataTime = textOf(node) || null;
  }
  const token = detail ? inlineToken ?? formToken : formToken ?? inlineToken;
  if (!token) throw fault(`${pageName}未提供有效防伪令牌`);
  return { token, fields, lastDataTime };
}

export function tablePayload(payload) {
  const empty = payload?.code === 1 && payload.msg === '无数据' && payload.count === 0 && payload.data?.length === 0;
  if ((payload?.code !== 0 && !empty) || !Number.isInteger(payload.count) ||
      payload.count < 0 || !Array.isArray(payload.data)) throw fault('平台列表响应无效');
  return payload;
}

export function tableForm(token, fastItems, sortField, limit) {
  return { [tokenName]: token, otherWhere: '', fastItems, sortField, sortType: 'desc',
    ids: '', dataId: '0', page: '1', limit: String(limit) };
}

export class PlatformHttp {
  constructor(config) {
    this.config = config;
    this.base = new URL(config.baseUrl);
    if (this.base.protocol !== 'https:' &&
        !(this.base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(this.base.hostname))) {
      throw fault('平台地址必须使用 HTTPS', 'AUTH_REQUIRED');
    }
    this.jar = new CookieJar();
    this.tokens = new Map();
  }

  url(resource) {
    const url = new URL(resource, this.base);
    if (url.origin !== this.base.origin || url.username || url.password) throw fault('平台请求地址不属于当前平台');
    return url.href;
  }

  async send(resource, { form, data, headers, referrer, timeout, signal = this.config.signal } = {}) {
    signal?.throwIfAborted();
    const url = this.url(resource);
    const method = form || data !== undefined ? 'POST' : 'GET';
    const requestHeaders = new Headers(headers);
    if (referrer) requestHeaders.set('Referer', this.url(referrer));
    if (method === 'POST') {
      requestHeaders.set('Origin', this.base.origin);
      requestHeaders.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
      requestHeaders.set('X-Requested-With', 'XMLHttpRequest');
    }
    const cookies = await this.jar.getCookieString(url);
    if (cookies) requestHeaders.set('Cookie', cookies);
    const deadline = AbortSignal.timeout(timeout ?? this.config.queryTimeoutMs ?? 120000);
    let response;
    try {
      response = await fetch(url, {
        method, headers: requestHeaders, redirect: 'manual',
        body: form ? new URLSearchParams(form).toString() : data,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url, { ignoreError: true });
      return response;
    } catch {
      await response?.body?.cancel().catch(() => {});
      signal?.throwIfAborted();
      throw fault(deadline.aborted ? '平台 HTTP 请求超时' : '平台 HTTP 请求失败', 'PLATFORM_NETWORK_ERROR');
    }
  }

  async post(resource, options) {
    const response = await this.send(resource, options);
    return {
      status: () => response.status,
      json: () => response.json(),
      text: () => response.text(),
      dispose: () => response.body?.cancel().catch(() => {}),
    };
  }

  async read(resource, { format = 'text', ...options } = {}) {
    const response = await this.send(resource, options);
    try {
      if (response.status === 401 || (response.status >= 300 && response.status < 400)) throw sessionExpired();
      if (response.status === 400 && !(await response.text()).trim()) {
        throw fault('平台拒绝了防伪令牌', 'PLATFORM_TOKEN_REJECTED');
      }
      if (!response.ok) throw fault(`平台请求失败（HTTP ${response.status}）`);
      try {
        if (format === 'json') return await response.json();
        if (format === 'binary') return Buffer.from(await response.arrayBuffer());
        return await response.text();
      } catch {
        this.config.signal?.throwIfAborted();
        throw fault('平台响应读取失败或格式无效', 'PLATFORM_NETWORK_ERROR');
      }
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }

  async login() {
    const { username, password } = this.config.credentials ?? {};
    if (!username || !password) throw fault('当前环境没有可用的平台登录凭据', 'AUTH_REQUIRED');
    const loginPath = '/Login/Index';
    const { token } = parseReportPage(await this.read(loginPath), { pageName: '登录页' });
    const login = await this.read('/Login/doLogin', {
      form: { [tokenName]: token, UserName: username, PassWord: password, WXOpenId: '', LoginFlag: 'DEFAULT', Culture: 'zh-CN' },
      referrer: loginPath, format: 'json',
    });
    if (login?.ShowSlider === true) throw fault('平台要求额外登录验证', 'AUTH_REQUIRED');
    if (login?.ShowSlider !== false || login.Message !== null || login.Url !== '/Home/Index') {
      throw fault('平台未确认登录成功，请核对凭据', 'AUTH_REQUIRED');
    }
    await this.read(login.Url, { referrer: loginPath });
  }

  async withReportToken(page, operation) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let pending = this.tokens.get(page);
      if (!pending) {
        const pageName = page.endsWith('/BatteryAlarmRecord') ? '报警报表页' : '电池摘要报表页';
        pending = this.read(page, { referrer: '/Home/Index' }).then(html => parseReportPage(html, { pageName }).token);
        this.tokens.set(page, pending);
      }
      let token;
      try {
        token = await pending;
        return await operation(token);
      } catch (error) {
        if ((token === undefined || error.code === 'PLATFORM_TOKEN_REJECTED') && this.tokens.get(page) === pending) {
          this.tokens.delete(page);
        }
        if (error.code !== 'PLATFORM_TOKEN_REJECTED' || attempt === 1) throw error;
      }
    }
  }
}

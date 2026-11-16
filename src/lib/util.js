/**
 * 通用工具：ID、时间、URL 规范化、并发限制、深拷贝等。
 * 该文件同时被 service worker 与自动化测试引用（纯 ESM，无 Chrome API 依赖）。
 */

/* ---------------- 时间 ---------------- */

export function now() {
  return Date.now();
}

/** 单调递增 ID 前缀，避免同一毫秒内本地变更互相覆盖 */
let monotonicSeq = 0;
export function nextSeq() {
  monotonicSeq = (monotonicSeq + 1) % 1000;
  return monotonicSeq;
}

/* ---------------- 随机 ID ---------------- */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomId(len = 12) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 本地稳定 ID：前缀 + 时间戳(base36) + 随机，用于远程条目 id */
export function makeLocalId(prefix = 'n') {
  return prefix + now().toString(36) + randomId(6);
}

/* ---------------- 字符串 ---------------- */

export function hashString(str) {
  // FNV-1a 32bit，用于 URL 摘要、去重键等非安全场景
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function truncate(str, max) {
  if (typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) : str;
}

/* ---------------- URL 规范化 ---------------- */

/**
 * 书签去重用的 URL 键：
 *  - 小写协议与主机、去掉默认端口
 *  - 去掉 #fragment（书签里 hash 通常不是身份标识）
 *  - 保留 path / query，但去掉末尾多余斜杠
 * 非法 URL 直接返回原文（trim 后）。
 */
export function normalizeUrl(raw) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return '';
  let u;
  try {
    u = new URL(input);
  } catch {
    return input.toLowerCase();
  }
  const proto = u.protocol.toLowerCase();
  let host = u.hostname.toLowerCase();
  let port = u.port;
  if ((proto === 'http:' && port === '80') || (proto === 'https:' && port === '443')) port = '';
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const search = u.search || '';
  return proto + '//' + host + (port ? ':' + port : '') + path + search;
}

export function urlHost(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/* ---------------- 并发 ---------------- */

/**
 * 限流并行 map。Chrome 的 bookmarks API 是异步回调风格，
 * 顺序克隆 1 万个节点会很慢，这里用固定并发窗口。
 */
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, list.length || 1)).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/* ---------------- 对象 ---------------- */

export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

export function omitUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ---------------- 校验 ---------------- */

/** 只允许 http(s)/file/ftp 等浏览器书签常见协议，过滤 javascript: 等注入面 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:', 'ftp:', 'ftps:', 'chrome:', 'edge:', 'about:', 'data:', 'mailto:']);

export function isSafeBookmarkUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw);
    return ALLOWED_SCHEMES.has(u.protocol.toLowerCase()) || u.protocol === 'chrome-extension:';
  } catch {
    return false;
  }
}

const TITLE_MAX = 512;

export function sanitizeTitle(raw) {
  const t = typeof raw === 'string' ? raw : '';
  // 去掉控制字符，防止 UI 渲染异常
  return truncate(t.replace(/[\u0000-\u001f\u007f]/g, ''), TITLE_MAX);
}

/* ---------------- 时间格式化 ---------------- */

export function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function formatRelative(ts) {
  if (!ts) return '从未';
  const diff = now() - ts;
  if (diff < 0) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return s + ' 秒前';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  if (d < 30) return d + ' 天前';
  return formatTime(ts);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 指数退避，供 Google API 429/5xx 重试使用 */
export async function withRetry(fn, { retries = 3, base = 400, shouldRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = shouldRetry ? shouldRetry(err) : true;
      if (!retryable || attempt === retries) break;
      await sleep(base * Math.pow(2, attempt) + Math.floor(Math.random() * 120));
    }
  }
  throw lastErr;
}

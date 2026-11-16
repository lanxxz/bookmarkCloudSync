/**
 * 环形日志：只保留最近 N 条，写入 chrome.storage.local，供 popup/options 展示。
 * 调试时同步输出到 console（service worker 的 DevTools）。
 */
import { now, formatTime } from './util.js';

const KEY = 'bcs_logs';
const MAX = 200;

let buffer = [];
let loaded = false;
let flushing = null;
const listeners = new Set();

export const LogLevel = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  SUCCESS: 'success'
});

async function ensureLoaded() {
  if (loaded) return;
  const res = await chrome.storage.local.get(KEY);
  buffer = Array.isArray(res[KEY]) ? res[KEY] : [];
  loaded = true;
}

function scheduleFlush() {
  if (flushing) return flushing;
  flushing = Promise.resolve().then(async () => {
    flushing = null;
    await ensureLoaded();
    const payload = buffer.slice(-MAX);
    await chrome.storage.local.set({ [KEY]: payload });
  });
  return flushing;
}

export async function log(level, message, detail) {
  await ensureLoaded();
  const entry = {
    t: now(),
    level,
    message: String(message),
    detail: detail === undefined ? undefined : safeDetail(detail)
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer = buffer.slice(-MAX);
  const line = '[' + formatTime(entry.t) + '] [' + level + '] ' + entry.message;
  if (level === LogLevel.ERROR) console.error(line, detail ?? '');
  else if (level === LogLevel.WARN) console.warn(line, detail ?? '');
  else console.log(line, detail ?? '');
  await scheduleFlush();
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* ignore */
    }
  }
  return entry;
}

function safeDetail(detail) {
  if (detail instanceof Error) {
    return { name: detail.name, message: detail.message, code: detail.code };
  }
  if (detail === null || detail === undefined) return detail;
  if (typeof detail === 'string') return detail.length > 800 ? detail.slice(0, 800) + '...' : detail;
  try {
    const s = JSON.stringify(detail);
    if (!s) return String(detail);
    if (s.length <= 800) return JSON.parse(s);
    return { truncated: true, preview: s.slice(0, 800) + '...' };
  } catch {
    return String(detail);
  }
}

export const logger = {
  debug: (m, d) => log(LogLevel.DEBUG, m, d),
  info: (m, d) => log(LogLevel.INFO, m, d),
  warn: (m, d) => log(LogLevel.WARN, m, d),
  error: (m, d) => log(LogLevel.ERROR, m, d),
  success: (m, d) => log(LogLevel.SUCCESS, m, d)
};

export async function readLogs() {
  await ensureLoaded();
  return buffer.slice();
}

export async function clearLogs() {
  buffer = [];
  loaded = true;
  await chrome.storage.local.set({ [KEY]: [] });
}

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

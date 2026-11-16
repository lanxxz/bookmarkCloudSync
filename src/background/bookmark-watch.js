/**
 * 书签变更监听：只做"脏标记 + 防抖"，不在事件里直接同步。
 *
 * 为什么不在事件里同步：
 *  1. 用户批量整理书签会在几秒内触发成百上千次事件；
 *  2. bookmarks 事件不带完整树信息，需要重新扫描；
 *  3. Service Worker 有执行时间上限，长时间同步会被强杀。
 */
import { logger } from '../lib/log.js';
import { getSettings } from '../lib/auth.js';

let installed = false;
let debounceTimer = null;
let pendingReasons = new Set();
let lastAutoSync = 0;

export function installWatch() {
  if (installed) return;
  installed = true;
  const api = chrome.bookmarks;
  if (!api || !api.onCreated) {
    logger.warn('当前浏览器不支持 bookmarks 事件，自动同步退化为定时同步');
    return;
  }
  api.onCreated.addListener(() => onBookmarkEvent('created'));
  api.onRemoved.addListener(() => onBookmarkEvent('removed'));
  api.onChanged.addListener(() => onBookmarkEvent('changed'));
  api.onMoved.addListener(() => onBookmarkEvent('moved'));
  api.onChildrenReordered?.addListener(() => onBookmarkEvent('childrenReordered'));
  api.onImportEnded?.addListener(() => {
    logger.info('检测到书签导入完成，触发同步');
    pendingReasons.add('import');
    flushNow('import');
  });
  logger.debug('书签监听已安装');
}

function onBookmarkEvent(type) {
  pendingReasons.add(type);
  scheduleSync(type);
}

async function scheduleSync() {
  const settings = await getSettings();
  if (!settings.autoSync) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  const wait = Math.max(1000, Number(settings.debounceMs) || 4000);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushNow('debounce');
  }, wait);
  // MV3 中 setTimeout 可能随 SW 休眠丢失，用 alarm 兜底
  try {
    chrome.alarms.create('bcs-sync-debounce', { when: Date.now() + wait + 1500 });
  } catch {
    /* ignore */
  }
}

async function flushNow(trigger) {
  const settings = await getSettings();
  if (!settings.autoSync) return;
  const reasons = Array.from(pendingReasons);
  pendingReasons = new Set();
  const gap = Date.now() - lastAutoSync;
  const minGap = Number(settings.minIntervalMs) || 30000;
  if (gap < minGap) {
    logger.debug('自动同步节流中（' + Math.round(gap / 1000) + 's），稍后重试');
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flushNow('deferred');
    }, minGap - gap + 800);
    return;
  }
  lastAutoSync = Date.now();
  logger.info('书签变化触发同步（' + trigger + '）：' + (reasons.join(',') || 'none'));
  requestAutoSync('auto');
}

/** 由 service-worker 注入具体实现，避免循环依赖 */
let syncRunner = null;
export function bindSyncRunner(fn) {
  syncRunner = fn;
}

export function requestAutoSync(reason) {
  if (syncRunner) {
    Promise.resolve(syncRunner(reason || 'auto')).catch((err) => logger.error('自动同步失败：' + err.message, err));
    return;
  }
  chrome.runtime.sendMessage({ type: 'sync-now', reason: reason || 'auto' }).catch(() => {});
}

/** 供 alarm 触发时清空积压标记 */
export async function flushPending() {
  if (!pendingReasons.size) return false;
  const reasons = Array.from(pendingReasons);
  pendingReasons = new Set();
  requestAutoSync(reasons.join(','));
  return true;
}

/**
 * 定时补偿：
 *  - ALARM_SYNC：主同步定时器（1~180 分钟可配），书签事件丢失时的兜底；
 *  - ALARM_REMOTE：远端变化轮询（5 分钟），只读元数据，版本变了才真正同步。
 *
 * 两个后端都要支持：
 *  - Google Drive：比对 modifiedTime；
 *  - GitHub：比对文件 blob sha（每次同步都产生新 commit，sha 必变）。
 */
import { logger } from '../lib/log.js';
import { getSettings } from '../lib/auth.js';
import { getIdbState, getMeta, setMeta } from '../lib/idb.js';
import { backendFor, peekTokenFor, resolveBackend } from '../lib/storage/index.js';

export const ALARM_SYNC = 'bcs-sync';
export const ALARM_REMOTE = 'bcs-remote-poll';
const META_REMOTE_SEEN = 'remoteSeen';

export async function setupAlarms(settings) {
  const s = settings || (await getSettings());
  const minutes = Math.max(1, Math.min(180, Number(s.syncIntervalMinutes) || 15));

  await chrome.alarms.clear(ALARM_SYNC);
  await chrome.alarms.clear(ALARM_REMOTE);

  if (s.autoSync) {
    chrome.alarms.create(ALARM_SYNC, { periodInMinutes: minutes, delayInMinutes: 1 });
  }
  chrome.alarms.create(ALARM_REMOTE, { periodInMinutes: 5, delayInMinutes: 2 });
  logger.debug('定时任务已配置：主同步每 ' + minutes + ' 分钟，远端轮询 5 分钟');
  return { minutes };
}

/** 只读检查云端版本是否变化，不下载正文 */
export async function checkRemoteChanged() {
  const s = await getSettings();
  const token = await peekTokenFor(s);
  if (!token) return false;

  const state = await getIdbState('sync-state');
  if (!state) return false;

  const { backend } = backendFor(s);
  let cfg;
  try {
    cfg = backend.cfgFromSettings(s);
  } catch {
    return false;
  }

  let head;
  try {
    head = await backend.headDoc(cfg, { token });
  } catch (err) {
    logger.warn('远端轮询失败', err);
    return false;
  }
  if (!head) return true;

  // 版本标识：Drive 用 md5/id+modifiedTime，GitHub 用 blob sha
  const version = head.sha || '';
  const last = await getMeta(META_REMOTE_SEEN);
  if (!last || typeof last !== 'object') {
    await setMeta(META_REMOTE_SEEN, { version, at: Date.now(), backend: resolveBackend(s) });
    return false;
  }
  const changed = version && version !== last.version;
  if (changed) await setMeta(META_REMOTE_SEEN, { version, at: Date.now(), backend: resolveBackend(s) });
  return !!changed;
}

/** 本机上次同步成功后记录远端版本，避免自己写完立刻触发下一轮 */
export async function markRemoteSeen({ settings } = {}) {
  const s = settings || (await getSettings());
  const token = await peekTokenFor(s);
  if (!token) return;
  const { backend } = backendFor(s);
  try {
    const cfg = backend.cfgFromSettings(s);
    const head = await backend.headDoc(cfg, { token });
    if (head) await setMeta(META_REMOTE_SEEN, { version: head.sha || '', at: Date.now(), backend: resolveBackend(s) });
  } catch {
    /* 忽略 */
  }
}

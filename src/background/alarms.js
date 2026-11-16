/**
 * 定时补偿：
 *  - ALARM_SYNC：主同步定时器（1~180 分钟可配），书签事件丢失时的兜底；
 *  - ALARM_REMOTE：远端变化轮询（5 分钟），只读元数据，modifiedTime 变了才真正同步。
 */
import { logger } from '../lib/log.js';
import { getSettings, peekToken } from '../lib/auth.js';
import { findFile } from '../lib/drive.js';
import { getIdbState, setMeta } from '../lib/idb.js';

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

/** 只读检查云端 modifiedTime 是否变化，不下载正文 */
export async function checkRemoteChanged() {
  const token = await peekToken();
  if (!token) return false;
  const state = await getIdbState('sync-state');
  if (!state || !state.fileId) return false;
  const s = await getSettings();
  const meta = await findFile(s.driveFile || 'bookmarks.json', { token });
  if (!meta) return true;
  if (meta.id !== state.fileId) return true;
  const last = Number(await getMeta(META_REMOTE_SEEN)) || 0;
  const cur = new Date(meta.modifiedTime).getTime();
  if (!last) {
    await setMeta(META_REMOTE_SEEN, cur);
    return false;
  }
  const changed = cur > last + 2000;
  if (changed) await setMeta(META_REMOTE_SEEN, cur);
  return changed;
}

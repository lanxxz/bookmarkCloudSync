/**
 * 快照（历史备份）系统。
 *
 * 双层保存：
 *   1. 本地 IndexedDB —— 应急恢复，离线可用，保留 localHistoryKeep 条；
 *   2. Google Drive appDataFolder/history/ —— 跨设备恢复，保留 historyKeep 条。
 *
 * 快照是「完整节点集合」的 JSON，包含墓碑，所以能精确还原到某个时间点，
 * 也能从快照里看出当时哪些节点被删了（deleted=true + deletedAt）。
 */
import { logger } from './log.js';
import { indexToNodes, nodesToIndex, docStats, SCHEMA_VERSION } from './protocol.js';
import { putSnapshot, listSnapshots, pruneLocalSnapshots, getSnapshot, deleteSnapshot } from './idb.js';
import { HISTORY_DIR_NAME, createFolder, deleteFile, findFile, getFileText, listAppData } from './drive.js';
import { getSettings } from './auth.js';
import { formatTime } from './util.js';

export const SNAPSHOT_KIND = Object.freeze({
  PRE_SYNC: 'pre-sync',       // 应用变更前
  MANUAL: 'manual',           // 用户手动创建
  RESTORE: 'restore',         // 恢复前对当前状态做的保险快照
  PRE_PULL: 'pre-pull',
  PRE_PUSH: 'pre-push'
});

/** Drive 文件名不能带 "/"，所以全部用下划线拼接 */
function snapshotFileName(ts, deviceId, suffix = '') {
  const iso = new Date(ts).toISOString().replace(/[:.]/g, '-');
  const dev = String(deviceId || 'dev').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) || 'dev';
  return 'snap-' + iso + '_' + dev + (suffix ? '_' + suffix : '') + '.json';
}

/* ---------------- 本地快照 ---------------- */

export async function saveLocalSnapshot({ index, kind, deviceId, reason = '', extra = {} }) {
  const settings = await getSettings();
  const ts = Date.now();
  const nodes = indexToNodes(index instanceof Map ? index : nodesToIndex(index));
  const stats = docStats({ nodes: index, revision: 0, updatedAt: ts });
  const record = {
    id: 'snp_' + ts.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    ts,
    kind,
    reason,
    deviceId,
    stats,
    count: nodes.length,
    nodes,
    ...extra
  };
  await putSnapshot(record);
  try {
    await pruneLocalSnapshots(settings.localHistoryKeep || 30);
  } catch (err) {
    logger.warn('本地快照裁剪失败', err);
  }
  logger.info('已保存本地快照（' + kind + '）：' + nodes.length + ' 个节点');
  return record;
}

export async function getLocalSnapshots(limit = 60) {
  const rows = await listSnapshots(limit);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    reason: r.reason,
    count: r.count,
    stats: r.stats,
    time: formatTime(r.ts),
    source: 'local'
  }));
}

/* ---------------- 云端快照 ---------------- */

let historyFolderId = null;

export async function ensureHistoryFolder({ token } = {}) {
  if (historyFolderId) return historyFolderId;
  const found = await findFile(HISTORY_DIR_NAME, { token, mimeType: 'application/vnd.google-apps.folder' });
  if (found) {
    historyFolderId = found.id;
    return historyFolderId;
  }
  const created = await createFolder(HISTORY_DIR_NAME, { token }).catch(async (err) => {
    logger.warn('创建历史目录失败，尝试重新查找', err);
    const again = await findFile(HISTORY_DIR_NAME, { token, mimeType: 'application/vnd.google-apps.folder' });
    if (again) return again;
    throw err;
  });
  historyFolderId = created.id;
  logger.info('已创建云端历史目录 ' + HISTORY_DIR_NAME);
  return historyFolderId;
}

/** 上传一份快照到 Drive（失败不影响主流程） */
export async function saveRemoteSnapshot({ index, kind, deviceId, reason = '', revision = 0, token }) {
  try {
    const settings = await getSettings();
    const folderId = await ensureHistoryFolder({ token });
    const ts = Date.now();
    const nodes = indexToNodes(index instanceof Map ? index : nodesToIndex(index));
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'snapshot',
      snapshotKind: kind,
      ts,
      reason,
      deviceId,
      revision,
      count: nodes.length,
      stats: docStats({ nodes: index, revision, updatedAt: ts }),
      nodes
    };
    const name = snapshotFileName(ts, deviceId, kind);
    const meta = await uploadToFolder(folderId, name, JSON.stringify(payload), { token });
    await pruneRemoteSnapshots({ token, folderId, keep: settings.historyKeep || 10 });
    logger.info('已上传云端快照：' + name);
    return { id: meta.id, name, ts, count: nodes.length };
  } catch (err) {
    logger.warn('上传云端快照失败（不影响同步）', err);
    return null;
  }
}

async function uploadToFolder(folderId, name, content, { token } = {}) {
  // createTextFile 固定挂到 appDataFolder，这里需要挂到子目录，单独实现 multipart
  const { requireToken } = await import('./auth.js');
  const auth = token || (await requireToken());
  const boundary = 'bcs' + Math.random().toString(36).slice(2);
  const meta = { name, parents: [folderId], mimeType: 'application/json' };
  const head =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n';
  const tail = '\r\n--' + boundary + '--';
  const body = new Blob([head, content, tail], { type: 'multipart/related; boundary=' + boundary });
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('上传历史快照失败 HTTP ' + res.status + ' ' + text.slice(0, 200));
  }
  return res.json();
}

export async function pruneRemoteSnapshots({ token, folderId, keep = 10 } = {}) {
  const fid = folderId || (await ensureHistoryFolder({ token }));
  const all = [];
  let pageToken;
  do {
    const page = await listAppData({
      token,
      q: "'" + fid + "' in parents and trashed = false",
      pageSize: 100,
      pageToken,
      fields: 'id,name,modifiedTime,size'
    });
    for (const f of page.files || []) all.push(f);
    pageToken = page.nextPageToken;
  } while (pageToken);

  all.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  const extra = all.slice(keep);
  for (const f of extra) {
    try {
      await deleteFile(f.id, { token });
    } catch (err) {
      logger.warn('删除旧快照失败 ' + f.name, err.message);
    }
  }
  return { total: all.length, removed: extra.length, kept: Math.min(all.length, keep) };
}

export async function listRemoteSnapshots({ token } = {}) {
  const fid = await ensureHistoryFolder({ token });
  const all = [];
  let pageToken;
  do {
    const page = await listAppData({
      token,
      q: "'" + fid + "' in parents and trashed = false",
      pageSize: 100,
      pageToken,
      fields: 'id,name,modifiedTime,size'
    });
    for (const f of page.files || []) all.push(f);
    pageToken = page.nextPageToken;
  } while (pageToken);
  all.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  return all.map((f) => ({
    id: f.id,
    name: f.name,
    size: Number(f.size || 0),
    ts: new Date(f.modifiedTime).getTime(),
    time: formatTime(new Date(f.modifiedTime).getTime()),
    source: 'drive',
    kind: (f.name.match(/_(pre-sync|manual|restore|pre-pull|pre-push)\.json$/) || [])[1] || 'snapshot'
  }));
}

export async function loadSnapshotNodes({ id, source, token } = {}) {
  if (source === 'drive') {
    const { text } = await getFileText(id, { token });
    const data = JSON.parse(text);
    if (!Array.isArray(data.nodes)) throw new Error('快照文件缺少 nodes');
    return { nodes: nodesToIndex(data.nodes), meta: { ts: data.ts, kind: data.snapshotKind, deviceId: data.deviceId, count: data.count } };
  }
  const row = await getSnapshot(id);
  if (!row) throw new Error('本地快照不存在：' + id);
  return { nodes: nodesToIndex(row.nodes), meta: { ts: row.ts, kind: row.kind, deviceId: row.deviceId, count: row.count } };
}

export { deleteSnapshot };

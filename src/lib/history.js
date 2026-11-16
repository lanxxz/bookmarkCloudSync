/**
 * 快照（历史备份）系统。
 *
 * 双层保存：
 *   1. 本地 IndexedDB —— 应急恢复，离线可用，保留 localHistoryKeep 条；
 *   2. 云端 —— 跨设备恢复，保留 historyKeep 条。
 *      后端随设置切换：Google Drive 的 bcs-history/ 目录，或 GitHub 仓库的
 *      bcs-history/ 目录（= 每次同步一个 commit，历史天然可 checkout）。
 *
 * 快照是「完整节点集合」的 JSON，包含墓碑，所以能精确还原到某个时间点，
 * 也能从快照里看出当时哪些节点被删了（deleted=true + deletedAt）。
 */
import { logger } from './log.js';
import { indexToNodes, nodesToIndex, docStats, SCHEMA_VERSION } from './protocol.js';
import { putSnapshot, listSnapshots, pruneLocalSnapshots, getSnapshot, deleteSnapshot } from './idb.js';
import { getSettings } from './auth.js';
import { formatTime } from './util.js';
import { backendFor, BACKENDS } from './storage/index.js';

export const SNAPSHOT_KIND = Object.freeze({
  PRE_SYNC: 'pre-sync',       // 应用变更前
  MANUAL: 'manual',           // 用户手动创建
  RESTORE: 'restore',         // 恢复前对当前状态做的保险快照
  PRE_PULL: 'pre-pull',
  PRE_PUSH: 'pre-push'
});

/** 云端文件名不能带分隔符，所以全部用下划线拼接 */
function snapshotFileName(ts, deviceId, suffix = '') {
  const iso = new Date(ts).toISOString().replace(/[:.]/g, '-');
  const dev = String(deviceId || 'dev').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) || 'dev';
  return 'snap-' + iso + '_' + dev + (suffix ? '_' + suffix : '') + '.json';
}

function parseSnapshotKind(name) {
  return (name.match(/_(pre-sync|manual|restore|pre-pull|pre-push)\.json$/) || [])[1] || 'snapshot';
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

function snapshotPayload({ index, kind, deviceId, reason, revision }) {
  const ts = Date.now();
  const nodes = indexToNodes(index instanceof Map ? index : nodesToIndex(index));
  return {
    ts,
    nodes,
    payload: {
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
    }
  };
}

/**
 * 把一份快照写到"当前后端"。
 *
 * 只依赖统一接口（saveSnapshot / pruneSnapshots），不再按后端分支。
 * GitHub 模式额外的好处：同步本身也产生 commit，即便快照写失败，
 * git 历史里也已经有可回滚的版本。
 */
export async function saveRemoteSnapshot({ index, kind, deviceId, reason = '', revision = 0, token, settings }) {
  try {
    const s = settings || (await getSettings());
    const { backend } = backendFor(s);
    const cfg = backend.cfgFromSettings(s);
    const { ts, nodes, payload } = snapshotPayload({ index, kind, deviceId, reason, revision });
    const name = snapshotFileName(ts, deviceId, kind);

    const meta = await backend.saveSnapshot(cfg, {
      name,
      text: JSON.stringify(payload),
      token,
      message: 'chore(bcs): snapshot ' + kind + ' r' + revision
    });
    logger.info('已保存云端快照：' + name);
    await pruneRemoteSnapshots({ token, settings: s, keep: s.historyKeep || 10 });
    return { id: meta.id, name, ts, count: nodes.length };
  } catch (err) {
    logger.warn('保存云端快照失败（不影响同步）', err);
    return null;
  }
}

export async function pruneRemoteSnapshots({ token, settings, keep = 10 } = {}) {
  const s = settings || (await getSettings());
  const { backend } = backendFor(s);
  const cfg = backend.cfgFromSettings(s);
  return backend.pruneSnapshots(cfg, { token, keep });
}

/**
 * 列出可恢复的云端版本。
 *
 * 两种后端都返回快照文件；GitHub 额外把"文档本身的 commit 历史"也列出来，
 * 因为那边每次同步就是一个 commit，比快照更细。
 */
export async function listRemoteSnapshots({ token, settings } = {}) {
  const s = settings || (await getSettings());
  const { name: backendName, backend } = backendFor(s);
  const cfg = backend.cfgFromSettings(s);

  const rows = await backend.listSnapshots(cfg, { token, limit: 60 });
  const snaps = rows.map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    ts: f.ts,
    time: formatTime(f.ts),
    source: backendName,
    kind: parseSnapshotKind(f.name)
  }));

  if (backendName !== BACKENDS.GITHUB) return snaps;

  const commits = await backend.listCommits(cfg, cfg.path, { token, limit: 30 }).catch(() => []);
  const docCommits = commits.map((c) => {
    const at = new Date((c.commit && c.commit.author && c.commit.author.date) || 0).getTime();
    const msg = (c.commit && c.commit.message ? c.commit.message.split('\n')[0] : c.sha.slice(0, 8)).slice(0, 60);
    return {
      id: 'commit:' + c.sha,
      name: msg,
      size: 0,
      ts: at,
      time: formatTime(at),
      source: 'github-commit',
      kind: 'commit',
      sha: c.sha
    };
  });
  return [...snaps, ...docCommits];
}

export async function loadSnapshotNodes({ id, source, token, settings } = {}) {
  const s = settings || (await getSettings());
  const { backend } = backendFor(s);
  const cfg = backend.cfgFromSettings(s);

  if (source === 'local') {
    const row = await getSnapshot(id);
    if (!row) throw new Error('本地快照不存在：' + id);
    return {
      nodes: nodesToIndex(row.nodes),
      meta: { ts: row.ts, kind: row.kind, deviceId: row.deviceId, count: row.count }
    };
  }

  // GitHub 的 commit 历史走 readAtVersion({ commit })
  if (String(source).startsWith('github-commit') || String(id).startsWith('commit:')) {
    const commit = String(id).startsWith('commit:') ? String(id).slice(7) : String(id);
    const res = await backend.readAtVersion(cfg, { commit, token });
    const doc = JSON.parse(res.text);
    if (!Array.isArray(doc.nodes)) throw new Error('该版本缺少 nodes');
    return {
      nodes: nodesToIndex(doc.nodes),
      meta: { ts: doc.updatedAt, kind: 'commit', deviceId: doc.writer, count: doc.nodes.length }
    };
  }

  const res = await backend.readAtVersion(cfg, { id, token });
  const data = JSON.parse(res.text);
  if (!Array.isArray(data.nodes)) throw new Error('快照文件缺少 nodes');
  return {
    nodes: nodesToIndex(data.nodes),
    meta: { ts: data.ts, kind: data.snapshotKind, deviceId: data.deviceId, count: data.count }
  };
}

export { deleteSnapshot };
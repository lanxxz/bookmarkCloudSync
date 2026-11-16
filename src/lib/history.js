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
import { GITHUB_HISTORY_DIR } from './storage/github.js';

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
 * GitHub 模式有个额外好处：同步本身也会产生 commit，
 * 所以即便快照写失败，git 历史里也已经有可回滚的版本，不会丢数据。
 */
export async function saveRemoteSnapshot({ index, kind, deviceId, reason = '', revision = 0, token, settings }) {
  try {
    const s = settings || (await getSettings());
    const { name: backendName, backend } = backendFor(s);
    const cfg = backend.cfgFromSettings(s);
    const { ts, nodes, payload } = snapshotPayload({ index, kind, deviceId, reason, revision });

    if (backendName === BACKENDS.GITHUB) {
      const fileName = GITHUB_HISTORY_DIR + '/' + snapshotFileName(ts, deviceId, kind);
      const res = await backend.writeFile(cfg, fileName, JSON.stringify(payload), {
        token,
        message: 'chore(bcs): snapshot ' + kind + ' r' + revision
      });
      logger.info('已提交云端快照：' + fileName);
      await pruneRemoteSnapshots({ token, settings: s, keep: s.historyKeep || 10 });
      return { id: res.version, name: fileName, ts, count: nodes.length };
    }

    const fileName = snapshotFileName(ts, deviceId, kind);
    const meta = await backend.saveSnapshot(cfg, { name: fileName, text: JSON.stringify(payload), token });
    await pruneRemoteSnapshots({ token, settings: s, keep: s.historyKeep || 10 });
    logger.info('已上传云端快照：' + fileName);
    return { id: meta.id, name: fileName, ts, count: nodes.length };
  } catch (err) {
    logger.warn('保存云端快照失败（不影响同步）', err);
    return null;
  }
}

export async function pruneRemoteSnapshots({ token, settings, keep = 10 } = {}) {
  const s = settings || (await getSettings());
  const { name: backendName, backend } = backendFor(s);
  const cfg = backend.cfgFromSettings(s);

  if (backendName === BACKENDS.GITHUB) {
    const files = await backend.listDir(cfg, GITHUB_HISTORY_DIR, { token });
    const snaps = files
      .filter((f) => f.type === 'file' && /^snap-.*\.json$/.test(f.name))
      .sort((a, b) => (a.name < b.name ? 1 : -1));
    const extra = snaps.slice(Math.max(1, keep));
    let removed = 0;
    for (const f of extra) {
      try {
        await backend.deleteFile(cfg, GITHUB_HISTORY_DIR + '/' + f.name, { token });
        removed++;
      } catch (err) {
        logger.warn('删除旧快照失败 ' + f.name, err);
      }
    }
    return { total: snaps.length, removed, kept: Math.min(snaps.length, keep) };
  }

  return backend.pruneSnapshots(cfg, { token, keep });
}

export async function listRemoteSnapshots({ token, settings } = {}) {
  const s = settings || (await getSettings());
  const { name: backendName, backend } = backendFor(s);
  const cfg = backend.cfgFromSettings(s);

  if (backendName === BACKENDS.GITHUB) {
    const [files, commits] = await Promise.all([
      backend.listDir(cfg, GITHUB_HISTORY_DIR, { token }),
      backend.listCommits(cfg, cfg.path, { token, limit: 30 })
    ]);
    const snaps = files
      .filter((f) => f.type === 'file' && /^snap-.*\.json$/.test(f.name))
      .map((f) => ({
        id: GITHUB_HISTORY_DIR + '/' + f.name,
        name: f.name,
        size: Number(f.size || 0),
        ts: 0,
        time: '',
        source: 'github',
        kind: parseSnapshotKind(f.name)
      }));
    for (const snap of snaps) {
      const m = snap.name.match(/^snap-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      if (m) {
        const iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + 'Z';
        snap.ts = Date.parse(iso) || 0;
        snap.time = formatTime(snap.ts);
      }
    }
    snaps.sort((a, b) => b.ts - a.ts);
    // 文档本身的 commit 历史也是一条恢复路径，附在末尾
    const docCommits = commits.map((c) => ({
      id: 'commit:' + c.sha,
      name: (c.commit && c.commit.message ? c.commit.message.split('\n')[0] : c.sha.slice(0, 8)).slice(0, 60),
      size: 0,
      ts: new Date((c.commit && c.commit.author && c.commit.author.date) || 0).getTime(),
      time: formatTime(new Date((c.commit && c.commit.author && c.commit.author.date) || 0).getTime()),
      source: 'github-commit',
      kind: 'commit',
      sha: c.sha
    }));
    return [...snaps, ...docCommits];
  }

  const rows = await backend.listSnapshots(cfg, { token, limit: 60 });
  return rows.map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    ts: f.ts,
    time: formatTime(f.ts),
    source: 'drive',
    kind: parseSnapshotKind(f.name)
  }));
}

export async function loadSnapshotNodes({ id, source, token, settings } = {}) {
  const s = settings || (await getSettings());
  const { name: backendName, backend } = backendFor(s);
  const cfg = backend.cfgFromSettings(s);

  if (source === 'local') {
    const row = await getSnapshot(id);
    if (!row) throw new Error('本地快照不存在：' + id);
    return { nodes: nodesToIndex(row.nodes), meta: { ts: row.ts, kind: row.kind, deviceId: row.deviceId, count: row.count } };
  }

  let text;
  if (typeof source === 'string' && source.startsWith('github-commit')) {
    // 从 commit 恢复：读该 commit 下的文档内容
    const sha = id.startsWith('commit:') ? id.slice(7) : id;
    const file = await backend.readFile(cfg, cfg.path, { token, ref: sha });
    if (!file.exists) throw new Error('该 commit 里没有同步文档');
    text = file.text;
    const doc = JSON.parse(text);
    if (!Array.isArray(doc.nodes)) throw new Error('文档缺少 nodes');
    return { nodes: nodesToIndex(doc.nodes), meta: { ts: doc.updatedAt, kind: 'commit', deviceId: doc.writer, count: doc.nodes.length } };
  }

  if (backendName === BACKENDS.GITHUB) {
    const rel = String(id).replace(/^\/+/, '');
    const file = await backend.readFile(cfg, rel, { token });
    if (!file.exists) throw new Error('快照不存在：' + rel);
    text = file.text;
  } else {
    const res = await backend.readSnapshot(cfg, id, { token });
    text = res.text;
  }

  const data = JSON.parse(text);
  if (!Array.isArray(data.nodes)) throw new Error('快照文件缺少 nodes');
  return {
    nodes: nodesToIndex(data.nodes),
    meta: { ts: data.ts, kind: data.snapshotKind, deviceId: data.deviceId, count: data.count }
  };
}

export { deleteSnapshot };

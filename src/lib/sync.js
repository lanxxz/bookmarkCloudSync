/**
 * 同步引擎：一次 sync() 就是一轮完整的三方合并。
 *
 *             ┌──────────── ┐
 *  Chrome ──> │ scanLocal   │ ─┐
 *             └─────────────┘  │
 *                              ├─> mergeDocs(base, local, remote) ─> merged
 *             ┌─────────────┐  │                                    │
 *  Drive  ──> │ readRemote  │ ─┘                                    │
 *             └─────────────┘                                       │
 *                       ┌────────────────────────────────────────────┤
 *                       ▼                                            ▼
 *              写回 Drive（If-Match）                        应用到本地 Chrome
 *
 * 关键不变量：
 *  1. 任何写操作前先落快照（本地 + 云端），失败不阻断但会记日志；
 *  2. 删除永远走墓碑，不做物理覆盖；
 *  3. 云端写入用 ETag 乐观并发，412 就重读重合并，最多重试 3 轮；
 *  4. 本地删除超过阈值（数量或比例）时进入 pending，等用户二次确认。
 */
import { logger } from './log.js';
import {
  mergeDocs,
  nodesToIndex,
  indexToNodes,
  createDoc,
  serializeDoc,
  docStats,
  normalizeIndices,
  planLocalApply,
  planLocalSummary,
  diffSummary,
  isEmptyDiff,
  isEmptyPlan,
  filterExcluded,
  buildBaseAfterPending
} from './protocol.js';
import { scanLocal, applyLocalPlan, refreshMapping, resolveRootParent, clearRootParentCache, clearLocalBookmarks } from './local.js';
import { backendFor, isConflict, resolveToken, backendStatus, peekTokenFor } from './storage/index.js';
import { getSettings } from './auth.js';
import { getIdbState, setIdbState, pruneLocalSnapshots } from './idb.js';
import { saveLocalSnapshot, saveRemoteSnapshot, loadSnapshotNodes, SNAPSHOT_KIND } from './history.js';
import { hashString, now as nowFn, randomId } from './util.js';

const STATE_KEY = 'sync-state';
const LOCK_KEY = 'bcs_sync_lock';
const LOCK_TTL_MS = 90_000;
const MAX_CLOUD_RETRY = 3;

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

function defaultState(deviceId) {
  return {
    deviceId,
    fileId: '',
    etag: '',
    revision: 0,
    lastSyncAt: 0,
    lastLocalHash: '',
    baseNodes: [],       // 上次同步后的合并结果（base）
    mapping: {},         // nodeId -> chromeId
    seen: {},            // nodeId -> { fp, at } 本地变更时间台账
    pending: null,       // 需要用户确认的计划
    conflicts: [],       // 最近一次同步的冲突
    stats: null,
    lastError: ''
  };
}

export async function loadState() {
  const raw = await getIdbState(STATE_KEY);
  if (!raw) return null;
  return {
    ...raw,
    baseIndex: nodesToIndex(raw.baseNodes || []),
    mapping: new Map(Object.entries(raw.mapping || {})),
    seen: raw.seen || {},
    pending: raw.pending || null
  };
}

export async function saveState(state) {
  const payload = {
    deviceId: state.deviceId,
    fileId: state.fileId || '',
    etag: state.etag || '',
    revision: state.revision || 0,
    lastSyncAt: state.lastSyncAt || 0,
    lastLocalHash: state.lastLocalHash || '',
    baseNodes: indexToNodes(state.baseIndex instanceof Map ? state.baseIndex : nodesToIndex(state.baseNodes || [])),
    mapping: Object.fromEntries((state.mapping instanceof Map ? state.mapping : new Map(Object.entries(state.mapping || {}))).entries()),
    seen: state.seen || {},
    pending: state.pending || null,
    conflicts: (state.conflicts || []).slice(0, 40),
    stats: state.stats || null,
    lastError: state.lastError || ''
  };
  await setIdbState(STATE_KEY, payload);
  return payload;
}

export async function ensureDeviceId() {
  const existing = await loadState();
  if (existing && existing.deviceId) return existing.deviceId;
  const deviceId = 'dev-' + randomId(10);
  const state = { ...defaultState(deviceId), baseIndex: new Map(), mapping: new Map() };
  await saveState(state);
  logger.info('初始化设备 ID：' + deviceId);
  return deviceId;
}

/* ------------------------------------------------------------------ *
 * 互斥锁：防抖/定时/手动同时触发导致并发写
 * ------------------------------------------------------------------ */

let memoryLock = null;

async function acquireLock() {
  const token = { at: nowFn(), id: randomId(6) };
  if (memoryLock) return null;
  memoryLock = token;
  try {
    const res = await chrome.storage.local.get(LOCK_KEY);
    const held = res[LOCK_KEY];
    if (held && Date.now() - held.at < LOCK_TTL_MS) {
      memoryLock = null;
      return null;
    }
    await chrome.storage.local.set({ [LOCK_KEY]: token });
  } catch {
    /* storage 偶发失败不影响内存锁 */
  }
  return token;
}

async function releaseLock(token) {
  if (memoryLock && token && memoryLock.id === token.id) memoryLock = null;
  try {
    const res = await chrome.storage.local.get(LOCK_KEY);
    if (res[LOCK_KEY] && token && res[LOCK_KEY].id === token.id) await chrome.storage.local.remove(LOCK_KEY);
  } catch {
    /* ignore */
  }
}

export function isLocked() {
  return !!memoryLock;
}

/* ------------------------------------------------------------------ *
 * 本地变更打时间戳
 * ------------------------------------------------------------------ */

/**
 * Chrome 的书签节点没有"修改时间"字段，扫描出来的 updatedAt 只能是 0。
 * 如果直接拿 0 去参与三方合并，本地改过的标题/URL 永远输给云端时间戳，
 * 用户会觉得"我改的东西同步后被改回去了"。
 *
 * 这里维护一份本地指纹台账：内容指纹没变 -> 沿用旧时间戳；
 * 指纹变了（新增/改标题/改 URL/换父目录/被删）-> 盖当前时间。
 * 这样本地修改在 LWW 里就有了真实的先后关系，同时不会每次扫描都抖动。
 */
function fingerprint(node) {
  return [node.parentId || '', node.type, node.title || '', node.url || '', node.index, node.deleted ? 1 : 0].join('\u0001');
}

export function stampLocalChanges(index, prevSeen, at = Date.now()) {
  const seen = {};
  const out = new Map();
  for (const [id, node] of index) {
    const fp = fingerprint(node);
    const prev = prevSeen && prevSeen[id];
    let updatedAt = node.updatedAt || 0;
    if (!prev || prev.fp !== fp) updatedAt = at;
    else updatedAt = prev.at || updatedAt || at;
    const next = updatedAt === node.updatedAt ? node : { ...node, updatedAt };
    out.set(id, next);
    seen[id] = { fp, at: updatedAt };
  }
  return { index: out, seen };
}

/** 落地/合并之后，用合并结果的真实时间戳重建台账，避免下一轮重复盖时间 */
export function rebuildSeen(index) {
  const seen = {};
  for (const [id, node] of index) {
    seen[id] = { fp: fingerprint(node), at: node.updatedAt || 0 };
  }
  return seen;
}

/* ------------------------------------------------------------------ *
 * 远端读取
 * ------------------------------------------------------------------ */

/**
 * 读取云端文档。
 *
 * 存储后端由设置决定（Google Drive 或 GitHub 私有仓库），这里只跟抽象接口打交道：
 * 返回的 version 对 Drive 是 ETag、对 GitHub 是 blob sha，语义都是"写回去时的乐观锁"。
 */
export async function readRemote({ token, settings } = {}) {
  const s = settings || (await getSettings());
  const { name: backendName, backend } = backendFor(s);
  const cfg = backend.cfgFromSettings(s);
  const res = await backend.readDoc(cfg, { token });

  if (!res.exists) {
    return { exists: false, doc: null, fileId: '', etag: '', name: cfg.path, backend: backendName };
  }
  const parsed = docFromJson(res.text);
  if (!parsed.ok) {
    logger.error('云端文档解析失败', parsed);
    throw Object.assign(new Error('云端文档格式异常：' + (parsed.error || 'unknown')), { code: 'REMOTE_CORRUPT' });
  }
  return {
    exists: true,
    doc: parsed.doc,
    fileId: res.fileId || '',
    etag: res.version || '',
    name: cfg.path,
    backend: backendName,
    raw: res.text
  };
}

/** 云端连接是否就绪（GitHub 需要 PAT + 仓库配置） */
export async function ensureRemoteReady(settings) {
  const s = settings || (await getSettings());
  const { name: backendName, backend } = backendFor(s);
  const cfg = backend.cfgFromSettings(s);
  return { backend: backendName, cfg };
}

/** 把用户设置翻译成合并策略（含墓碑保留期） */
function mergePolicy(settings) {
  const days = Number(settings.tombstoneDays) || 90;
  return {
    fieldConflict: settings.fieldConflict,
    deleteConflict: settings.deleteConflict,
    tombstoneTtlMs: Math.max(1, days) * 24 * 60 * 60 * 1000
  };
}

/* ------------------------------------------------------------------ *
 * 差异保护
 * ------------------------------------------------------------------ */

/**
 * 删除保护：绝对阈值 + 相对阈值双重判断。
 * 绝对阈值防"一次删掉几百条"；相对阈值防"书签本来就少，删掉一半"。
 */
export function deleteGuard(plan, settings, localActiveCount = 0) {
  const total = plan.deletes.length;
  const limit = Math.max(1, Number(settings.maxAutoDeletes) || 50);
  const ratio = Math.min(1, Math.max(0.05, Number(settings.maxAutoDeleteRatio) || 0.25));

  const overAbsolute = total > limit;
  const overRatio = localActiveCount > 0 && total / localActiveCount > ratio;
  const blocked = overAbsolute || (overRatio && total >= 5);

  let reason = '';
  if (overAbsolute) {
    reason = '本轮将删除 ' + total + ' 个本地书签，超过自动阈值 ' + limit + ' 条，需要你确认后再执行';
  } else if (blocked) {
    reason =
      '本轮将删除 ' + total + ' 个本地书签，占现有 ' + localActiveCount + ' 条的 ' +
      Math.round((total / localActiveCount) * 100) + '%，超过 ' + Math.round(ratio * 100) + '% 的安全比例，需要你确认';
  }
  return { blocked, total, limit, ratio, localActiveCount, overAbsolute, overRatio, reason };
}

/** 统计当前本机活跃节点数（不含墓碑），供相对阈值使用 */
export function countActive(index) {
  let n = 0;
  for (const node of index.values()) if (!node.deleted) n++;
  return n;
}

/* ------------------------------------------------------------------ *
 * 预览：不写任何东西
 * ------------------------------------------------------------------ */

export async function previewSync({ token, settings } = {}) {
  const s = settings || (await getSettings());
  const auth = token || (await resolveToken(s));
  const state = (await loadState()) || { ...defaultState(await ensureDeviceId()), baseIndex: new Map(), mapping: new Map() };

  const local = await scanLocal({ mapping: state.mapping, deviceId: state.deviceId });
  const localIndex = filterExcluded(stampLocalChanges(normalizeIndices(local.nodes), state.seen).index, s.excludeFolders);
  const remote = await readRemote({ token: auth, settings: s });
  const remoteIndex = filterExcluded(remote.exists ? remote.doc.nodes : new Map(), s.excludeFolders);

  const base = filterExcluded(state.baseIndex instanceof Map ? state.baseIndex : new Map(), s.excludeFolders);
  const result = mergeDocs({
    base,
    local: localIndex,
    remote: remoteIndex,
    deviceId: state.deviceId,
    policy: mergePolicy(s)
  });

  const mergedIndex = normalizeIndices(result.merged);
  const plan = planLocalApply({ merged: mergedIndex, local: localIndex, chromeIdOf: local.mapping });
  const summary = planLocalSummary(plan);
  const guard = deleteGuard(plan, s, countActive(localIndex));

  return {
    ok: true,
    remoteExists: remote.exists,
    remoteRevision: remote.exists ? remote.doc.revision : 0,
    mergedStats: docStats({ nodes: mergedIndex, revision: 0, updatedAt: 0 }),
    localStats: local.stats,
    toLocal: summary,
    toCloud: diffSummary(mergedIndex, remoteIndex),
    conflicts: result.conflicts.slice(0, 50),
    conflictCount: result.conflicts.length,
    guard,
    wouldChange: !isEmptyPlan(summary) || !isEmptyDiff(diffSummary(mergedIndex, remoteIndex)),
    preview: {
      creates: plan.creates.slice(0, 20).map((c) => ({ title: c.title, url: c.url, type: c.type })),
      updates: plan.updates.slice(0, 20).map((u) => ({ nodeId: u.nodeId })),
      deletes: plan.deletes.slice(0, 20).map((d) => ({ title: d.title, type: d.type }))
    }
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

export async function sync({ reason = 'manual', token, settings } = {}) {
  const lock = await acquireLock();
  if (!lock) {
    return { ok: false, skipped: true, reason: 'locked', message: '另一个同步任务正在进行' };
  }
  const startedAt = Date.now();
  try {
    const s = settings || (await getSettings());
    const deviceId = await ensureDeviceId();
    const { backend } = backendFor(s);
    const auth = token || (await resolveToken(s));
    const cfg = backend.cfgFromSettings(s);
    const state = (await loadState()) || { ...defaultState(deviceId), baseIndex: new Map(), mapping: new Map() };
    clearRootParentCache();

    /* 1) 扫描本地，并给"相对上次同步有变化"的节点盖时间戳 */
    const local = await scanLocal({ mapping: state.mapping, deviceId });
    const stamped = stampLocalChanges(normalizeIndices(local.nodes), state.seen);
    const localIndex = filterExcluded(stamped.index, s.excludeFolders);
    const localHash = hashTree(localIndex);

    /* 2) 读取云端 */
    let remote = await readRemote({ token: auth, settings: s });

    /* 3) 首次引导：云端没有文档 -> 用本地树建立初始文档 */
    if (!remote.exists) {
      logger.info('云端暂无同步文档，使用本机书签初始化');
      const doc = createDoc({ nodes: localIndex, revision: 1, writer: deviceId });
      await saveLocalSnapshot({ index: localIndex, kind: SNAPSHOT_KIND.PRE_PUSH, deviceId, reason: '初始化上传' });
      const created = await backend.writeDoc(cfg, serializeDoc(doc), {
        token: auth,
        message: 'chore(bcs): initial bookmarks sync (r1)'
      });
      await saveRemoteSnapshot({
        index: localIndex,
        kind: SNAPSHOT_KIND.PRE_PUSH,
        deviceId,
        reason: '初始化上传',
        revision: 1,
        token: auth,
        settings: s
      });
      const next = {
        ...state,
        deviceId,
        fileId: created.fileId || '',
        etag: '',
        revision: 1,
        lastSyncAt: Date.now(),
        lastLocalHash: localHash,
        baseIndex: localIndex,
        mapping: local.mapping,
        seen: rebuildSeen(localIndex),
        pending: null,
        conflicts: [],
        stats: { creates: 0, updates: 0, moves: 0, deletes: 0 },
        lastError: ''
      };
      await saveState(next);
      logger.success('初始化完成：已上传 ' + localIndex.size + ' 个节点到 Google Drive');
      return {
        ok: true,
        bootstrapped: true,
        direction: 'initial-upload',
        deviceId,
        revision: 1,
        merged: docStats({ nodes: localIndex, revision: 1, updatedAt: Date.now() }),
        toLocal: { creates: 0, moves: 0, updates: 0, deletes: 0 },
        toCloud: diffSummary(localIndex, new Map()),
        conflicts: [],
        durationMs: Date.now() - startedAt,
        reason
      };
    }

    /* 4) 三方合并（带重试：云端被别的设备抢先写入时重来） */
    let mergedIndex = null;
    let remoteIndex = null;
    let mergeResult = null;
    let uploaded = null;
    let attempt = 0;

    while (attempt < MAX_CLOUD_RETRY) {
      attempt++;
      remoteIndex = filterExcluded(remote.doc.nodes, s.excludeFolders);
      const base = filterExcluded(state.baseIndex instanceof Map ? state.baseIndex : new Map(), s.excludeFolders);
      mergeResult = mergeDocs({
        base,
        local: localIndex,
        remote: remoteIndex,
        deviceId,
        policy: mergePolicy(s)
      });
      mergedIndex = normalizeIndices(mergeResult.merged);

      const cloudDiff = diffSummary(mergedIndex, remoteIndex);
      if (isEmptyDiff(cloudDiff)) {
        uploaded = null;
        break;
      }

      /* 5) 写云端（先快照，再写） */
      const nextRevision = Math.max(remote.doc.revision || 0, state.revision || 0) + 1;
      const doc = createDoc({ nodes: mergedIndex, revision: nextRevision, writer: deviceId, createdAt: remote.doc.createdAt });
      const body = serializeDoc(doc);

      await saveLocalSnapshot({ index: remoteIndex, kind: SNAPSHOT_KIND.PRE_PUSH, deviceId, reason: '推送云端前' });

      try {
        const res = await backend.writeDoc(cfg, body, {
          token: auth,
          version: remote.etag,
          message: 'chore(bcs): sync bookmarks r' + nextRevision + ' (' + deviceId.slice(0, 10) + ')'
        });
        uploaded = { revision: nextRevision, fileId: res.fileId || remote.fileId, diff: cloudDiff, version: res.version || '' };
        state.fileId = res.fileId || remote.fileId;
        logger.success('已推送云端 r' + nextRevision + '（+' + cloudDiff.created + ' ~' + cloudDiff.updated + ' -' + cloudDiff.deleted + '）');
        await saveRemoteSnapshot({
          index: mergedIndex,
          kind: SNAPSHOT_KIND.PRE_SYNC,
          deviceId,
          reason: '推送云端 r' + nextRevision,
          revision: nextRevision,
          token: auth
        });
        break;
      } catch (err) {
        if (isConflict(err) && attempt < MAX_CLOUD_RETRY) {
          logger.warn('云端已被其它设备更新（' + (err.code || err.status) + '），重新读取并合并（第 ' + attempt + ' 次）');
          remote = await readRemote({ token: auth, settings: s });
          if (!remote.exists) throw new Error('云端文档在合并过程中被删除');
          continue;
        }
        throw err;
      }
    }

    if (!mergedIndex) throw new Error('合并失败：未生成结果');

    /* 6) 应用到本地 */
    const plan = planLocalApply({ merged: mergedIndex, local: localIndex, chromeIdOf: local.mapping });
    const guard = deleteGuard(plan, s, countActive(localIndex));

    if (guard.blocked) {
      logger.warn(guard.reason);
      const next = {
        ...state,
        deviceId,
        fileId: remote.fileId,
        revision: uploaded ? uploaded.revision : remote.doc.revision,
        etag: '',
        lastSyncAt: Date.now(),
        lastLocalHash: localHash,
        baseIndex: state.baseIndex instanceof Map ? state.baseIndex : new Map(),
        mapping: local.mapping,
        seen: stamped.seen,
        pending: {
          createdAt: Date.now(),
          reason: guard.reason,
          summary: planLocalSummary(plan),
          guard,
          plan: {
            creates: plan.creates,
            updates: plan.updates,
            moves: plan.moves,
            deletes: plan.deletes
          },
          /* 关键：把合并结果（含墓碑）一起存下来。
           * 用户确认后，如果只拿"重扫后的本机树"当新 base，被删节点在 base 里
           * 就完全不存在（既没有活节点也没有墓碑），下一轮三方合并会把它当成
           * "base 没有 -> 按远端新增" 处理，于是删掉的书签又复活了。 */
          mergedNodes: indexToNodes(mergedIndex),
          mergedRevision: uploaded ? uploaded.revision : remote.doc.revision
        },
        conflicts: mergeResult.conflicts.slice(0, 40),
        stats: planLocalSummary(plan),
        lastError: guard.reason
      };
      await saveState(next);
      return {
        ok: false,
        blocked: true,
        reason: 'delete-guard',
        message: guard.reason,
        pending: next.pending,
        conflicts: mergeResult.conflicts.slice(0, 20),
        durationMs: Date.now() - startedAt
      };
    }

    let applied = { created: 0, updated: 0, moved: 0, deleted: 0, errors: [], mapping: local.mapping };
    if (!isEmptyPlan(planLocalSummary(plan))) {
      await saveLocalSnapshot({ index: localIndex, kind: SNAPSHOT_KIND.PRE_SYNC, deviceId, reason: '应用本地变更前' });
      applied = await applyLocalPlan({ plan, mapping: local.mapping, deviceId, protectedIds: local.protectedIds });
    }

    /* 7) 收尾：重新扫描，保证映射/newBase 与真实状态一致 */
    let finalIndex = mergedIndex;
    let finalMapping = applied.mapping instanceof Map ? applied.mapping : local.mapping;
    if (applied.created || applied.deleted || applied.moved || applied.updated) {
      const rescan = await scanLocal({ mapping: finalMapping, deviceId });
      finalIndex = normalizeIndices(rescan.nodes);
      finalMapping = rescan.mapping;
      const drift = diffSummary(finalIndex, mergedIndex);
      if (!isEmptyDiff(drift)) {
        logger.debug('落地后重扫仍有漂移', drift);
      }
    } else {
      finalMapping = await refreshMapping(finalMapping).catch(() => finalMapping);
    }

    const nextRevision = uploaded ? uploaded.revision : remote.doc.revision;
    const next = {
      deviceId,
      fileId: remote.fileId,
      etag: '',
      revision: nextRevision,
      lastSyncAt: Date.now(),
      lastLocalHash: hashTree(finalIndex),
      baseIndex: finalIndex,
      mapping: finalMapping,
      seen: rebuildSeen(finalIndex),
      pending: null,
      conflicts: mergeResult.conflicts.slice(0, 40),
      stats: planLocalSummary(plan),
      lastError: ''
    };
    await saveState(next);
    await pruneLocalSnapshots(s.localHistoryKeep || 30).catch(() => 0);

    const durationMs = Date.now() - startedAt;
    if (applied.errors && applied.errors.length) {
      logger.warn('同步完成但本地有 ' + applied.errors.length + ' 个失败项', applied.errors.slice(0, 5));
    } else {
      logger.success(
        '同步完成：本地 +' + applied.created + ' ~' + applied.updated + ' ↔' + applied.moved + ' -' + applied.deleted +
          '；冲突 ' + mergeResult.conflicts.length + '；耗时 ' + durationMs + 'ms'
      );
    }

    return {
      ok: true,
      deviceId,
      revision: nextRevision,
      pushed: !!uploaded,
      pushedDiff: uploaded ? uploaded.diff : null,
      toLocal: { created: applied.created, updated: applied.updated, moved: applied.moved, deleted: applied.deleted },
      toCloud: uploaded ? uploaded.diff : { created: 0, updated: 0, deleted: 0, moved: 0, restored: 0 },
      conflicts: mergeResult.conflicts.slice(0, 40),
      conflictCount: mergeResult.conflicts.length,
      guarded: guard,
      errors: applied.errors || [],
      merged: docStats({ nodes: finalIndex, revision: nextRevision, updatedAt: Date.now() }),
      durationMs,
      reason
    };
  } catch (err) {
    logger.error('同步失败：' + err.message, err);
    const state = (await loadState()) || { ...defaultState('unknown'), baseIndex: new Map(), mapping: new Map() };
    await saveState({ ...state, lastError: err.message }).catch(() => {});
    return { ok: false, error: err.message, code: err.code || 'SYNC_FAILED' };
  } finally {
    await releaseLock(lock);
  }
}

/** 应用 pending 计划（用户在弹窗里点了「确认删除」） */
export async function applyPendingSync({ token } = {}) {
  const state = await loadState();
  if (!state || !state.pending) return { ok: false, error: '没有等待确认的操作' };
  const s = await getSettings();
  const auth = token || (await requireToken());
  const pending = state.pending;
  const local = await scanLocal({ mapping: state.mapping, deviceId: state.deviceId });
  const localIndex = normalizeIndices(local.nodes);

  const plan = {
    creates: pending.plan.creates || [],
    updates: pending.plan.updates || [],
    moves: pending.plan.moves || [],
    deletes: pending.plan.deletes || [],
    notes: []
  };

  await saveLocalSnapshot({ index: localIndex, kind: SNAPSHOT_KIND.PRE_SYNC, deviceId: state.deviceId, reason: '用户确认删除前' });
  const applied = await applyLocalPlan({ plan, mapping: local.mapping, deviceId: state.deviceId, protectedIds: local.protectedIds });

  const rescan = await scanLocal({ mapping: applied.mapping, deviceId: state.deviceId });
  const localAfter = normalizeIndices(rescan.nodes);

  /* base = 合并结果（含墓碑）+ 落地实况，详见 buildBaseAfterPending 的注释 */
  const baseIndex = buildBaseAfterPending({ mergedNodes: pending.mergedNodes || [], localAfter });

  await saveState({
    ...state,
    baseIndex,
    mapping: rescan.mapping,
    seen: rebuildSeen(localAfter),
    pending: null,
    lastSyncAt: Date.now(),
    lastLocalHash: hashTree(localAfter),
    lastError: ''
  });
  logger.success('已执行待确认操作：-' + applied.deleted + ' 删除，错误 ' + applied.errors.length);
  return { ok: true, applied: { created: applied.created, updated: applied.updated, moved: applied.moved, deleted: applied.deleted }, errors: applied.errors };
}

export async function cancelPending() {
  const state = await loadState();
  if (!state) return { ok: true };
  await saveState({ ...state, pending: null, lastError: '' });
  logger.info('已取消待确认的删除操作');
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

export function hashTree(index) {
  const list = indexToNodes(index instanceof Map ? index : nodesToIndex(index));
  const parts = list.map((n) => n.id + '|' + (n.deleted ? 1 : 0) + '|' + n.parentId + '|' + n.index + '|' + n.title + '|' + n.url);
  return hashString(parts.join('\n')) + ':' + list.length;
}

export async function getStatus() {
  const state = await loadState();
  const s = await getSettings();
  const backend = await backendStatus(s);
  const token = await peekTokenFor(s);
  const connected = !!(backend.configured && token);

  if (!state) {
    return {
      initialized: false,
      backend: backend.backend,
      backendLabel: backend.label,
      target: backend.target,
      configured: backend.configured,
      authorized: !!token,
      connected,
      account: backend.account || s.account,
      settings: s,
      deviceId: '',
      lastSyncAt: 0,
      pending: null,
      conflicts: [],
      stats: null
    };
  }
  return {
    initialized: true,
    backend: backend.backend,
    backendLabel: backend.label,
    target: backend.target,
    configured: backend.configured,
    authorized: !!token,
    connected,
    account: backend.account || s.account,
    deviceId: state.deviceId,
    fileId: state.fileId,
    revision: state.revision,
    lastSyncAt: state.lastSyncAt,
    lastLocalHash: state.lastLocalHash,
    lastError: state.lastError,
    pending: state.pending
      ? { createdAt: state.pending.createdAt, reason: state.pending.reason, summary: state.pending.summary, deletes: (state.pending.plan.deletes || []).slice(0, 30) }
      : null,
    conflicts: (state.conflicts || []).slice(0, 20),
    stats: state.stats || null,
    settings: s,
    baseCount: (state.baseNodes || []).length
  };
}

/* ------------------------------------------------------------------ *
 * 快照恢复
 * ------------------------------------------------------------------ */

/**
 * 恢复到指定快照。流程：
 *  1. 先给"当前状态"打一份 restore 快照（后悔药）；
 *  2. 用快照节点集合替换本地书签（保留永久文件夹）；
 *  3. 清空同步基线，下一次 sync 会以恢复后的本地树为准重新合并。
 */
export async function restoreSnapshot({ source = 'local', id, token, mode = 'replace' } = {}) {
  const s = await getSettings();
  const deviceId = await ensureDeviceId();
  const auth = token || (await resolveToken(s));

  const snap = await loadSnapshotNodes({ id, source, token: auth });
  const targetIndex = normalizeIndices(snap.nodes);

  const current = await scanLocal({ mapping: (await loadState())?.mapping, deviceId });
  await saveLocalSnapshot({ index: normalizeIndices(current.nodes), kind: SNAPSHOT_KIND.RESTORE, deviceId, reason: '恢复前自动备份' });

  if (mode === 'replace') {
    await clearLocalBookmarks();
    await resolveRootParent(true); // 热一下书签栏 id 缓存
    const liveIndex = new Map(Array.from(targetIndex).filter(([, n]) => !n.deleted));
    const plan = planLocalApply({ merged: liveIndex, local: new Map(), chromeIdOf: new Map() });
    const applied = await applyLocalPlan({ plan, mapping: new Map(), deviceId, protectedIds: new Set() });

    const rescan = await scanLocal({ mapping: applied.mapping, deviceId });
    const restoredIndex = normalizeIndices(rescan.nodes);
    await saveState({
      ...defaultState(deviceId),
      baseIndex: new Map(),
      mapping: rescan.mapping,
      seen: rebuildSeen(restoredIndex),
      pending: null,
      lastSyncAt: Date.now(),
      lastError: ''
    });
    clearRootParentCache();
    logger.success('已从快照恢复（覆盖模式）：' + restoredIndex.size + ' 个节点，错误 ' + applied.errors.length);
    return { ok: true, restored: restoredIndex.size, errors: applied.errors, mode };
  }

  // merge 模式：把快照当作"远端"再合并一次，不删现有内容
  const state = await loadState();
  const base = state?.baseIndex instanceof Map ? state.baseIndex : new Map();
  const localIndex = normalizeIndices(current.nodes);
  const merged = mergeDocs({ base, local: localIndex, remote: targetIndex, deviceId, policy: { deleteConflict: 'keep' } });
  const plan = planLocalApply({ merged: normalizeIndices(merged.merged), local: localIndex, chromeIdOf: current.mapping });
  const applied = await applyLocalPlan({ plan, mapping: current.mapping, deviceId, protectedIds: current.protectedIds });
  const rescan = await scanLocal({ mapping: applied.mapping, deviceId });
  const mergedFinal = normalizeIndices(rescan.nodes);
  await saveState({
    ...defaultState(deviceId),
    baseIndex: new Map(),
    mapping: rescan.mapping,
    seen: rebuildSeen(mergedFinal),
    lastSyncAt: Date.now()
  });
  logger.success('已合并快照：+' + applied.created + ' ~' + applied.updated);
  return { ok: true, restored: applied.created, errors: applied.errors, mode };
}

/** 重置同步状态（保留云端与本地书签，只丢弃基线，强制下次全量合并） */
export async function resetSyncState() {
  const deviceId = await ensureDeviceId();
  const state = await loadState();
  await saveState({
    ...defaultState(deviceId),
    mapping: state?.mapping || new Map(),
    baseIndex: new Map(),
    pending: null
  });
  logger.warn('已重置同步基线，下次同步将重新比较全量');
  return { ok: true };
}

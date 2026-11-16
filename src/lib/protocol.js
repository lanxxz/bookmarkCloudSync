/**
 * 同步协议 & 三方合并（纯函数，可在 Node 下单元测试）。
 *
 * 云端文档（Google Drive appDataFolder / bookmarks.json）结构：
 * {
 *   schemaVersion: 2,
 *   revision: 12,                     // 每次写入 +1，用于乐观并发
 *   writer: 'device-xxxx',
 *   updatedAt: 1730000000000,
 *   createdAt: 1729000000000,
 *   nodes: [ { id, parentId, type, title, url, index, deleted, updatedAt, deviceId } ]
 * }
 *
 * 关键点：
 *  - id 是同步层自己的稳定 ID，和 Chrome 本地 bookmarks 的 id 无关；
 *  - 删除不直接消失，而是节点打上 deleted=true + deletedAt（墓碑），
 *    墓碑默认保留 90 天，保证「A 删除 / B 离线」这种场景不会复活；
 *  - 合并是 base(上次同步结果) / local(本机当前) / remote(云端当前) 三方合并；
 *  - 删除 vs 修改的冲突默认“保留内容”（resurrect），因为误删的代价远高于多一条记录。
 */

export const SCHEMA_VERSION = 2;
export const ROOT_NODE_ID = 'root';
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const NODE_MERGE_FIELDS = ['title', 'url', 'parentId', 'index', 'deleted'];

export const NODE_TYPE = Object.freeze({ FOLDER: 'folder', BOOKMARK: 'bookmark' });

export const CONFLICT_KIND = Object.freeze({
  DELETE_VS_MODIFY: 'delete-vs-modify',
  FIELD: 'field',
  DUPLICATE_ID: 'duplicate-id',
  ORPHAN: 'orphan',
  CYCLE: 'cycle'
});

/* ------------------------------------------------------------------ *
 * 节点构造与比较
 * ------------------------------------------------------------------ */

export function makeNode(input) {
  const type = input.type === NODE_TYPE.FOLDER ? NODE_TYPE.FOLDER : NODE_TYPE.BOOKMARK;
  return {
    id: String(input.id),
    parentId: input.parentId == null ? null : String(input.parentId),
    type,
    title: typeof input.title === 'string' ? input.title : '',
    url: type === NODE_TYPE.BOOKMARK ? (typeof input.url === 'string' ? input.url : '') : '',
    index: Number.isFinite(input.index) ? input.index : 0,
    deleted: !!input.deleted,
    deletedAt: input.deletedAt || (input.deleted ? input.updatedAt || 0 : 0),
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
    deviceId: input.deviceId || ''
  };
}

export function isFolder(node) {
  return node && node.type === NODE_TYPE.FOLDER;
}

export function nodeEqual(a, b) {
  if (!a || !b) return a === b;
  return (
    a.parentId === b.parentId &&
    a.type === b.type &&
    a.title === b.title &&
    a.url === b.url &&
    a.index === b.index &&
    !!a.deleted === !!b.deleted
  );
}

/** 只比较内容，不比较顺序（用于判断“是否被改过”） */
export function nodeContentEqual(a, b) {
  if (!a || !b) return a === b;
  return a.parentId === b.parentId && a.type === b.type && a.title === b.title && a.url === b.url && !!a.deleted === !!b.deleted;
}

export function changedFields(a, b) {
  const out = [];
  for (const f of NODE_MERGE_FIELDS) {
    if (a[f] !== b[f] || !!a[f] !== !!b[f]) {
      if (typeof a[f] === 'boolean' || typeof b[f] === 'boolean') {
        if (!!a[f] !== !!b[f]) out.push(f);
      } else if (a[f] !== b[f]) out.push(f);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 集合 <-> Map
 * ------------------------------------------------------------------ */

export function nodesToIndex(nodes) {
  const index = new Map();
  for (const raw of nodes || []) {
    if (!raw || raw.id == null) continue;
    const node = makeNode(raw);
    if (node.id === ROOT_NODE_ID) continue;
    index.set(node.id, node);
  }
  return index;
}

/** 稳定排序：parentId -> index -> id，保证同一个集合序列化后字节一致 */
export function indexToNodes(index) {
  const list = Array.from(index.values());
  list.sort((a, b) => {
    const pa = a.parentId || '';
    const pb = b.parentId || '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    if (a.index !== b.index) return a.index - b.index;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return list;
}

/**
 * 把同一父节点下的 index 重新压成 0..n-1 的稠密序号。
 *
 * 为什么必须做：Chrome 的 index 是"位置"，插入一个书签会让后面所有兄弟节点的
 * index 全部 +1。如果直接比对原始 index，两台设备都会认为"所有节点都被移动了"，
 * 每次同步都产生海量假冲突。压成稠密序号后，只要相对顺序一致，序号就一致。
 */
export function normalizeIndices(index) {
  const byParent = new Map();
  for (const [id, node] of index) {
    const key = node.parentId || rootKey;
    let list = byParent.get(key);
    if (!list) {
      list = [];
      byParent.set(key, list);
    }
    list.push(node);
  }
  const out = new Map();
  for (const list of byParent.values()) {
    list.sort((a, b) => a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      out.set(node.id, node.index === i ? node : { ...node, index: i });
    }
  }
  return out;
}

const rootKey = '__root__';

/* ------------------------------------------------------------------ *
 * 文档序列化 / 解析 / 校验
 * ------------------------------------------------------------------ */

export function createDoc({ nodes, revision = 1, writer = '', createdAt, updatedAt } = {}) {
  const ts = updatedAt || Date.now();
  const index = nodes instanceof Map ? nodes : nodesToIndex(nodes);
  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    writer,
    createdAt: createdAt || ts,
    updatedAt: ts,
    nodes: indexToNodes(index).map(stripRuntimeFields)
  };
}

function stripRuntimeFields(node) {
  return {
    id: node.id,
    parentId: node.parentId,
    type: node.type,
    title: node.title,
    url: node.url,
    index: node.index,
    deleted: node.deleted ? true : false,
    deletedAt: node.deleted ? node.deletedAt || node.updatedAt || 0 : 0,
    updatedAt: node.updatedAt,
    deviceId: node.deviceId || ''
  };
}

export function serializeDoc(doc) {
  return JSON.stringify(doc);
}

/**
 * 解析云端文档。
 *
 * 除了"能不能用"，还必须回答"坏在哪"：之前只抛 invalid-doc，
 * 用户看到的是一句没有任何信息量的话，只能干瞪眼。
 *
 * repair 默认开启，只兜三种"容器错了但数据还在自身格式里"的历史产物：
 *   1. 裸数组          [ {id,...}, ... ]        有人直接把 nodes 序列化了
 *   2. 对象当 Map      { nodes: { id: node } }   Map 被 JSON.stringify 掉了
 *   3. 多包一层        { ok:true, doc:{...} }    把 parse 结果整个存了下来
 * 以及 nodes 为 null 的空文档。形状不像我们的节点就一律不修，绝不瞎猜。
 */
export function docFromJson(text, { repair = true } = {}) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(stripBom(text)) : text;
  } catch (err) {
    return {
      ok: false,
      error: 'invalid-json',
      detail: String(err && err.message),
      preview: previewOf(text),
      shape: typeof text
    };
  }

  let repaired = null;
  if (repair) {
    const fixed = repairShape(data);
    if (fixed) {
      data = fixed.doc;
      repaired = fixed.how;
    }
  }

  const errors = validateDoc(data);
  if (errors.length) {
    return {
      ok: false,
      error: 'invalid-doc',
      errors,
      preview: previewOf(text),
      shape: describeShape(data)
    };
  }

  const out = { ok: true, doc: normalizeDoc(data) };
  if (repaired) out.repaired = repaired;
  return out;
}

/** 去掉 UTF-8 BOM：从某些编辑器/工具导出的文件会带，JSON.parse 直接失败 */
function stripBom(text) {
  if (typeof text !== 'string') return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function previewOf(text) {
  const s = typeof text === 'string' ? text : String(text);
  return s.slice(0, 240);
}

/** 给人类看的结构摘要：object{nodes:array(12),schemaVersion:number} */
export function describeShape(data) {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array(' + data.length + ')';
  if (typeof data !== 'object') return typeof data;
  const parts = [];
  for (const key of Object.keys(data).slice(0, 6)) {
    const v = data[key];
    const kind = Array.isArray(v) ? 'array(' + v.length + ')' : v === null ? 'null' : typeof v;
    parts.push(key + ':' + kind);
  }
  return 'object{' + parts.join(',') + '}';
}

export function looksLikeNode(n) {
  return !!n && typeof n === 'object' && typeof n.id === 'string' && n.id.length > 0 && typeof n.type === 'string';
}

function repairShape(data) {
  // 1. 裸数组
  if (Array.isArray(data)) {
    if (!data.length || data.some(looksLikeNode)) {
      return { doc: { schemaVersion: SCHEMA_VERSION, revision: 0, nodes: data }, how: 'bare-array' };
    }
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  // 2. 多包一层 { ok, doc } / { doc }
  const inner = data.doc;
  if (inner && typeof inner === 'object' && inner.nodes !== undefined) {
    return { doc: inner, how: 'unwrapped-doc' };
  }

  // 3. Map 被序列化成普通对象
  if (data.nodes && typeof data.nodes === 'object' && !Array.isArray(data.nodes)) {
    const values = Object.values(data.nodes);
    if (!values.length || values.some(looksLikeNode)) {
      return { doc: { ...data, nodes: values }, how: 'map-object' };
    }
    return null;
  }

  // 4. nodes 显式为 null / undefined
  if (data.nodes === null || data.nodes === undefined) {
    const rest = Object.keys(data).filter((k) => k !== 'nodes');
    if (rest.length) return { doc: { ...data, nodes: [] }, how: 'null-nodes' };
  }

  return null;
}

export function validateDoc(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['doc 不是对象'];
  if (Array.isArray(data)) return ['doc 是数组，不是对象'];
  if (!Number.isFinite(data.schemaVersion)) errors.push('缺少 schemaVersion');
  else if (data.schemaVersion > SCHEMA_VERSION) errors.push('云端 schemaVersion=' + data.schemaVersion + ' 高于本扩展支持的 ' + SCHEMA_VERSION + '，请升级扩展');
  if (!Array.isArray(data.nodes)) {
    errors.push('nodes 不是数组（实际是 ' + (data.nodes === null ? 'null' : typeof data.nodes) + '）');
  } else {
    if (data.nodes.length > 500000) errors.push('nodes 数量异常：' + data.nodes.length);
    if (data.nodes.length && !data.nodes.some(looksLikeNode)) {
      errors.push('nodes 里的元素不像书签节点（缺少 id / type）');
    }
  }
  return errors;
}

export function normalizeDoc(data) {
  return {
    schemaVersion: Number(data.schemaVersion) || SCHEMA_VERSION,
    revision: Number(data.revision) || 0,
    writer: data.writer || '',
    createdAt: Number(data.createdAt) || 0,
    updatedAt: Number(data.updatedAt) || 0,
    nodes: nodesToIndex(data.nodes)
  };
}

export function docStats(doc) {
  const index = doc.nodes instanceof Map ? doc.nodes : nodesToIndex(doc.nodes);
  let folders = 0;
  let bookmarks = 0;
  let tombstones = 0;
  for (const n of index.values()) {
    if (n.deleted) tombstones++;
    else if (n.type === NODE_TYPE.FOLDER) folders++;
    else bookmarks++;
  }
  return { total: index.size, folders, bookmarks, tombstones, revision: doc.revision || 0, updatedAt: doc.updatedAt || 0 };
}

/* ------------------------------------------------------------------ *
 * 墓碑 & 树修复
 * ------------------------------------------------------------------ */

/** 清理过期墓碑；protectedIds 中的节点永不清理 */
export function pruneTombstones(index, { now = Date.now(), ttl = TOMBSTONE_TTL_MS, protectedIds } = {}) {
  const keep = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  const out = new Map(index);
  let removed = 0;
  for (const [id, node] of index) {
    if (!node.deleted) continue;
    if (keep.has(id)) continue;
    const at = node.deletedAt || node.updatedAt || 0;
    if (now - at > ttl) {
      out.delete(id);
      removed++;
    }
  }
  return { index: out, removed };
}

/**
 * 排除指定标题的文件夹及其整棵子树。
 * 必须在 local / remote / base 三份集合上同时过滤：
 * 只过滤本地会让云端误判成"本地删除了这个文件夹"，从而把云端也删掉。
 */
export function filterExcluded(index, titles) {
  const wanted = new Set((titles || []).map((t) => String(t).trim()).filter(Boolean));
  if (!wanted.size) return index;
  const drop = new Set();
  for (const [id, node] of index) {
    if (wanted.has(node.title)) drop.add(id);
  }
  if (!drop.size) return index;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, node] of index) {
      if (drop.has(id)) continue;
      if (node.parentId && drop.has(node.parentId)) {
        drop.add(id);
        grew = true;
      }
    }
  }
  const out = new Map();
  for (const [id, node] of index) {
    if (!drop.has(id)) out.set(id, node);
  }
  return out;
}

/** 树自检：父节点丢失/类型不对/成环 -> 重挂到 root（或最近的可用祖先） */
export function repairTree(index, { rootId = ROOT_NODE_ID, deviceId = '', now = Date.now() } = {}) {
  const out = new Map(index);
  const fixes = [];
  const byId = out;

  const isUsableParent = (pid) => {
    if (pid == null || pid === rootId) return true;
    const p = byId.get(pid);
    return !!p && !p.deleted && p.type === NODE_TYPE.FOLDER;
  };

  for (const [id, node] of byId) {
    if (node.deleted) continue;
    if (!isUsableParent(node.parentId)) {
      const patched = { ...node, parentId: rootId, updatedAt: Math.max(node.updatedAt, now), deviceId: node.deviceId || deviceId };
      byId.set(id, patched);
      fixes.push({ id, kind: CONFLICT_KIND.ORPHAN, from: node.parentId, to: rootId });
    }
  }

  /* 成环检测：自底向上做一次"能否到达 root"的可达性分析。
   * 必须先把所有节点的状态算完再改，否则边修边判会让环上的其它节点"看不见"环。 */
  const state = new Map(); // id -> 'ok' | 'cycle' | 'unknown'
  const reachesRoot = (startId) => {
    const path = [];
    const inPath = new Set();
    let cur = startId;
    let verdict = 'unknown';
    while (cur && cur !== rootId) {
      const cached = state.get(cur);
      if (cached) {
        verdict = cached;
        break;
      }
      if (inPath.has(cur)) {
        verdict = 'cycle';
        break;
      }
      inPath.add(cur);
      path.push(cur);
      const p = byId.get(cur);
      if (!p) {
        verdict = 'ok'; // 父链断在外部 -> 由 orphan 分支处理
        break;
      }
      cur = p.parentId;
    }
    if (cur === rootId) verdict = 'ok';
    for (const id of path) state.set(id, verdict);
    return verdict;
  };

  const cyclic = [];
  for (const [id, node] of byId) {
    if (node.deleted) continue;
    if (reachesRoot(id) === 'cycle') cyclic.push(id);
  }
  for (const id of cyclic) {
    const node = byId.get(id);
    byId.set(id, { ...node, parentId: rootId, updatedAt: Math.max(node.updatedAt, now), deviceId: node.deviceId || deviceId });
    fixes.push({ id, kind: CONFLICT_KIND.CYCLE, to: rootId });
  }
  return { index: byId, fixes };
}

/* ------------------------------------------------------------------ *
 * 三方合并
 * ------------------------------------------------------------------ */

/**
 * base  : 上次成功同步后的合并结果（云端与本地一致的快照）
 * local : 本机浏览器的当前状态（含本机墓碑）
 * remote: 云端当前文档（含云端墓碑）
 *
 * 返回 { merged(Map), conflicts[], stats }
 */
export function mergeDocs({ base, local, remote, rootId = ROOT_NODE_ID, deviceId = '', policy = {}, now = Date.now() }) {
  const b = base instanceof Map ? base : nodesToIndex(base);
  const l = local instanceof Map ? local : nodesToIndex(local);
  const r = remote instanceof Map ? remote : nodesToIndex(remote);

  const deleteConflict = policy.deleteConflict === 'delete' ? 'delete' : 'keep';
  const fieldConflict = policy.fieldConflict === 'local' || policy.fieldConflict === 'remote' ? policy.fieldConflict : 'latest';
  const tombstoneTtl = Number.isFinite(policy.tombstoneTtlMs) ? policy.tombstoneTtlMs : TOMBSTONE_TTL_MS;

  const merged = new Map();
  const conflicts = [];
  const stats = { created: 0, updated: 0, deleted: 0, restored: 0, moved: 0, conflicts: 0, unchanged: 0 };

  const ids = new Set();
  for (const k of b.keys()) ids.add(k);
  for (const k of l.keys()) ids.add(k);
  for (const k of r.keys()) ids.add(k);

  const pushConflict = (kind, id, detail) => {
    conflicts.push({ kind, id, detail: detail || {}, at: now });
    stats.conflicts++;
  };

  const tombstoneOf = (node) =>
    makeNode({ ...node, deleted: true, deletedAt: now, updatedAt: Math.max(node.updatedAt, now), deviceId: node.deviceId || deviceId });

  for (const id of ids) {
    const bn = b.get(id);
    const ln = l.get(id);
    const rn = r.get(id);

    // 1) 两侧完全一致（含都删除）
    if (ln && rn && nodeEqual(ln, rn)) {
      merged.set(id, ln);
      if (bn && !nodeEqual(bn, ln)) stats.updated++;
      continue;
    }

    // 2) 双方都没有 -> 跳过
    if (!ln && !rn) {
      if (bn) {
        // 两边都删了，保留墓碑，避免离线设备复活
        merged.set(id, tombstoneOf(bn));
        stats.deleted++;
      }
      continue;
    }

    // 3) 新增（base 中没有）
    if (!bn) {
      if (ln && rn) {
        // 极端情况：两端生成了相同 id 但内容不同
        if (nodeContentEqual(ln, rn)) {
          merged.set(id, ln.updatedAt >= rn.updatedAt ? ln : rn);
        } else {
          const winner = ln.updatedAt >= rn.updatedAt ? ln : rn;
          merged.set(id, winner);
          pushConflict(CONFLICT_KIND.DUPLICATE_ID, id, { local: pick(ln), remote: pick(rn), kept: winner === ln ? 'local' : 'remote' });
        }
      } else {
        const node = ln || rn;
        merged.set(id, node);
        if (node.deleted) stats.deleted++;
        else stats.created++;
      }
      continue;
    }

    // 4) 只有一侧存在 = 另一侧删除
    if (!ln || !rn) {
      const survivor = ln || rn;
      const survivorIsLocal = !!ln;
      const baseNode = bn;
      const modified = !nodeContentEqual(survivor, baseNode);

      // 存活侧本身就是墓碑：原样保留，绝不重新盖时间戳（否则每轮都会写云端）
      if (survivor.deleted) {
        merged.set(id, survivor);
        stats.deleted++;
        continue;
      }
      if (!modified) {
        // 存活侧没动过 -> 尊重删除，并生成一份带时间戳的墓碑
        merged.set(id, tombstoneOf(survivor));
        stats.deleted++;
        continue;
      }
      // 一侧删除、另一侧修改过
      if (deleteConflict === 'delete') {
        merged.set(id, tombstoneOf(survivor));
        stats.deleted++;
        pushConflict(CONFLICT_KIND.DELETE_VS_MODIFY, id, {
          resolution: 'deleted',
          modifiedSide: survivorIsLocal ? 'local' : 'remote',
          title: survivor.title
        });
      } else {
        const keep = { ...survivor, deleted: false, deletedAt: 0, updatedAt: Math.max(survivor.updatedAt, baseNode.updatedAt), deviceId: survivor.deviceId || deviceId };
        merged.set(id, keep);
        stats.restored++;
        pushConflict(CONFLICT_KIND.DELETE_VS_MODIFY, id, {
          resolution: 'kept',
          modifiedSide: survivorIsLocal ? 'local' : 'remote',
          title: survivor.title,
          url: survivor.url
        });
      }
      continue;
    }

    // 5) 两侧都在，但内容不同
    const localDeleted = !!ln.deleted;
    const remoteDeleted = !!rn.deleted;

    // 5a) 一侧已删除（墓碑）、另一侧还活着：删除 vs 修改
    if (localDeleted !== remoteDeleted) {
      const survivor = localDeleted ? rn : ln;
      const survivorSide = localDeleted ? 'remote' : 'local';
      const modified = !nodeContentEqual(
        { ...survivor, deleted: false },
        { ...bn, deleted: false }
      );
      if (!modified || deleteConflict === 'delete') {
        merged.set(id, tombstoneOf(survivor));
        stats.deleted++;
        if (modified) {
          pushConflict(CONFLICT_KIND.DELETE_VS_MODIFY, id, {
            resolution: 'deleted',
            modifiedSide: survivorSide,
            title: survivor.title
          });
        }
        continue;
      }
      const keep = {
        ...survivor,
        deleted: false,
        deletedAt: 0,
        updatedAt: Math.max(survivor.updatedAt || 0, bn.updatedAt || 0, now),
        deviceId: survivor.deviceId || deviceId
      };
      merged.set(id, keep);
      stats.restored++;
      pushConflict(CONFLICT_KIND.DELETE_VS_MODIFY, id, {
        resolution: 'kept',
        modifiedSide: survivorSide,
        title: survivor.title,
        url: survivor.url
      });
      continue;
    }

    const localChanged = !nodeEqual(ln, bn);
    const remoteChanged = !nodeEqual(rn, bn);

    if (!localChanged && remoteChanged) {
      merged.set(id, rn);
      stats.updated++;
      continue;
    }
    if (localChanged && !remoteChanged) {
      merged.set(id, ln);
      stats.updated++;
      continue;
    }

    // 6) 真冲突：逐字段 LWW
    const resolved = resolveNodeConflict({ base: bn, local: ln, remote: rn, fieldConflict, now, deviceId });
    merged.set(id, resolved.node);
    if (resolved.fields.length) {
      pushConflict(CONFLICT_KIND.FIELD, id, {
        fields: resolved.fields,
        title: resolved.node.title,
        winner: resolved.winner
      });
    }
    if (resolved.node.deleted) stats.deleted++;
    else if (ln.deleted || rn.deleted) stats.restored++;
    else stats.updated++;
  }

  // 7) 结构修复 + 墓碑清理
  const repaired = repairTree(merged, { rootId, deviceId, now });
  for (const fix of repaired.fixes) {
    conflicts.push({ kind: fix.kind, id: fix.id, detail: fix, at: now });
    stats.conflicts++;
  }
  const pruned = pruneTombstones(repaired.index, { now, ttl: tombstoneTtl });

  return { merged: pruned.index, conflicts, stats, prunedTombstones: pruned.removed };
}

function pick(node) {
  return { title: node.title, url: node.url, parentId: node.parentId, deleted: !!node.deleted, updatedAt: node.updatedAt, deviceId: node.deviceId };
}

function resolveNodeConflict({ base, local, remote, fieldConflict, now, deviceId }) {
  const fields = [];
  const winnerSide = local.updatedAt === remote.updatedAt ? 'tie' : local.updatedAt > remote.updatedAt ? 'local' : 'remote';
  const out = { ...local };

  const decide = (field) => {
    const bv = base[field];
    const lv = local[field];
    const rv = remote[field];
    const lc = lv !== bv;
    const rc = rv !== bv;
    if (!lc && !rc) return bv;
    if (lc && !rc) return lv;
    if (!lc && rc) return rv;
    if (lv === rv) return lv;
    fields.push(field);
    if (fieldConflict === 'local') return lv;
    if (fieldConflict === 'remote') return rv;
    return local.updatedAt >= remote.updatedAt ? lv : rv;
  };

  out.title = decide('title');
  out.url = decide('url');
  out.parentId = decide('parentId');
  out.index = decide('index');
  out.type = local.type === remote.type ? local.type : remote.type;

  // deleted 单独处理：只要有一侧修改过内容，就不删
  const ld = !!local.deleted;
  const rd = !!remote.deleted;
  const bd = !!base.deleted;
  if (ld || rd) {
    const otherModified = ld ? !nodeContentEqual({ ...remote, deleted: false }, { ...base, deleted: false }) : !nodeContentEqual({ ...local, deleted: false }, { ...base, deleted: false });
    if (ld && rd) {
      out.deleted = true;
    } else if (otherModified) {
      out.deleted = false;
      fields.push('deleted');
      out.deletedAt = 0;
    } else {
      out.deleted = true;
    }
  } else {
    out.deleted = false;
  }
  if (out.deleted) {
    out.deletedAt = Math.max(local.deletedAt || 0, remote.deletedAt || 0, now);
  } else if (bd) {
    out.deletedAt = 0;
  }

  out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0, now);
  out.deviceId = deviceId || local.deviceId || remote.deviceId || '';
  out.id = local.id;
  return { node: makeNode(out), fields, winner: winnerSide };
}

/* ------------------------------------------------------------------ *
 * 差异统计 & 应用计划
 * ------------------------------------------------------------------ */

export function diffSummary(target, source) {
  const t = target instanceof Map ? target : nodesToIndex(target);
  const s = source instanceof Map ? source : nodesToIndex(source);
  const out = { created: 0, updated: 0, deleted: 0, moved: 0, restored: 0 };
  for (const [id, node] of t) {
    const prev = s.get(id);
    if (!prev) {
      out.created++;
      continue;
    }
    if (node.deleted && !prev.deleted) out.deleted++;
    else if (!node.deleted && prev.deleted) out.restored++;
    else if (!node.deleted) {
      if (prev.title !== node.title || prev.url !== node.url) out.updated++;
      if (prev.parentId !== node.parentId || prev.index !== node.index) out.moved++;
    }
  }
  for (const id of s.keys()) {
    if (!t.has(id)) out.deleted++;
  }
  return out;
}

export function isEmptyDiff(summary) {
  if (!summary) return true;
  return (
    (summary.created || 0) === 0 &&
    (summary.updated || 0) === 0 &&
    (summary.deleted || 0) === 0 &&
    (summary.moved || 0) === 0 &&
    (summary.restored || 0) === 0
  );
}

/** planLocalSummary 用的是复数键名，单独判断，避免和 diffSummary 混淆 */
export function isEmptyPlan(summary) {
  if (!summary) return true;
  return (
    (summary.creates || 0) === 0 &&
    (summary.updates || 0) === 0 &&
    (summary.moves || 0) === 0 &&
    (summary.deletes || 0) === 0
  );
}

/**
 * 用户确认待处理计划后，重建"下次同步的 base"。
 *
 * 为什么不能直接用重扫出的本机树当 base：
 *   被删掉的节点在本机已彻底不存在，既没有活节点也没有墓碑。
 *   如果 base 里也没有它，下一轮三方合并会判成"base 没有 -> 按远端新增"，
 *   刚删掉的书签就会被云端拉回来（复活 bug）。
 *
 * base = 合并结果（含墓碑）+ 落地实况：
 *   - 合并结果标记删除、但本机实际还在（落地失败）-> 以实况为准，保持活节点；
 *   - 合并结果没有、本机有的节点 -> 补进去（确认期间新加的书签）。
 */
export function buildBaseAfterPending({ mergedNodes, localAfter }) {
  const merged = mergedNodes instanceof Map ? mergedNodes : nodesToIndex(mergedNodes || []);
  const local = localAfter instanceof Map ? localAfter : nodesToIndex(localAfter || []);
  const out = new Map(merged);
  for (const [id, liveNode] of local) {
    const baseNode = out.get(id);
    if (baseNode && baseNode.deleted) {
      out.set(id, { ...liveNode, updatedAt: liveNode.updatedAt || baseNode.updatedAt || Date.now() });
    } else if (!baseNode) {
      out.set(id, liveNode);
    }
  }
  return out;
}

/** 计算节点相对 root 的深度，用于“先建父再建子”的顺序 */
export function depthOf(index, node, rootId = ROOT_NODE_ID) {
  let depth = 0;
  let cur = node;
  const seen = new Set();
  while (cur && cur.parentId && cur.parentId !== rootId && depth < 10000) {
    if (seen.has(cur.id)) return depth;
    seen.add(cur.id);
    cur = index.get(cur.parentId);
    depth++;
  }
  return depth + 1;
}

/**
 * 生成“把 merged 应用到本机浏览器”的操作列表。
 * chromeIdOf: Map<nodeId, chromeBookmarkId>
 */
export function planLocalApply({ merged, local, rootId = ROOT_NODE_ID, chromeIdOf }) {
  const m = merged instanceof Map ? merged : nodesToIndex(merged);
  const cur = local instanceof Map ? local : nodesToIndex(local);
  const idOf = chromeIdOf instanceof Map ? chromeIdOf : new Map();

  const creates = [];
  const moves = [];
  const updates = [];
  const deletes = [];
  const notes = [];

  for (const [id, node] of m) {
    const prev = cur.get(id);
    if (node.deleted) continue; // 墓碑不在本机创建
    const chromeId = idOf.get(id);
    if (!prev && !chromeId) {
      creates.push({ nodeId: id, parentNodeId: node.parentId, type: node.type, title: node.title, url: node.url, index: node.index, depth: depthOf(m, node, rootId) });
      continue;
    }
    if (prev && prev.deleted && chromeId) {
      // 复活：无法原地复活 Chrome 节点（已被删除），作为新建处理
      creates.push({ nodeId: id, parentNodeId: node.parentId, type: node.type, title: node.title, url: node.url, index: node.index, depth: depthOf(m, node, rootId), resurrect: true });
      continue;
    }
    if (!chromeId) {
      notes.push({ id, kind: 'missing-chrome-id' });
      continue;
    }
    if (prev && (prev.title !== node.title || prev.url !== node.url)) {
      updates.push({ nodeId: id, chromeId, patch: { title: node.title, ...(node.type === NODE_TYPE.BOOKMARK ? { url: node.url } : {}) } });
    }
    if (prev && (prev.parentId !== node.parentId || prev.index !== node.index)) {
      moves.push({ nodeId: id, chromeId, parentNodeId: node.parentId, index: node.index });
    }
  }

  // 删除：本机有、合并结果里是墓碑或已消失
  for (const [id, node] of cur) {
    if (node.deleted) continue;
    const after = m.get(id);
    const chromeId = idOf.get(id);
    if (!after || after.deleted) {
      if (chromeId) deletes.push({ nodeId: id, chromeId, title: node.title, type: node.type });
      else notes.push({ id, kind: 'delete-without-chrome-id' });
    }
  }

  creates.sort((a, b) => a.depth - b.depth || (a.parentNodeId || '').localeCompare(b.parentNodeId || '') || a.index - b.index);
  moves.sort((a, b) => depthOf(m, m.get(a.nodeId) || {}, rootId) - depthOf(m, m.get(b.nodeId) || {}, rootId));
  deletes.sort((a, b) => depthOf(cur, cur.get(b.nodeId) || {}, rootId) - depthOf(cur, cur.get(a.nodeId) || {}, rootId));

  return { creates, moves, updates, deletes, notes };
}

export function planLocalSummary(plan) {
  return {
    creates: plan.creates.length,
    moves: plan.moves.length,
    updates: plan.updates.length,
    deletes: plan.deletes.length,
    notes: plan.notes.length
  };
}

/**
 * Chrome / ego(lite) 书签适配层。
 *
 * 树模型约定（关键设计）：
 *   Chrome 的永久根节点 "0" 不能写入，它的直接子节点是「书签栏」「其他书签」「移动设备书签」。
 *   为了所有设备上的树完全一致，我们做了一层"压平"：
 *     - 「书签栏」(id 通常为 "1") 不产生节点，它的子节点直接挂到虚拟根 'root'；
 *     - 「其他书签」「移动设备书签」作为普通文件夹节点挂到 'root'，并被标记为系统节点（禁止删除/移动）；
 *     - 新建 parentId === 'root' 的节点，统一落在「书签栏」下面。
 *   这样任何设备扫出来的树拓扑都完全相同，不会因为永久文件夹 id 不同而反复触发 move。
 */
import { makeLocalId, mapLimit } from './util.js';
import { NODE_TYPE, ROOT_NODE_ID, makeNode } from './protocol.js';
import { logger } from './log.js';

/* ---------------- Promise 化封装 ---------------- */

function wrap(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn(...args, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    } catch (err) {
      reject(err);
    }
  });
}

export const bm = {
  getTree: () => wrap(chrome.bookmarks.getTree),
  getSubTree: (id) => wrap(chrome.bookmarks.getSubTree, id),
  get: (id) => wrap(chrome.bookmarks.get, id),
  create: (info) => wrap(chrome.bookmarks.create, info),
  update: (id, changes) => wrap(chrome.bookmarks.update, id, changes),
  move: (id, dest) => wrap(chrome.bookmarks.move, id, dest),
  remove: (id) => wrap(chrome.bookmarks.remove, id),
  removeTree: (id) => wrap(chrome.bookmarks.removeTree, id),
  search: (query) => wrap(chrome.bookmarks.search, query)
};

/* ---------------- 树解析 ---------------- */

/**
 * 解析 getTree 的结果，返回：
 *  { barId, rootChildren, protectedIds:Set<chromeId> }
 */
export function inspectTree(tree) {
  const root = Array.isArray(tree) ? tree[0] : tree;
  const children = (root && root.children) || [];
  let bar = children.find((c) => c.id === '1') || children[0] || null;
  const protectedIds = new Set(children.map((c) => c.id));
  return { root, barId: bar ? bar.id : '1', bar, siblings: children, protectedIds };
}

/* ---------------- 扫描 ---------------- */

/**
 * 把本机书签树转成同步节点集合。
 * @param {object} opts
 * @param {Map<string,string>} opts.mapping  nodeId -> chromeId（上次同步留下的映射）
 * @param {string} opts.deviceId
 * @returns {Promise<{nodes: Map, mapping: Map, protectedIds: Set<string>, stats: object}>}
 *
 * 注意：这里不做"排除文件夹"过滤。排除必须对 local / remote / base 三份集合
 * 同时生效（见 protocol.filterExcluded），否则云端会误判成本地删除了该文件夹。
 */
export async function scanLocal({ mapping, deviceId } = {}) {
  const tree = await bm.getTree();
  const { barId, bar, siblings, protectedIds } = inspectTree(tree);

  const prev = mapping instanceof Map ? mapping : new Map(Object.entries(mapping || {}));
  const chromeIdToNodeId = new Map();
  for (const [nodeId, chromeId] of prev) {
    if (chromeId) chromeIdToNodeId.set(String(chromeId), nodeId);
  }

  const nodes = new Map();
  const nextMapping = new Map();
  const stats = { folders: 0, bookmarks: 0, skipped: 0, excluded: 0 };

  const walk = (children, parentNodeId) => {
    const list = children || [];
    for (let i = 0; i < list.length; i++) {
      const child = list[i];
      const isFolder = !child.url;
      const key = String(child.id);
      let nodeId = chromeIdToNodeId.get(key);
      if (!nodeId) nodeId = makeLocalId(isFolder ? 'f' : 'b');
      if (nodes.has(nodeId)) nodeId = makeLocalId(isFolder ? 'f' : 'b');

      const node = makeNode({
        id: nodeId,
        parentId: parentNodeId,
        type: isFolder ? NODE_TYPE.FOLDER : NODE_TYPE.BOOKMARK,
        title: child.title || '',
        url: isFolder ? '' : child.url || '',
        index: i,
        deleted: false,
        updatedAt: 0,
        deviceId
      });
      nodes.set(nodeId, node);
      nextMapping.set(nodeId, key);
      if (isFolder) {
        stats.folders++;
        walk(child.children, nodeId);
      } else {
        stats.bookmarks++;
      }
    }
  };

  // 书签栏的子节点直接挂到 root；其余永久文件夹作为系统节点
  if (bar && Array.isArray(bar.children)) walk(bar.children, ROOT_NODE_ID);
  for (const sib of siblings) {
    if (!sib || sib.id === barId) continue;
    const nodeId = chromeIdToNodeId.get(String(sib.id)) || makeLocalId('f');
    if (nodes.has(nodeId)) continue;
    nodes.set(
      nodeId,
      makeNode({
        id: nodeId,
        parentId: ROOT_NODE_ID,
        type: NODE_TYPE.FOLDER,
        title: sib.title || '',
        url: '',
        index: siblings.indexOf(sib),
        deleted: false,
        updatedAt: 0,
        deviceId
      })
    );
    nextMapping.set(nodeId, String(sib.id));
    if (Array.isArray(sib.children)) walk(sib.children, nodeId);
  }

  return { nodes, mapping: nextMapping, protectedIds, stats, barId };
}

/** 构建 nodeId -> chromeId 的映射，过滤掉已不存在的 chrome id */
export async function refreshMapping(mapping) {
  const entries = Array.from((mapping instanceof Map ? mapping : new Map(Object.entries(mapping || {}))).entries());
  const alive = new Map();
  await mapLimit(entries, 8, async ([nodeId, chromeId]) => {
    try {
      const found = await bm.get(String(chromeId));
      if (found && found.length) alive.set(nodeId, String(chromeId));
    } catch {
      /* 已被删除，丢弃映射 */
    }
  });
  return alive;
}

/* ---------------- 本地落地 ---------------- */

/**
 * 把合并后的计划应用到本机浏览器。
 * 顺序：更新 -> 新建（按深度）-> 移动 -> 删除（按深度倒序），尽量把失败面收窄。
 */
export async function applyLocalPlan({ plan, mapping, deviceId, protectedIds } = {}) {
  const map = mapping instanceof Map ? mapping : new Map(Object.entries(mapping || {}));
  const chromeIdOf = new Map();
  for (const [nodeId, chromeId] of map) chromeIdOf.set(nodeId, String(chromeId));

  const guard = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
  const result = { created: 0, updated: 0, moved: 0, deleted: 0, errors: [], mapping: map };

  const remember = (nodeId, chromeId) => {
    map.set(nodeId, String(chromeId));
    chromeIdOf.set(nodeId, String(chromeId));
  };

  /* 1) 更新标题 / URL */
  for (const op of plan.updates) {
    if (guard.has(op.chromeId)) continue;
    try {
      const patch = {};
      if (op.patch.title !== undefined) patch.title = op.patch.title || '';
      if (op.patch.url !== undefined && op.patch.url) patch.url = op.patch.url;
      if (!Object.keys(patch).length) continue;
      await bm.update(op.chromeId, patch);
      result.updated++;
    } catch (err) {
      result.errors.push({ phase: 'update', nodeId: op.nodeId, message: err.message });
    }
  }

  /* 2) 新建（父节点已存在，按 depth 升序） */
  for (const op of plan.creates) {
    const parentChromeId = op.parentNodeId === ROOT_NODE_ID ? await resolveRootParent() : chromeIdOf.get(op.parentNodeId);
    if (!parentChromeId) {
      result.errors.push({ phase: 'create', nodeId: op.nodeId, message: '父节点尚未落地：' + op.parentNodeId });
      continue;
    }
    try {
      const info = { parentId: parentChromeId, title: op.title || '' };
      if (op.type === NODE_TYPE.BOOKMARK) {
        if (!op.url) {
          result.errors.push({ phase: 'create', nodeId: op.nodeId, message: '书签缺少 URL，已跳过' });
          continue;
        }
        info.url = op.url;
      }
      if (Number.isFinite(op.index) && op.index >= 0) info.index = op.index;
      const created = await bm.create(info);
      remember(op.nodeId, created.id);
      result.created++;
    } catch (err) {
      result.errors.push({ phase: 'create', nodeId: op.nodeId, message: err.message });
    }
  }

  /* 3) 移动 / 排序 */
  for (const op of plan.moves) {
    if (guard.has(op.chromeId)) continue;
    const parentChromeId = op.parentNodeId === ROOT_NODE_ID ? await resolveRootParent() : chromeIdOf.get(op.parentNodeId);
    if (!parentChromeId) {
      result.errors.push({ phase: 'move', nodeId: op.nodeId, message: '目标父节点不存在：' + op.parentNodeId });
      continue;
    }
    try {
      const dest = { parentId: parentChromeId };
      if (Number.isFinite(op.index) && op.index >= 0) dest.index = op.index;
      await bm.move(op.chromeId, dest);
      result.moved++;
    } catch (err) {
      // index 越界之类的轻微错误直接忽略，下一轮会再次校正
      result.errors.push({ phase: 'move', nodeId: op.nodeId, message: err.message });
    }
  }

  /* 4) 删除（先删子再删父） */
  for (const op of plan.deletes) {
    if (guard.has(op.chromeId)) {
      result.errors.push({ phase: 'delete', nodeId: op.nodeId, message: '系统文件夹受保护，跳过' });
      continue;
    }
    try {
      if (op.type === NODE_TYPE.FOLDER) {
        const children = await bm.getSubTree(op.chromeId).catch(() => null);
        const rootNode = children && children[0];
        if (rootNode && rootNode.children && rootNode.children.length) await bm.removeTree(op.chromeId);
        else await bm.remove(op.chromeId);
      } else {
        await bm.remove(op.chromeId);
      }
      map.delete(op.nodeId);
      chromeIdOf.delete(op.nodeId);
      result.deleted++;
    } catch (err) {
      result.errors.push({ phase: 'delete', nodeId: op.nodeId, message: err.message });
    }
  }

  if (result.errors.length) {
    logger.warn('本地应用有 ' + result.errors.length + ' 个错误', result.errors.slice(0, 8));
  }
  return result;
}

/** 「root」这个虚拟父节点在本机的真实落点：书签栏 */
let cachedRootParent = null;
export async function resolveRootParent(force = false) {
  if (cachedRootParent && !force) return cachedRootParent;
  const tree = await bm.getTree();
  const { barId } = inspectTree(tree);
  cachedRootParent = barId;
  return barId;
}

export function clearRootParentCache() {
  cachedRootParent = null;
}

/* ---------------- 快照式全量导出（用于本地备份） ---------------- */

export async function exportLocalTree() {
  const tree = await bm.getTree();
  return tree;
}

/** 清空本机用户书签（保留永久文件夹），供「从云端覆盖」使用 */
export async function clearLocalBookmarks({ keepIds } = {}) {
  const tree = await bm.getTree();
  const { bar, siblings } = inspectTree(tree);
  const keep = new Set(keepIds || []);
  for (const sib of siblings) keep.add(sib.id);
  let removed = 0;
  const wipe = async (children) => {
    for (const child of children || []) {
      if (keep.has(child.id)) {
        if (Array.isArray(child.children)) await wipe(child.children);
        continue;
      }
      try {
        if (Array.isArray(child.children) && child.children.length) await bm.removeTree(child.id);
        else await bm.remove(child.id);
        removed++;
      } catch (err) {
        logger.warn('清理本地书签失败：' + child.id, err.message);
      }
    }
  };
  if (bar && bar.children) await wipe(bar.children);
  for (const sib of siblings) {
    if (sib.id === (bar && bar.id)) continue;
    await wipe(sib.children);
  }
  return removed;
}

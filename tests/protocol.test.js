import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeDocs,
  nodesToIndex,
  indexToNodes,
  normalizeIndices,
  makeNode,
  createDoc,
  docFromJson,
  serializeDoc,
  docStats,
  planLocalApply,
  planLocalSummary,
  diffSummary,
  pruneTombstones,
  repairTree,
  filterExcluded,
  ROOT_NODE_ID,
  NODE_TYPE
} from '../src/lib/protocol.js';

const T = 1_700_000_000_000;

function folder(id, parentId, title, index = 0, extra = {}) {
  return makeNode({ id, parentId, type: NODE_TYPE.FOLDER, title, url: '', index, updatedAt: T, deviceId: 'devA', ...extra });
}
function mark(id, parentId, title, url, index = 0, extra = {}) {
  return makeNode({ id, parentId, type: NODE_TYPE.BOOKMARK, title, url, index, updatedAt: T, deviceId: 'devA', ...extra });
}

/* ---------------- 索引与规范化 ---------------- */

test('nodesToIndex 忽略 root 并保留字段', () => {
  const idx = nodesToIndex([folder(ROOT_NODE_ID, null, 'root'), mark('a', ROOT_NODE_ID, 'A', 'https://a.com')]);
  assert.equal(idx.size, 1);
  assert.equal(idx.get('a').url, 'https://a.com');
});

test('indexToNodes 产生稳定字节序', () => {
  const a = new Map([
    ['b', mark('b', ROOT_NODE_ID, 'B', 'https://b.com', 1)],
    ['a', mark('a', ROOT_NODE_ID, 'A', 'https://a.com', 0)]
  ]);
  const s1 = JSON.stringify(indexToNodes(a));
  const reversed = new Map(Array.from(a.entries()).reverse());
  const s2 = JSON.stringify(indexToNodes(reversed));
  assert.equal(s1, s2);
});

test('normalizeIndices 把稀疏 index 压成稠密序号', () => {
  const idx = new Map([
    ['a', mark('a', 'f1', 'A', 'https://a.com', 5)],
    ['b', mark('b', 'f1', 'B', 'https://b.com', 9)],
    ['c', mark('c', 'f1', 'C', 'https://c.com', 12)]
  ]);
  const out = normalizeIndices(idx);
  assert.deepEqual([out.get('a').index, out.get('b').index, out.get('c').index], [0, 1, 2]);
});

/* ---------------- 合并 ---------------- */

test('单侧新增会同步到另一侧', () => {
  const base = new Map();
  const local = new Map([['a', mark('a', ROOT_NODE_ID, 'A', 'https://a.com')]]);
  const remote = new Map();
  const { merged, stats } = mergeDocs({ base, local, remote });
  assert.equal(merged.size, 1);
  assert.equal(merged.get('a').title, 'A');
  assert.equal(stats.created, 1);
});

test('两侧各自新增不同节点会合并保留', () => {
  const local = new Map([['a', mark('a', ROOT_NODE_ID, 'A', 'https://a.com')]]);
  const remote = new Map([['b', mark('b', ROOT_NODE_ID, 'B', 'https://b.com')]]);
  const { merged } = mergeDocs({ base: new Map(), local, remote });
  assert.equal(merged.size, 2);
});

test('一侧删除且另一侧未改动 -> 尊重删除', () => {
  const n = mark('a', ROOT_NODE_ID, 'A', 'https://a.com');
  const base = new Map([['a', n]]);
  const local = new Map(); // 本地删除
  const remote = new Map([['a', n]]);
  const { merged, stats } = mergeDocs({ base, local, remote, now: T + 1000 });
  assert.equal(merged.get('a').deleted, true);
  assert.equal(stats.deleted, 1);
});

test('一侧删除、另一侧修改过 -> 默认保留内容（防误删）', () => {
  const n = mark('a', ROOT_NODE_ID, 'A', 'https://a.com');
  const base = new Map([['a', n]]);
  const local = new Map();
  const remote = new Map([['a', { ...n, title: 'A 改过', updatedAt: T + 5000 }]]);
  const { merged, conflicts, stats } = mergeDocs({ base, local, remote, now: T + 6000 });
  assert.equal(merged.get('a').deleted, false);
  assert.equal(merged.get('a').title, 'A 改过');
  assert.equal(stats.restored, 1);
  assert.equal(conflicts[0].kind, 'delete-vs-modify');
  assert.equal(conflicts[0].detail.resolution, 'kept');
});

test('deleteConflict=delete 时尊重删除', () => {
  const n = mark('a', ROOT_NODE_ID, 'A', 'https://a.com');
  const { merged } = mergeDocs({
    base: new Map([['a', n]]),
    local: new Map(),
    remote: new Map([['a', { ...n, title: 'A2', updatedAt: T + 5000 }]]),
    policy: { deleteConflict: 'delete' },
    now: T + 6000
  });
  assert.equal(merged.get('a').deleted, true);
});

test('两侧内容一致时无冲突', () => {
  const n = mark('a', ROOT_NODE_ID, 'A', 'https://a.com');
  const { conflicts, merged } = mergeDocs({ base: new Map(), local: new Map([['a', n]]), remote: new Map([['a', n]]) });
  assert.equal(conflicts.length, 0);
  assert.equal(merged.size, 1);
});

test('标题冲突按时间戳取较新（latest）', () => {
  const n = mark('a', ROOT_NODE_ID, 'A', 'https://a.com');
  const local = new Map([['a', { ...n, title: '本地标题', updatedAt: T + 2000 }]]);
  const remote = new Map([['a', { ...n, title: '云端标题', updatedAt: T + 1000 }]]);
  const { merged, conflicts } = mergeDocs({ base: new Map([['a', n]]), local, remote, now: T + 3000 });
  assert.equal(merged.get('a').title, '本地标题');
  assert.equal(conflicts[0].kind, 'field');
});

test('标题冲突按 fieldConflict=remote 强制云端', () => {
  const n = mark('a', ROOT_NODE_ID, 'A', 'https://a.com');
  const local = new Map([['a', { ...n, title: '本地标题', updatedAt: T + 2000 }]]);
  const remote = new Map([['a', { ...n, title: '云端标题', updatedAt: T + 1000 }]]);
  const { merged } = mergeDocs({ base: new Map([['a', n]]), local, remote, policy: { fieldConflict: 'remote' } });
  assert.equal(merged.get('a').title, '云端标题');
});

test('移动与改标题分别独立合并（不互相覆盖）', () => {
  const n = mark('a', ROOT_NODE_ID, 'A', 'https://a.com');
  const f1 = folder('f1', ROOT_NODE_ID, 'F1', 0);
  const f2 = folder('f2', ROOT_NODE_ID, 'F2', 1);
  const base = new Map([['a', n], ['f1', f1], ['f2', f2]]);
  const local = new Map([['a', { ...n, title: '新标题', updatedAt: T + 1000 }], ['f1', f1], ['f2', f2]]);
  const remote = new Map([['a', { ...n, parentId: 'f2', updatedAt: T + 1200 }], ['f1', f1], ['f2', f2]]);
  const { merged } = mergeDocs({ base, local, remote, now: T + 2000 });
  assert.equal(merged.get('a').title, '新标题');
  assert.equal(merged.get('a').parentId, 'f2');
});

test('父节点丢失会重挂到 root 并记录冲突', () => {
  const child = mark('c', 'missing', 'C', 'https://c.com');
  const { merged, conflicts } = mergeDocs({ base: new Map(), local: new Map([['c', child]]), remote: new Map() });
  assert.equal(merged.get('c').parentId, ROOT_NODE_ID);
  assert.ok(conflicts.some((c) => c.kind === 'orphan'));
});

test('循环引用被修复', () => {
  const a = folder('a', 'b', 'A', 0);
  const b = folder('b', 'a', 'B', 0);
  const { index, fixes } = repairTree(new Map([['a', a], ['b', b]]));
  assert.ok(fixes.length >= 1);
  for (const node of index.values()) assert.equal(node.parentId, ROOT_NODE_ID);
});

test('过期墓碑被清理，新鲜墓碑保留', () => {
  const day = 24 * 60 * 60 * 1000;
  const old = mark('old', ROOT_NODE_ID, 'O', 'https://o.com', 0, { deleted: true, deletedAt: T - 100 * day, updatedAt: T - 100 * day });
  const fresh = mark('fresh', ROOT_NODE_ID, 'F', 'https://f.com', 0, { deleted: true, deletedAt: T - 2 * day, updatedAt: T - 2 * day });
  const { index, removed } = pruneTombstones(new Map([['old', old], ['fresh', fresh]]), { now: T });
  assert.equal(removed, 1);
  assert.equal(index.has('old'), false);
  assert.equal(index.has('fresh'), true);
});

/* ---------------- 文档 ---------------- */

test('createDoc / serializeDoc / docFromJson 往返一致', () => {
  const idx = new Map([['a', mark('a', ROOT_NODE_ID, 'A', 'https://a.com')]]);
  const doc = createDoc({ nodes: idx, revision: 3, writer: 'devA', createdAt: T });
  const text = serializeDoc(doc);
  const parsed = docFromJson(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.doc.revision, 3);
  assert.equal(parsed.doc.nodes.get('a').url, 'https://a.com');
});

test('docFromJson 拒绝坏 JSON 与未来版本', () => {
  assert.equal(docFromJson('{').ok, false);
  const future = JSON.stringify({ schemaVersion: 99, nodes: [] });
  const parsed = docFromJson(future);
  assert.equal(parsed.ok, false);
});

test('docStats 统计书签/目录/墓碑', () => {
  const idx = new Map([
    ['f', folder('f', ROOT_NODE_ID, 'F')],
    ['a', mark('a', 'f', 'A', 'https://a.com')],
    ['d', mark('d', ROOT_NODE_ID, 'D', 'https://d.com', 0, { deleted: true, deletedAt: T })]
  ]);
  const s = docStats({ nodes: idx, revision: 2, updatedAt: T });
  assert.deepEqual([s.folders, s.bookmarks, s.tombstones], [1, 1, 1]);
});

/* ---------------- 应用计划 ---------------- */

test('planLocalApply 先建父后建子', () => {
  const merged = new Map([
    ['f', folder('f', ROOT_NODE_ID, 'F', 0)],
    ['a', mark('a', 'f', 'A', 'https://a.com', 0)]
  ]);
  const plan = planLocalApply({ merged, local: new Map(), chromeIdOf: new Map() });
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.creates[0].nodeId, 'f');
  assert.equal(plan.creates[1].nodeId, 'a');
  assert.equal(planLocalSummary(plan).creates, 2);
});

test('planLocalApply 生成删除、更新与移动', () => {
  const oldNode = mark('a', ROOT_NODE_ID, 'A', 'https://a.com', 0);
  const folderNode = folder('f', ROOT_NODE_ID, 'F', 1);
  const local = new Map([['a', oldNode], ['f', folderNode], ['dead', mark('dead', ROOT_NODE_ID, 'X', 'https://x.com', 2)]]);
  const merged = new Map([
    ['a', { ...oldNode, title: 'A2', parentId: 'f', updatedAt: T + 1 }],
    ['f', folderNode]
  ]);
  const chromeIdOf = new Map([['a', '11'], ['f', '22'], ['dead', '33']]);
  const plan = planLocalApply({ merged, local, chromeIdOf });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].chromeId, '33');
});

test('diffSummary 统计云端差异', () => {
  const remote = new Map([['a', mark('a', ROOT_NODE_ID, 'A', 'https://a.com')]]);
  const merged = new Map([
    ['a', mark('a', ROOT_NODE_ID, 'A2', 'https://a.com')],
    ['b', mark('b', ROOT_NODE_ID, 'B', 'https://b.com', 1)]
  ]);
  const d = diffSummary(merged, remote);
  assert.equal(d.created, 1);
  assert.equal(d.updated, 1);
});

test('mergeDocs 不修改输入集合', () => {
  const local = new Map([['a', mark('a', ROOT_NODE_ID, 'A', 'https://a.com')]]);
  const remote = new Map();
  const snapshot = JSON.stringify(indexToNodes(local));
  mergeDocs({ base: new Map(), local, remote });
  assert.equal(JSON.stringify(indexToNodes(local)), snapshot);
});
/* ---------------- 排除文件夹 ---------------- */

test('filterExcluded 连带排除整棵子树', () => {
  const idx = new Map([
    ['f1', folder('f1', ROOT_NODE_ID, '临时收藏')],
    ['a', mark('a', 'f1', 'A', 'https://a.com')],
    ['f2', folder('f2', 'f1', '嵌套')],
    ['b', mark('b', 'f2', 'B', 'https://b.com')],
    ['c', mark('c', ROOT_NODE_ID, 'C', 'https://c.com')]
  ]);
  const out = filterExcluded(idx, ['临时收藏']);
  assert.equal(out.size, 1);
  assert.equal(out.has('c'), true);
});

test('filterExcluded 列表为空时原样返回同一个 Map', () => {
  const idx = new Map([['a', mark('a', ROOT_NODE_ID, 'A', 'https://a.com')]]);
  assert.equal(filterExcluded(idx, []), idx);
});

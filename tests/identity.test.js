import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeNode,
  nodesToIndex,
  indexToNodes,
  NODE_TYPE,
  ROOT_NODE_ID,
  adoptRemoteIdentities,
  duplicateGuard,
  dedupeIndex,
  contentKey,
  pathKeys,
  normalizeIndices
} from '../src/lib/protocol.js';

/**
 * 回归：新设备接入已有云端文档时，整棵树被复制成两份。
 *
 * 线上真实事故：云端文档 revision=2，nodes 里同一套书签出现两遍，
 * 一遍 deviceId=dev-sd0tf5wdil，一遍 deviceId=dev-rc7eypus8c。
 * 原因是第二台设备 mapping 为空 -> 全部新 id；base 为空 -> 两边都判"新增"。
 */

const T = 1_700_000_000_000;

function node(id, parentId, title, url, index, deviceId = 'dev-a') {
  return makeNode({
    id,
    parentId,
    type: url ? NODE_TYPE.BOOKMARK : NODE_TYPE.FOLDER,
    title,
    url,
    index,
    updatedAt: T,
    deviceId
  });
}

/** 一棵两层的示例树：书签栏(F) -> 2 个文件夹 -> 各 2 个书签 */
function buildTree(prefix, deviceId) {
  const p = (s) => prefix + s;
  return nodesToIndex([
    node(p('bar'), ROOT_NODE_ID, '书签工具栏', '', 0, deviceId),
    node(p('f1'), p('bar'), 'AI agent', '', 0, deviceId),
    node(p('b1'), p('f1'), 'RAGFlow', 'https://ragflow.io/', 0, deviceId),
    node(p('b2'), p('f1'), 'aipyapp', 'https://github.com/knownsec/aipyapp', 1, deviceId),
    node(p('f2'), p('bar'), 'AI大模型', '', 1, deviceId),
    node(p('b3'), p('f2'), 'vLLM', 'https://vllm.ai/', 0, deviceId),
    node(p('b4'), p('f2'), 'LM Studio', 'https://lmstudio.ai/', 1, deviceId)
  ]);
}

test('contentKey 忽略 id，只看类型与内容', () => {
  assert.equal(contentKey(node('x1', ROOT_NODE_ID, 'A', 'u', 0)), contentKey(node('y9', ROOT_NODE_ID, 'A', 'u', 5)));
  assert.notEqual(contentKey(node('x1', ROOT_NODE_ID, 'A', 'u', 0)), contentKey(node('x2', ROOT_NODE_ID, 'A', 'v', 0)));
  assert.notEqual(
    contentKey(node('x1', ROOT_NODE_ID, 'A', '', 0)),
    contentKey(node('x2', ROOT_NODE_ID, 'A', 'u', 0))
  );
});

test('pathKeys：两套 id、同样内容的树，路径签名完全一致', () => {
  const a = buildTree('a-', 'dev-a');
  const b = buildTree('b-', 'dev-b');
  const ka = pathKeys(a);
  const kb = pathKeys(b);
  const sortedA = Array.from(ka.values()).sort();
  const sortedB = Array.from(kb.values()).sort();
  assert.deepEqual(sortedA, sortedB);
});

test('adoptRemoteIdentities：把本地新 id 认领成云端 id', () => {
  const local = buildTree('a-', 'dev-a');
  const remote = buildTree('b-', 'dev-b');

  const r = adoptRemoteIdentities({ local, remote });
  assert.equal(r.adopted, local.size);
  assert.equal(r.reason, 'adopted');

  // 认领后 id 与云端同构
  for (const id of r.index.keys()) assert.ok(remote.has(id), '应与云端 id 对齐: ' + id);

  // mapping 重写映射覆盖全部节点
  assert.equal(r.idRemap.size, local.size);
  for (const [oldId, newId] of r.idRemap) assert.ok(local.has(oldId) && remote.has(newId));
});

test('adoptRemoteIdentities：父链一起重写，不会产生孤儿', () => {
  const local = buildTree('a-', 'dev-a');
  const remote = buildTree('b-', 'dev-b');
  const r = adoptRemoteIdentities({ local, remote });

  for (const n of r.index.values()) {
    if (n.parentId === ROOT_NODE_ID || n.parentId == null) continue;
    assert.ok(r.index.has(n.parentId), '父节点必须存在于对齐后的集合: ' + n.id);
  }
});

test('adoptRemoteIdentities：已经对齐时不改动（幂等）', () => {
  const same = buildTree('s-', 'dev-a');
  const r = adoptRemoteIdentities({ local: same, remote: same });
  assert.equal(r.adopted, 0);
  assert.equal(r.reason, 'already-aligned');
  assert.equal(r.index, same);
});

test('adoptRemoteIdentities：内容毫无交集时不动（那是真的新书签）', () => {
  const local = nodesToIndex([node('l1', ROOT_NODE_ID, '只有本机', 'https://a/', 0)]);
  const remote = nodesToIndex([node('r1', ROOT_NODE_ID, '只有云端', 'https://b/', 0)]);
  const r = adoptRemoteIdentities({ local, remote });
  assert.equal(r.adopted, 0);
  assert.equal(r.reason, 'no-content-match');
});

test('adoptRemoteIdentities：标题相同但树位置不同，不会错配', () => {
  const local = nodesToIndex([
    node('lf', ROOT_NODE_ID, 'F', '', 0),
    node('lb', 'lf', '同名', 'https://same/', 0)
  ]);
  const remote = nodesToIndex([
    node('rf', ROOT_NODE_ID, 'G', '', 0),
    node('rb', 'rf', '同名', 'https://same/', 0)
  ]);
  const r = adoptRemoteIdentities({ local, remote });
  // 路径不同（F/同名 vs G/同名），不应认领
  assert.equal(r.adopted, 0);
  assert.equal(r.reason, 'no-content-match');
});

test('duplicateGuard：两套 id 内容相同 -> 拦下', () => {
  const local = buildTree('a-', 'dev-a');
  const remote = buildTree('b-', 'dev-b');
  const merged = new Map([...local, ...remote]);

  const g = duplicateGuard({ merged, local, remote });
  assert.equal(g.blocked, true);
  assert.match(g.reason, /一式两份|两套 id/);
  assert.equal(g.idOverlapRatio, 0);
  assert.ok(g.contentOverlapRatio > 0.9);
});

test('duplicateGuard：正常同一套 id 的同步不拦', () => {
  const a = buildTree('s-', 'dev-a');
  const b = new Map(a);
  b.set('extra', node('extra', ROOT_NODE_ID, '新增', 'https://new/', 9, 'dev-b'));
  const merged = new Map([...a, ...b]);

  const g = duplicateGuard({ merged, local: a, remote: b });
  assert.equal(g.blocked, false);
  assert.equal(g.idOverlapRatio, 1);
});

test('duplicateGuard：节点太少时不拦（避免误伤刚建的小库）', () => {
  const local = nodesToIndex([node('l1', ROOT_NODE_ID, 'x', 'https://x/', 0)]);
  const remote = nodesToIndex([node('r1', ROOT_NODE_ID, 'x', 'https://x/', 0)]);
  const g = duplicateGuard({ merged: new Map([...local, ...remote]), local, remote });
  assert.equal(g.blocked, false);
});

test('duplicateGuard：内容不同、id 也不同 -> 不拦（两台设备各自新增）', () => {
  const local = nodesToIndex([
    node('l1', ROOT_NODE_ID, 'A', 'https://a/', 0),
    node('l2', ROOT_NODE_ID, 'B', 'https://b/', 1),
    node('l3', ROOT_NODE_ID, 'C', 'https://c/', 2),
    node('l4', ROOT_NODE_ID, 'D', 'https://d/', 3),
    node('l5', ROOT_NODE_ID, 'E', 'https://e/', 4)
  ]);
  const remote = nodesToIndex([
    node('r1', ROOT_NODE_ID, 'P', 'https://p/', 0),
    node('r2', ROOT_NODE_ID, 'Q', 'https://q/', 1),
    node('r3', ROOT_NODE_ID, 'R', 'https://r/', 2),
    node('r4', ROOT_NODE_ID, 'S', 'https://s/', 3),
    node('r5', ROOT_NODE_ID, 'T', 'https://t/', 4)
  ]);
  const g = duplicateGuard({ merged: new Map([...local, ...remote]), local, remote });
  assert.equal(g.blocked, false);
});

test('dedupeIndex：残留的两份副本被收敛成一份', () => {
  const local = buildTree('a-', 'dev-a');
  const remote = buildTree('b-', 'dev-b');
  const doubled = new Map([...local, ...remote]);
  assert.equal(doubled.size, 14);

  const r = dedupeIndex(doubled, { rootId: ROOT_NODE_ID, now: T + 1, deviceId: 'dev-a' });
  assert.equal(r.removed, 7, '第二棵树应整体打墓碑');

  const active = indexToNodes(r.index).filter((n) => !n.deleted);
  assert.equal(active.length, 7);

  // 存活的一份结构完整、父链齐全
  const ids = new Set(active.map((n) => n.id));
  for (const n of active) {
    if (n.parentId === ROOT_NODE_ID) continue;
    assert.ok(ids.has(n.parentId), '存活节点不能是孤儿: ' + n.id);
  }
});

test('dedupeIndex：同标题同 URL 但位置不同，不算重复（不误删）', () => {
  const idx = nodesToIndex([
    node('f1', ROOT_NODE_ID, 'F1', '', 0),
    node('f2', ROOT_NODE_ID, 'F2', '', 1),
    node('b1', 'f1', '同名', 'https://same/', 0),
    node('b2', 'f2', '同名', 'https://same/', 0)
  ]);
  const r = dedupeIndex(idx, { now: T });
  assert.equal(r.removed, 0);
});

test('dedupeIndex：正常树不做任何改动', () => {
  const tree = buildTree('s-', 'dev-a');
  const r = dedupeIndex(tree, { now: T });
  assert.equal(r.removed, 0);
  assert.equal(r.index.size, tree.size);
});

test('端到端：对齐后合并，云端节点数不翻倍', async () => {
  const { mergeDocs, diffSummary } = await import('../src/lib/protocol.js');
  const local = buildTree('a-', 'dev-a');
  const remote = buildTree('b-', 'dev-b');

  // 事故现场：不做对齐、base 为空 -> 合并结果直接翻倍
  const naive = mergeDocs({ base: new Map(), local, remote, deviceId: 'dev-a' });
  assert.equal(normalizeIndices(naive.merged).size, 14, '这就是线上出现的双份树');

  // 修复后：先对齐再合并 -> 数量不变
  const align = adoptRemoteIdentities({ local, remote });
  const fixed = mergeDocs({ base: new Map(), local: align.index, remote, deviceId: 'dev-a' });
  const mergedIndex = normalizeIndices(fixed.merged);
  assert.equal(mergedIndex.size, 7);
  assert.ok(diffSummary(mergedIndex, remote).created === 0, '不应再产生新增');
});

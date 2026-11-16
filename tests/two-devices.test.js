import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeDocs,
  normalizeIndices,
  makeNode,
  NODE_TYPE,
  ROOT_NODE_ID,
  planLocalApply,
  diffSummary,
  isEmptyDiff
} from '../src/lib/protocol.js';

/**
 * 端到端仿真：两台设备通过"云端"同步，用一个假 Drive 保存文档。
 * 只跑纯协议层（不碰 chrome API），验证收敛性与删除语义。
 */

let clock = 1_700_000_000_000;
const tick = () => (clock += 1000);

function makeDevice(name) {
  return { name, deviceId: 'dev-' + name, local: new Map(), base: new Map(), chromeIds: new Map() };
}

function addNode(dev, { id, parentId = ROOT_NODE_ID, type = NODE_TYPE.BOOKMARK, title, url = '', index = 0 }) {
  const node = makeNode({
    id,
    parentId,
    type,
    title,
    url: type === NODE_TYPE.FOLDER ? '' : url,
    index,
    updatedAt: tick(),
    deviceId: dev.deviceId
  });
  dev.local.set(id, node);
  dev.chromeIds.set(id, 'c-' + id);
  return node;
}

function removeNode(dev, id) {
  const node = dev.local.get(id);
  assert.ok(node, 'node should exist: ' + id);
  dev.local.set(id, { ...node, deleted: true, deletedAt: tick(), updatedAt: tick() });
  dev.chromeIds.delete(id);
}

function editNode(dev, id, patch) {
  const node = dev.local.get(id);
  assert.ok(node, 'node should exist: ' + id);
  dev.local.set(id, { ...node, ...patch, updatedAt: tick() });
}

/** 一轮完整同步：合并 -> 推云端（有差异才写）-> 落到本地 */
function syncRound(dev, cloud) {
  const localIndex = normalizeIndices(dev.local);
  const remoteIndex = cloud.doc ? cloud.doc : new Map();
  const { merged, conflicts } = mergeDocs({
    base: dev.base,
    local: localIndex,
    remote: remoteIndex,
    deviceId: dev.deviceId,
    now: tick()
  });
  const mergedIndex = normalizeIndices(merged);

  const cloudDiff = diffSummary(mergedIndex, remoteIndex);
  const cloudChanged = !isEmptyDiff(cloudDiff);
  if (cloudChanged) {
    cloud.doc = mergedIndex;
    cloud.version++;
  }

  const plan = planLocalApply({ merged: mergedIndex, local: localIndex, chromeIdOf: dev.chromeIds });
  dev.local = normalizeIndices(mergedIndex);
  for (const c of plan.creates) dev.chromeIds.set(c.nodeId, 'c-' + c.nodeId);
  for (const d of plan.deletes) dev.chromeIds.delete(d.nodeId);
  dev.base = mergedIndex;
  return { conflicts, plan, cloudChanged, cloudDiff };
}

function newCloud() {
  return { doc: null, version: 0 };
}

function adoptFromCloud(dev, cloud) {
  assert.ok(cloud.doc instanceof Map, 'cloud.doc 应为 Map');
  dev.local = new Map(cloud.doc);
  for (const id of dev.local.keys()) dev.chromeIds.set(id, 'c-' + id);
  dev.base = cloud.doc;
}

function activeNodes(map) {
  return Array.from(map.values())
    .filter((n) => !n.deleted)
    .map((n) => n.id + '|' + n.title + '|' + n.url + '|' + n.parentId)
    .sort();
}

test('两台设备各自添加书签后收敛到同一状态', () => {
  const cloud = newCloud();
  const a = makeDevice('a');
  const b = makeDevice('b');

  addNode(a, { id: 'a1', title: 'A1', url: 'https://a1.com', index: 0 });
  addNode(a, { id: 'a2', title: 'A2', url: 'https://a2.com', index: 1 });
  syncRound(a, cloud);
  adoptFromCloud(b, cloud);

  addNode(b, { id: 'b1', title: 'B1', url: 'https://b1.com', index: 2 });
  const r1 = syncRound(b, cloud);
  assert.equal(r1.cloudDiff.created, 1);

  syncRound(a, cloud);
  assert.deepEqual(activeNodes(a.local), activeNodes(b.local));
  assert.equal(activeNodes(a.local).length, 3);
});

test('删除不会在另一台离线设备上复活', () => {
  const cloud = newCloud();
  const a = makeDevice('a');
  const b = makeDevice('b');

  addNode(a, { id: 'n1', title: 'N1', url: 'https://n1.com' });
  addNode(a, { id: 'n2', title: 'N2', url: 'https://n2.com', index: 1 });
  syncRound(a, cloud);
  adoptFromCloud(b, cloud);

  removeNode(a, 'n1');
  const r = syncRound(a, cloud);
  assert.ok(r.cloudDiff.deleted >= 1, '云端应记录删除');

  const res = syncRound(b, cloud);
  assert.equal(b.local.get('n1').deleted, true);
  assert.deepEqual(activeNodes(a.local), activeNodes(b.local));
  assert.equal(activeNodes(b.local).length, 1);
  assert.ok(!res.conflicts.some((c) => c.kind === 'delete-vs-modify'));
});

test('删除 vs 另一侧修改 -> 保留内容，不丢书签', () => {
  const cloud = newCloud();
  const a = makeDevice('a');
  const b = makeDevice('b');

  addNode(a, { id: 'n1', title: 'N1', url: 'https://n1.com' });
  syncRound(a, cloud);
  adoptFromCloud(b, cloud);

  removeNode(a, 'n1');
  syncRound(a, cloud);

  editNode(b, 'n1', { title: 'N1 重要收藏' });
  const res = syncRound(b, cloud);

  assert.equal(b.local.get('n1').deleted, false, '本地应保留该书签');
  assert.equal(b.local.get('n1').title, 'N1 重要收藏');
  assert.ok(res.conflicts.some((c) => c.kind === 'delete-vs-modify' && c.detail.resolution === 'kept'));

  syncRound(a, cloud);
  assert.equal(a.local.get('n1').deleted, false);
  assert.deepEqual(activeNodes(a.local), activeNodes(b.local));
});

test('目录结构：两边各自新建目录与书签不会互相清空', () => {
  const cloud = newCloud();
  const a = makeDevice('a');
  const b = makeDevice('b');

  addNode(a, { id: 'f1', type: NODE_TYPE.FOLDER, title: '工作' });
  addNode(a, { id: 'a1', parentId: 'f1', title: 'A1', url: 'https://a1.com' });
  syncRound(a, cloud);
  adoptFromCloud(b, cloud);

  addNode(b, { id: 'f2', type: NODE_TYPE.FOLDER, title: '生活', index: 1 });
  addNode(b, { id: 'b1', parentId: 'f2', title: 'B1', url: 'https://b1.com' });
  syncRound(b, cloud);
  syncRound(a, cloud);

  assert.deepEqual(activeNodes(a.local), activeNodes(b.local));
  assert.equal(a.local.get('b1').parentId, 'f2');
  assert.equal(b.local.get('a1').parentId, 'f1');
});

test('两侧同时改同一标题 -> 按时间戳取新，且记录冲突', () => {
  const cloud = newCloud();
  const a = makeDevice('a');
  const b = makeDevice('b');

  addNode(a, { id: 'n1', title: '原标题', url: 'https://n1.com' });
  syncRound(a, cloud);
  adoptFromCloud(b, cloud);

  editNode(a, 'n1', { title: 'A 改的' });
  syncRound(a, cloud); // A 先推上去，制造真正的双写
  clock += 5000;
  editNode(b, 'n1', { title: 'B 改的' });

  const r = syncRound(b, cloud);
  assert.equal(b.local.get('n1').title, 'B 改的');
  assert.ok(r.conflicts.some((c) => c.kind === 'field'));

  syncRound(a, cloud);
  assert.equal(a.local.get('n1').title, 'B 改的');
});

test('重复同步是幂等的：第二轮没有云端写入', () => {
  const cloud = newCloud();
  const a = makeDevice('a');
  addNode(a, { id: 'n1', title: 'N1', url: 'https://n1.com' });
  syncRound(a, cloud);
  const v = cloud.version;
  const r = syncRound(a, cloud);
  assert.equal(cloud.version, v);
  assert.equal(r.cloudChanged, false);
  assert.equal(r.plan.creates.length + r.plan.updates.length + r.plan.moves.length + r.plan.deletes.length, 0);
});

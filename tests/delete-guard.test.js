import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteGuard, countActive } from '../src/lib/sync.js';
import { makeNode, NODE_TYPE, ROOT_NODE_ID } from '../src/lib/protocol.js';

function plan(n) {
  return { deletes: Array.from({ length: n }, (_, i) => ({ nodeId: 'n' + i, chromeId: 'c' + i, title: 'T' + i, type: NODE_TYPE.BOOKMARK })) };
}

test('删除数未超阈值 -> 不拦截', () => {
  const g = deleteGuard(plan(3), { maxAutoDeletes: 50, maxAutoDeleteRatio: 0.25 }, 100);
  assert.equal(g.blocked, false);
  assert.equal(g.total, 3);
});

test('绝对阈值：超过 maxAutoDeletes 直接拦截', () => {
  const g = deleteGuard(plan(60), { maxAutoDeletes: 50, maxAutoDeleteRatio: 1 }, 100000);
  assert.equal(g.blocked, true);
  assert.equal(g.overAbsolute, true);
  assert.match(g.reason, /超过自动阈值/);
});

test('相对阈值：书签本来就少时删一半也会拦截', () => {
  const g = deleteGuard(plan(10), { maxAutoDeletes: 1000, maxAutoDeleteRatio: 0.25 }, 20);
  assert.equal(g.blocked, true);
  assert.equal(g.overAbsolute, false);
  assert.equal(g.overRatio, true);
});

test('相对阈值有小样本豁免（少于 5 条不拦截）', () => {
  const g = deleteGuard(plan(3), { maxAutoDeletes: 1000, maxAutoDeleteRatio: 0.25 }, 4);
  assert.equal(g.blocked, false);
});

test('比例在安全范围内不拦截', () => {
  const g = deleteGuard(plan(10), { maxAutoDeletes: 1000, maxAutoDeleteRatio: 0.25 }, 1000);
  assert.equal(g.blocked, false);
});

test('countActive 只数非墓碑节点', () => {
  const idx = new Map([
    ['a', makeNode({ id: 'a', parentId: ROOT_NODE_ID, type: NODE_TYPE.BOOKMARK, title: 'A', url: 'https://a.com' })],
    ['b', makeNode({ id: 'b', parentId: ROOT_NODE_ID, type: NODE_TYPE.BOOKMARK, title: 'B', url: 'https://b.com', deleted: true, deletedAt: 1 })],
    ['f', makeNode({ id: 'f', parentId: ROOT_NODE_ID, type: NODE_TYPE.FOLDER, title: 'F' })]
  ]);
  assert.equal(countActive(idx), 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseAfterPending, makeNode, NODE_TYPE, ROOT_NODE_ID } from '../src/lib/protocol.js';

const T = 1_700_000_000_000;
const mark = (id, title, extra = {}) =>
  makeNode({ id, parentId: ROOT_NODE_ID, type: NODE_TYPE.BOOKMARK, title, url: 'https://' + id + '.com', index: 0, updatedAt: T, ...extra });

test('待确认删除执行后 base 保留墓碑，避免下一轮复活', () => {
  const merged = new Map([
    ['keep', mark('keep', 'KEEP')],
    ['gone', mark('gone', 'GONE', { deleted: true, deletedAt: T })]
  ]);
  const localAfter = new Map([['keep', mark('keep', 'KEEP')]]);
  const base = buildBaseAfterPending({ mergedNodes: merged, localAfter });
  assert.equal(base.get('gone').deleted, true);
  assert.equal(base.get('keep').deleted, false);
});

test('落地失败（本机还在）时以实况为准', () => {
  const merged = new Map([['x', mark('x', 'X', { deleted: true, deletedAt: T })]]);
  const localAfter = new Map([['x', mark('x', 'X')]]);
  const base = buildBaseAfterPending({ mergedNodes: merged, localAfter });
  assert.equal(base.get('x').deleted, false);
});

test('确认期间新增的节点补进 base', () => {
  const merged = new Map([['a', mark('a', 'A')]]);
  const localAfter = new Map([
    ['a', mark('a', 'A')],
    ['fresh', mark('fresh', 'NEW')]
  ]);
  const base = buildBaseAfterPending({ mergedNodes: merged, localAfter });
  assert.equal(base.has('fresh'), true);
  assert.equal(base.size, 2);
});

test('空输入不抛错', () => {
  const base = buildBaseAfterPending({ mergedNodes: [], localAfter: new Map() });
  assert.equal(base.size, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDoc,
  validateDoc,
  diffVersions,
  analyze,
  activeSet,
  normalizeUrl,
  isSafeUrl,
  renderMarkdown,
  ROOT_NODE_ID
} from '../tools/verify-doc.mjs';

const T = 1_700_000_000_000;
const node = (id, extra = {}) => ({
  id,
  parentId: ROOT_NODE_ID,
  type: 'bookmark',
  title: id,
  url: 'https://' + id + '.com/',
  index: 0,
  deleted: false,
  deletedAt: 0,
  updatedAt: T,
  deviceId: 'dev-a',
  ...extra
});
const folder = (id, extra = {}) => node(id, { type: 'folder', url: '', ...extra });
const doc = (nodes, extra = {}) => ({ schemaVersion: 2, revision: 1, nodes, ...extra });

/* ---------------- 结构 ---------------- */

test('合法文档通过校验', () => {
  const r = validateDoc(doc([folder('f1'), node('a', { parentId: 'f1' }), node('b')]));
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.bookmarks, 2);
  assert.equal(r.stats.folders, 1);
});

test('坏 JSON / 顶层不是对象', () => {
  assert.equal(parseDoc('{').ok, false);
  assert.equal(parseDoc('[]').ok, false);
  assert.equal(parseDoc('"x"').ok, false);
});

test('缺 nodes 数组直接报错', () => {
  const r = validateDoc({ schemaVersion: 2 });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /nodes/);
});

test('schemaVersion 过高会拒绝', () => {
  const r = validateDoc(doc([node('a')], { schemaVersion: 99 }));
  assert.match(r.errors.join(), /高于/);
});

test('重复 id 报错', () => {
  const r = validateDoc(doc([node('a'), node('a')]));
  assert.match(r.errors.join(), /重复 id/);
});

test('书签缺 url / 非法协议报错', () => {
  const a = validateDoc(doc([node('a', { url: '' })]));
  assert.match(a.errors.join(), /没有 url/);
  const b = validateDoc(doc([node('b', { url: 'javascript:alert(1)' })]));
  assert.match(b.errors.join(), /协议不受支持/);
});

test('墓碑必须有 deletedAt', () => {
  const r = validateDoc(doc([node('a', { deleted: true, deletedAt: 0 })]));
  assert.match(r.errors.join(), /deletedAt/);
});

test('孤儿节点报错', () => {
  const r = validateDoc(doc([node('a', { parentId: 'missing' })]));
  assert.match(r.errors.join(), /孤儿/);
});

test('挂在非文件夹上报错', () => {
  const r = validateDoc(doc([node('b'), node('a', { parentId: 'b' })]));
  assert.match(r.errors.join(), /非文件夹/);
});

test('挂在已删除父节点上报错', () => {
  const r = validateDoc(doc([folder('f1', { deleted: true, deletedAt: T }), node('a', { parentId: 'f1' })]));
  assert.match(r.errors.join(), /已删除的父节点/);
});

test('循环引用被检出', () => {
  const r = validateDoc(doc([folder('a', { parentId: 'b' }), folder('b', { parentId: 'a' })]));
  assert.match(r.errors.join(), /循环引用/);
});

test('index 为负报错', () => {
  const r = validateDoc(doc([node('a', { index: -1 })]));
  assert.match(r.errors.join(), /index 为负/);
});

test('非法 type 报错', () => {
  const r = validateDoc(doc([node('a', { type: 'weird' })]));
  assert.match(r.errors.join(), /type 非法/);
});

test('保留 id root 只警告不报错', () => {
  const r = validateDoc(doc([node(ROOT_NODE_ID), node('a')]));
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join(), /保留 id/);
  assert.equal(r.stats.total, 1);
});

test('只有 root 节点（内容全丢）判为错误', () => {
  const r = validateDoc(doc([node(ROOT_NODE_ID)]));
  assert.match(r.errors.join(), /没有任何有效节点/);
});

test('空文档（nodes: []）合法 —— 用户本来就可能没有书签', () => {
  const r = validateDoc(doc([]));
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.total, 0);
});

test('空标题只警告', () => {
  const r = validateDoc(doc([node('a', { title: '' })]));
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join(), /标题为空/);
});

test('重复 URL 被统计', () => {
  const r = validateDoc(doc([node('a', { url: 'https://x.com/' }), node('b', { url: 'https://X.com' })]));
  assert.equal(r.stats.duplicateUrls, 1);
});

/* ---------------- 版本对比 ---------------- */

test('diffVersions 统计新增删除', () => {
  const prev = doc([node('a'), node('b'), node('c')]);
  const cur = doc([node('a'), node('d')]);
  const d = diffVersions(prev, cur);
  assert.equal(d.base, 3);
  assert.equal(d.current, 2);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 2);
  assert.ok(Math.abs(d.removedRatio - 2 / 3) < 1e-9);
});

test('批量删除触发 mass-delete anomaly', () => {
  const prev = doc(Array.from({ length: 20 }, (_, i) => node('n' + i)));
  const cur = doc(Array.from({ length: 5 }, (_, i) => node('n' + i)));
  const d = diffVersions(prev, cur);
  assert.equal(d.anomalies.length, 1);
  assert.equal(d.anomalies[0].kind, 'mass-delete');
});

test('小样本不误报（3 条删 1 条）', () => {
  const prev = doc([node('a'), node('b'), node('c')]);
  const cur = doc([node('a'), node('b')]);
  const d = diffVersions(prev, cur);
  assert.equal(d.anomalies.length, 0);
});

test('大量新增触发 mass-add', () => {
  const prev = doc(Array.from({ length: 10 }, (_, i) => node('old' + i)));
  const cur = doc([...Array.from({ length: 10 }, (_, i) => node('old' + i)), ...Array.from({ length: 200 }, (_, i) => node('new' + i))]);
  const d = diffVersions(prev, cur);
  assert.ok(d.anomalies.some((a) => a.kind === 'mass-add'));
});

test('activeSet 排除墓碑', () => {
  const s = activeSet(doc([node('a'), node('b', { deleted: true, deletedAt: T })]));
  assert.equal(s.size, 1);
  assert.equal(s.has('a'), true);
});

/* ---------------- 汇总 ---------------- */

test('analyze 判定三个等级', () => {
  const okRes = analyze({ text: JSON.stringify(doc([node('a')])) });
  assert.equal(okRes.verdict, 'ok');

  const badRes = analyze({ text: '{' });
  assert.equal(badRes.verdict, 'invalid');

  const prev = JSON.stringify(doc(Array.from({ length: 20 }, (_, i) => node('n' + i))));
  const cur = JSON.stringify(doc(Array.from({ length: 3 }, (_, i) => node('n' + i))));
  const sus = analyze({ text: cur, prevText: prev });
  assert.equal(sus.verdict, 'suspicious');
});

test('analyze 上一版坏了只警告', () => {
  const res = analyze({ text: JSON.stringify(doc([node('a')])), prevText: '{' });
  assert.equal(res.verdict, 'ok');
  assert.match(res.warnings.join(), /上一版无法解析/);
});

test('renderMarkdown 包含关键信息', () => {
  const res = analyze({ text: JSON.stringify(doc([folder('f'), node('a', { parentId: 'f' })])) });
  const md = renderMarkdown(res);
  assert.match(md, /书签文档校验/);
  assert.match(md, /节点总数/);
  assert.match(md, /没有发现问题/);
});

test('URL 工具与扩展侧保持一致', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM:443/Path/?q=1#frag'), 'https://example.com/Path?q=1');
  assert.equal(isSafeUrl('https://a.com'), true);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
});

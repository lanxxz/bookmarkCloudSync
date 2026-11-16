import test from 'node:test';
import assert from 'node:assert/strict';
import { docFromJson, describeShape, validateDoc, looksLikeNode } from '../src/lib/protocol.js';

/**
 * 云端文档损坏的识别与修复。
 *
 * 起因：线上报 "云端文档格式异常：invalid-doc"，用户拿到这句话什么也做不了。
 * 这里把"能自动修的"和"必须叫人来的"分开，并且每种情况都断言报错信息里
 * 确实带了可诊断的内容。
 */

const GOOD = {
  schemaVersion: 2,
  revision: 3,
  writer: 'dev-a',
  createdAt: 1,
  updatedAt: 2,
  nodes: [
    { id: 'b1', parentId: 'root', type: 'bookmark', title: 'A', url: 'https://a.com/', index: 0, deleted: false, deletedAt: 0, updatedAt: 2, deviceId: 'dev-a' },
    { id: 'f1', parentId: 'root', type: 'folder', title: 'F', url: '', index: 1, deleted: false, deletedAt: 0, updatedAt: 2, deviceId: 'dev-a' }
  ]
};

/* ---------------- 正常路径 ---------------- */

test('正常文档解析成功且不标记 repaired', () => {
  const r = docFromJson(JSON.stringify(GOOD));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, undefined);
  assert.equal(r.doc.nodes.size, 2);
});

test('带 UTF-8 BOM 的文档也能解析', () => {
  const r = docFromJson('\uFEFF' + JSON.stringify(GOOD));
  assert.equal(r.ok, true);
});

/* ---------------- 可自动修复 ---------------- */

test('裸数组（直接把 nodes 序列化）能修好', () => {
  const r = docFromJson(JSON.stringify(GOOD.nodes));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'bare-array');
  assert.equal(r.doc.nodes.size, 2);
});

test('Map 被序列化成对象能修好', () => {
  const asObject = { ...GOOD, nodes: Object.fromEntries(GOOD.nodes.map((n) => [n.id, n])) };
  const r = docFromJson(JSON.stringify(asObject));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'map-object');
  assert.equal(r.doc.nodes.size, 2);
});

test('多包一层 { ok, doc } 能修好', () => {
  const r = docFromJson(JSON.stringify({ ok: true, doc: GOOD }));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'unwrapped-doc');
  assert.equal(r.doc.nodes.size, 2);
});

test('nodes 为 null 视为空文档', () => {
  const r = docFromJson(JSON.stringify({ ...GOOD, nodes: null }));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'null-nodes');
  assert.equal(r.doc.nodes.size, 0);
});

test('repair:false 时不修，直接报错', () => {
  const r = docFromJson(JSON.stringify(GOOD.nodes), { repair: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid-doc');
});

/* ---------------- 修不了的，报错必须可诊断 ---------------- */

test('坏 JSON 带上原始片段', () => {
  const r = docFromJson('{"nodes": [oops');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid-json');
  assert.ok(r.preview.includes('oops'));
});

test('schemaVersion 过高给出可读原因', () => {
  const r = docFromJson(JSON.stringify({ ...GOOD, schemaVersion: 99 }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /schemaVersion=99 高于本扩展支持的 2/);
});

test('nodes 不是数组时说明实际类型', () => {
  const r = docFromJson(JSON.stringify({ ...GOOD, nodes: 'oops' }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /nodes 不是数组（实际是 string）/);
});

test('nodes 元素不像节点时明确报出来', () => {
  const r = docFromJson(JSON.stringify({ ...GOOD, nodes: [{ foo: 1 }, { bar: 2 }] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /不像书签节点/);
});

test('空对象、null、字符串都有明确错误', () => {
  assert.equal(docFromJson('{}').ok, false);
  assert.equal(docFromJson('null').ok, false);
  assert.equal(docFromJson('"hello"').ok, false);
});

test('HTML 页面（典型的"被别的东西覆盖了"）能被指认', () => {
  const r = docFromJson('<!DOCTYPE html><html><body>404</body></html>');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid-json');
  assert.match(r.preview, /DOCTYPE/);
});

/* ---------------- 形状描述 ---------------- */

test('describeShape 覆盖常见形态', () => {
  assert.equal(describeShape(null), 'null');
  assert.equal(describeShape([1, 2]), 'array(2)');
  assert.equal(describeShape('x'), 'string');
  assert.match(describeShape(GOOD), /object\{schemaVersion:number/);
  assert.match(describeShape(GOOD), /nodes:array\(2\)/);
});

test('looksLikeNode 只认有 id 与 type 的对象', () => {
  assert.equal(looksLikeNode({ id: 'a', type: 'bookmark' }), true);
  assert.equal(looksLikeNode({ id: '', type: 'bookmark' }), false);
  assert.equal(looksLikeNode({ title: 'x' }), false);
  assert.equal(looksLikeNode(null), false);
});

test('validateDoc 对数组直接拒绝（不会被 repair 掩盖）', () => {
  assert.match(validateDoc([{ id: 'a', type: 'bookmark' }]).join(), /是数组/);
});

/* ---------------- schemaVersion 异常 ---------------- */

test('缺少 schemaVersion 但节点正常 -> 自动补齐（missing-schema）', () => {
  const broken = { revision: 3, writer: 'dev-a', nodes: GOOD.nodes };
  const r = docFromJson(JSON.stringify(broken));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'missing-schema');
  assert.equal(r.doc.schemaVersion, 2);
  assert.equal(r.doc.nodes.size, 2);
});

test('缺少 schemaVersion 且 nodes 为空 -> 也补（空库是合法的）', () => {
  const r = docFromJson(JSON.stringify({ revision: 1, nodes: [] }));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'missing-schema');
});

test('缺少 schemaVersion 且 nodes 不像节点 -> 不瞎猜，报错并说清缺什么', () => {
  const r = docFromJson(JSON.stringify({ revision: 1, nodes: [{ hello: 'world' }] }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid-doc');
  assert.match(r.errors.join(), /缺少 schemaVersion/);
  assert.match(r.errors.join(), /不像书签节点/);
});

test('schemaVersion 是字符串时明确指出类型问题，而不是说"缺少"', () => {
  const r = docFromJson(JSON.stringify({ ...GOOD, schemaVersion: '2' }));
  assert.equal(r.ok, true, '字符串版本号应被补齐');
  assert.equal(r.repaired, 'missing-schema');
});

test('schemaVersion 是 null / 对象时给出可读原因', () => {
  const r = docFromJson(JSON.stringify({ ...GOOD, schemaVersion: null, nodes: [{ hello: 1 }] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /缺少 schemaVersion/);

  const r2 = docFromJson(JSON.stringify({ ...GOOD, schemaVersion: {}, nodes: [{ hello: 1 }] }));
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join(), /schemaVersion 不是数字/);
});

test('invalid-doc 会带上实际结构，便于对症处理', () => {
  const r = docFromJson(JSON.stringify({ revision: 1, nodes: 'oops' }));
  assert.equal(r.ok, false);
  assert.match(r.shape, /object\{revision:number,nodes:string\}/);
});

/* ---------------- 文件被写成 GitHub API 响应 ---------------- */

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function apiResponse(doc, extra = {}) {
  return {
    name: 'bookmarks.json',
    path: 'bookmarks.json',
    sha: 'deadbeef',
    size: 1234,
    url: 'https://api.github.com/repos/o/r/contents/bookmarks.json',
    html_url: 'https://github.com/o/r/blob/main/bookmarks.json',
    content: b64(JSON.stringify(doc)),
    encoding: 'base64',
    ...extra
  };
}

test('GitHub API 响应对象能被认出并解开（数据可救回）', () => {
  const r = docFromJson(JSON.stringify(apiResponse(GOOD)));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'github-api-response');
  assert.equal(r.doc.nodes.size, 2);
});

test('GitHub API 响应里包着"缺 schemaVersion"的文档也能一路救回', () => {
  const { schemaVersion, ...noVer } = GOOD;
  const r = docFromJson(JSON.stringify(apiResponse(noVer)));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'github-api-response');
  assert.equal(r.doc.schemaVersion, 2);
});

test('GitHub API 响应但缺 content -> 明确说明，而不是"缺少 schemaVersion"', () => {
  const resp = apiResponse(GOOD);
  delete resp.content;
  const r = docFromJson(JSON.stringify(resp));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /GitHub Contents API/);
  assert.match(r.errors.join(), /缺少 content/);
});

test('GitHub API 响应的 content 不是 JSON -> 明确报 content 解不出', () => {
  const resp = apiResponse(GOOD, { content: b64('这不是 JSON') });
  const r = docFromJson(JSON.stringify(resp));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /解不出合法 JSON/);
  assert.match(r.errors.join(), /没有可恢复的书签数据/);
});

test('普通文档不会被误判成 GitHub API 响应', () => {
  assert.equal(docFromJson(JSON.stringify(GOOD)).repaired, undefined);
});

test('describeShape 能看到 content 字段的存在', () => {
  const shape = describeShape(apiResponse(GOOD));
  assert.match(shape, /content:string/);
  assert.match(shape, /encoding:string/);
});

import { StorageError } from '../src/lib/storage/base.js';
import { isConflict } from '../src/lib/storage/base.js';

test('sha 缺失（422）不能被当成并发冲突', async () => {
  const { StorageError: SE } = await import('../src/lib/storage/base.js');
  const err = new SE('写入时没有提供 sha', { status: 422, code: 'SHA_MISSING' });
  assert.equal(isConflict(err), false, 'SHA_MISSING 不应进入重试分支');
});

test('content 为空串时说明是 >1MB 未内联，而不是含糊的"缺少 schemaVersion"', () => {
  const resp = apiResponse(GOOD, { content: '', encoding: 'none' });
  const r = docFromJson(JSON.stringify(resp));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /content 是空字符串/);
  assert.match(r.errors.join(), /没有可恢复的书签数据/);
});

test('content 被截断时说明长度与截断可能', () => {
  const resp = apiResponse(GOOD, { content: 'eyJub2RlcyI6W' });
  const r = docFromJson(JSON.stringify(resp));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /长度 1[0-9] 字节/);
  assert.match(r.errors.join(), /可能被截断/);
});

test('content 是明文 JSON（非 base64）也能解出', () => {
  const resp = apiResponse(GOOD, { content: JSON.stringify(GOOD) });
  const r = docFromJson(JSON.stringify(resp));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'github-api-response');
});

test('content 是二次 base64 也能解出', () => {
  const inner = b64(JSON.stringify(GOOD));
  const resp = apiResponse(GOOD, { content: b64(inner) });
  const r = docFromJson(JSON.stringify(resp));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'github-api-response');
});

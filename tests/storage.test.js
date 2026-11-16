import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toBase64Utf8,
  fromBase64Utf8,
  sanitizePath,
  StorageError,
  isConflict,
  isAuthError
} from '../src/lib/storage/base.js';

/* ---------------- base64：书签标题基本都是中文，必须 UTF-8 无损 ---------------- */

test('base64 往返保留中文与 emoji', () => {
  const text = '书签栏 · 工作 📚 https://例子.com/路径?q=中文';
  assert.equal(fromBase64Utf8(toBase64Utf8(text)), text);
});

test('base64 与标准实现一致（可被 GitHub 正常解码）', () => {
  const text = '{"title":"中文"}';
  const expected = Buffer.from(text, 'utf8').toString('base64');
  assert.equal(toBase64Utf8(text), expected);
});

test('base64 处理超长文本（跨 32KB 分块边界）', () => {
  const text = '书'.repeat(50000);
  assert.equal(fromBase64Utf8(toBase64Utf8(text)), text);
});

test('base64 解码忽略换行与空白', () => {
  const b64 = toBase64Utf8('hello');
  const wrapped = b64.slice(0, 2) + '\n' + b64.slice(2);
  assert.equal(fromBase64Utf8(wrapped), 'hello');
});

/* ---------------- 路径 ---------------- */

test('sanitizePath 去掉危险段', () => {
  assert.equal(sanitizePath('../etc/passwd'), 'etc/passwd');
  assert.equal(sanitizePath('/absolute/path/bookmarks.json'), 'absolute/path/bookmarks.json');
  assert.equal(sanitizePath('a/./b/../c.json'), 'a/b/c.json');
});

test('sanitizePath 空值走默认', () => {
  assert.equal(sanitizePath(''), 'bookmarks.json');
  assert.equal(sanitizePath('   '), 'bookmarks.json');
  assert.equal(sanitizePath(null), 'bookmarks.json');
});

test('sanitizePath 反斜杠归一为正斜杠', () => {
  assert.equal(sanitizePath('dir\\bookmarks.json'), 'dir/bookmarks.json');
});

test('sanitizePath 限制层级（最多 3 段）', () => {
  const out = sanitizePath('a/b/c/d/e/bookmarks.json');
  assert.equal(out.split('/').length <= 3, true);
  assert.equal(out.endsWith('bookmarks.json'), true);
});

/* ---------------- 错误判定 ---------------- */

test('isConflict 识别 409/412 与 CONFLICT 码', () => {
  assert.equal(isConflict({ code: 'CONFLICT' }), true);
  assert.equal(isConflict({ status: 412 }), true);
  assert.equal(isConflict({ status: 409 }), true);
  assert.equal(isConflict({ status: 500 }), false);
});

test('isAuthError 识别鉴权失败', () => {
  assert.equal(isAuthError({ status: 401 }), true);
  assert.equal(isAuthError({ code: 'AUTH_REQUIRED' }), true);
  assert.equal(isAuthError({ status: 403 }), false);
});

test('StorageError 保留 code 与 status', () => {
  const err = new StorageError('boom', { status: 422, code: 'CONFLICT', retryable: true });
  assert.equal(err.code, 'CONFLICT');
  assert.equal(err.status, 422);
  assert.equal(err.retryable, true);
  assert.equal(err.name, 'StorageError');
});

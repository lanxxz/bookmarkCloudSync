import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, isSafeBookmarkUrl, sanitizeTitle, hashString, mapLimit, chunk, formatRelative, truncate } from '../src/lib/util.js';

test('normalizeUrl 归一小写/默认端口/尾斜杠/hash', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM:443/Path/?q=1#frag'), 'https://example.com/Path?q=1');
  assert.equal(normalizeUrl('http://example.com:80'), 'http://example.com/');
  assert.equal(normalizeUrl('  '), '');
});

test('normalizeUrl 对非法 URL 退化为小写原文', () => {
  assert.equal(normalizeUrl('Not A Url'), 'not a url');
});

test('isSafeBookmarkUrl 拦截 javascript: 之类', () => {
  assert.equal(isSafeBookmarkUrl('https://a.com'), true);
  assert.equal(isSafeBookmarkUrl('chrome://bookmarks'), true);
  assert.equal(isSafeBookmarkUrl('javascript:alert(1)'), false);
  assert.equal(isSafeBookmarkUrl(''), false);
});

test('sanitizeTitle 去控制字符并截断', () => {
  assert.equal(sanitizeTitle('a\u0000b'), 'ab');
  assert.equal(sanitizeTitle('x'.repeat(600)).length, 512);
});

test('hashString 稳定且不同输入不同结果', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});

test('mapLimit 保序并限制并发', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2, 'peak concurrency should be <= 2, got ' + peak);
});

test('chunk 分组', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('truncate 截断', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate(123, 3), '');
});

test('formatRelative 处理空值与近期', () => {
  assert.equal(formatRelative(0), '从未');
  assert.equal(formatRelative(Date.now()), '刚刚');
});

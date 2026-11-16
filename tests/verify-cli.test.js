import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * CLI 契约测试：确保退出码真的能被 CI 用 if 判断。
 * 退出码是 CI 唯一能读懂的语言，写错了整条流水线就失效。
 */

const SCRIPT = 'tools/verify-doc.mjs';

function run(args, cwd) {
  try {
    const stdout = execFileSync('node', [SCRIPT.startsWith('/') ? SCRIPT : join(process.cwd(), SCRIPT), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

function tmpDoc(name, doc) {
  const dir = mkdtempSync(join(tmpdir(), 'bcs-verify-'));
  const file = join(dir, name);
  writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf8');
  return { dir, file };
}

const mk = (i, extra = {}) => ({
  id: 'b_' + i,
  parentId: 'root',
  type: 'bookmark',
  title: 't' + i,
  url: 'https://e.com/' + i,
  index: i,
  deleted: false,
  deletedAt: 0,
  updatedAt: 1700000000000,
  deviceId: 'd',
  ...extra
});

test('合法文档退出码 0', () => {
  const { dir, file } = tmpDoc('ok.json', { schemaVersion: 2, revision: 1, nodes: [mk(0), mk(1)] });
  const r = run([file], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /正常/);
  rmSync(dir, { recursive: true, force: true });
});

test('结构错误退出码 1', () => {
  const { dir, file } = tmpDoc('bad.json', { schemaVersion: 2, revision: 1, nodes: [mk(0, { url: '' })] });
  const r = run([file], dir);
  assert.equal(r.code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('坏 JSON 退出码 1', () => {
  const { dir, file } = tmpDoc('broken.json', '{ not json');
  const r = run([file], dir);
  assert.equal(r.code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('批量删除退出码 2，且能配合 --prev 指定对比文件', () => {
  const prev = { schemaVersion: 2, revision: 1, nodes: Array.from({ length: 30 }, (_, i) => mk(i)) };
  const cur = { schemaVersion: 2, revision: 2, nodes: Array.from({ length: 30 }, (_, i) => mk(i, { deleted: i >= 5, deletedAt: 1700000001000 })) };
  const a = tmpDoc('prev.json', prev);
  const b = tmpDoc('cur.json', cur);
  const r = run([b.file, '--prev', a.file], b.dir);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /可疑变更/);
  assert.match(r.stdout, /mass-delete/);
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

test('--json 输出可被机器解析', () => {
  const { dir, file } = tmpDoc('ok.json', { schemaVersion: 2, revision: 1, nodes: [mk(0)] });
  const r = run([file, '--json'], dir);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'ok');
  assert.equal(parsed.stats.total, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('文件不存在时退出码非 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bcs-verify-'));
  const r = run([join(dir, 'nope.json')], dir);
  assert.notEqual(r.code, 0);
  rmSync(dir, { recursive: true, force: true });
});

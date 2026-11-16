import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * 跨模块引用检查器自身的测试。
 *
 * 这套工具存在的唯一理由，是上次那个 "docFromJson is not defined"：
 * 用了某个模块的导出却忘了 import。所以除了"现在能通过"，
 * 更要紧的是"人为制造同类错误时它真的会红"。
 */

function runChecker(cwd) {
  try {
    const stdout = execFileSync('node', [join(process.cwd(), 'tools/check-undefined.mjs')], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

test('当前代码库通过跨模块检查', () => {
  const r = runChecker();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /检查通过/);
});

test('sync.js 正确 import 了 docFromJson', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(process.cwd(), 'src/lib/sync.js'), 'utf8');
  const header = src.slice(0, src.indexOf("} from './protocol.js'"));
  assert.match(header, /docFromJson/, '防止回归：上次就是这里漏了');
});

test('sync.js 不再直接使用 requireToken（应走 resolveToken 以支持双后端）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(process.cwd(), 'src/lib/sync.js'), 'utf8');
  assert.equal(/\brequireToken\(/.test(src), false, 'requireToken 只适用于 Drive 后端');
  assert.match(src, /resolveToken\(/);
});

test('storage/index.js 不再把 StorageError 重导出成 Error', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(process.cwd(), 'src/lib/storage/index.js'), 'utf8');
  // 注释里会提到这段历史，所以先剥掉注释再匹配
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.equal(/export\s*\{\s*StorageError\s+as\s+Error\s*\}/.test(code), false);
});

test('alarms.js 正确 import 了 getMeta', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(process.cwd(), 'src/background/alarms.js'), 'utf8');
  assert.match(src, /getMeta/);
  assert.match(src, /from '\.\.\/lib\/idb\.js'/);
});

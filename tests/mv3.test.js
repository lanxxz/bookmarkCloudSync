import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * MV3 兼容性守门测试。
 *
 * 这条限制很阴：动态 import() 在 Node 里完全正常，只有在 ServiceWorkerGlobalScope
 * 上才被禁止。所以必须有静态检查，而且这个检查本身要被测试覆盖。
 */

function runCheck(cwd) {
  try {
    const stdout = execFileSync('node', [join(process.cwd(), 'tools/mv3-check.mjs')], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

test('当前代码库通过 MV3 检查', () => {
  const r = runCheck();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /无动态 import/);
  assert.match(r.stdout, /无循环依赖/);
});

test('源码里不存在任何 import() 表达式', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const root = join(process.cwd(), 'src');
  const bad = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = j(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) {
        const lines = readFileSync(p, 'utf8').split('\n');
        lines.forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('*') || t.startsWith('//')) return;
          if (/(^|[^.\w$])import\s*\(/.test(line)) bad.push(p + ':' + (i + 1));
        });
      }
    }
  };
  walk(root);
  assert.deepEqual(bad, []);
});

test('service-worker 在 chrome 桩下能装载（静态 import 全部可解析）', async () => {
  /*
   * 这条测试两个作用：
   *  1. 证明 service-worker.js 的整条静态 import 链在真实模块系统里能走通，
   *     不存在的具名导出会在这里抛 SyntaxError（而不是等到浏览器里）；
   *  2. 顺带守住"entry 不能有 top-level 副作用依赖 DOM"这条底线。
   */
  const listeners = { addListener() {}, removeListener() {} };
  const noop = () => {};
  const asyncNoop = async () => ({});
  const store = new Map();

  globalThis.chrome = {
    runtime: {
      onInstalled: listeners,
      onStartup: listeners,
      onMessage: listeners,
      getURL: (p) => 'chrome-extension://test/' + p,
      getManifest: () => ({ version: '1.2.0' }),
      sendMessage: asyncNoop,
      openOptionsPage: noop
    },
    storage: {
      local: {
        async get(k) {
          return typeof k === 'string' ? (store.has(k) ? { [k]: store.get(k) } : {}) : Object.fromEntries(store);
        },
        async set(o) {
          for (const [k, v] of Object.entries(o)) store.set(k, v);
        },
        async remove(k) {
          store.delete(k);
        }
      }
    },
    bookmarks: {
      getTree(cb) {
        cb([{ id: '0', children: [{ id: '1', title: '书签栏', children: [] }] }]);
      },
      getSubTree(id, cb) {
        cb([{ id, children: [] }]);
      },
      get(id, cb) {
        cb([]);
      },
      create(info, cb) {
        cb({ id: 'n1', ...info });
      },
      update(id, c, cb) {
        cb({ id, ...c });
      },
      move(id, d, cb) {
        cb({ id, ...d });
      },
      remove(id, cb) {
        cb();
      },
      removeTree(id, cb) {
        cb();
      },
      onCreated: listeners,
      onRemoved: listeners,
      onChanged: listeners,
      onMoved: listeners,
      onChildrenReordered: listeners,
      onImportEnded: listeners
    },
    alarms: { async clear() { return true; }, create: noop, onAlarm: listeners },
    identity: { getRedirectURL: (p) => 'https://test.chromiumapp.org/' + p, launchWebAuthFlow: asyncNoop },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    contextMenus: { removeAll(cb) { if (cb) cb(); }, create: noop, onClicked: listeners },
    notifications: { create: noop },
    tabs: { async create() {} }
  };

  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await import('../src/background/service-worker.js');
    // 装载成功即说明静态 import 链完整；若缺具名导出，模块链接阶段就会抛
    assert.ok(true);
  } finally {
    console.error = origError;
  }
});

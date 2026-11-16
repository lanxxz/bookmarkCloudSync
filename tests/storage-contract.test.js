import test from 'node:test';
import assert from 'node:assert/strict';
import * as driveBackend from '../src/lib/storage/drive.js';
import * as githubBackend from '../src/lib/storage/github.js';
import { BACKEND_INTERFACE, missingBackendMethods, BACKENDS, backendFor, resolveBackend } from '../src/lib/storage/index.js';

/**
 * 后端接口契约。
 *
 * 之前 GitHub 后端只实现了 readFile/writeFile 这套底层名字，
 * 上层调的却是 readDoc —— 静态 import 检查（缺具名导出）看不出来，
 * Node 里跑测试也走不到那条分支，只有真正切到 GitHub 后端才炸：
 *   "backend.readDoc is not a function"
 * 所以把"两端必须同名同形"写成可执行的断言。
 */

for (const [label, backend] of [
  ['drive', driveBackend],
  ['github', githubBackend]
]) {
  test(label + ' 实现了全部接口方法', () => {
    const missing = missingBackendMethods(backend);
    assert.deepEqual(missing, [], label + ' 缺少：' + missing.join(', '));
  });

  test(label + ' 的方法都是函数', () => {
    for (const name of BACKEND_INTERFACE) {
      assert.equal(typeof backend[name], 'function', label + '.' + name);
    }
  });

  test(label + ' cfgFromSettings 返回 path 与 branch', () => {
    const settings =
      label === 'github'
        ? { githubOwner: 'me', githubRepo: 'bm', githubBranch: 'main', githubPath: 'bookmarks.json' }
        : { driveFile: 'bookmarks.json' };
    const cfg = backend.cfgFromSettings(settings);
    assert.equal(typeof cfg.path, 'string');
    assert.ok(cfg.path.length > 0);
    if (label === 'github') assert.equal(typeof cfg.branch, 'string');
  });
}

test('两个后端的接口集合完全一致（不多不少）', () => {
  for (const name of BACKEND_INTERFACE) {
    assert.equal(typeof driveBackend[name], typeof githubBackend[name], '签名不一致：' + name);
  }
});

test('backendFor 按设置返回正确后端', () => {
  assert.equal(resolveBackend({}), BACKENDS.DRIVE);
  assert.equal(resolveBackend({ backend: 'drive' }), BACKENDS.DRIVE);
  assert.equal(resolveBackend({ backend: 'github' }), BACKENDS.GITHUB);
  assert.equal(resolveBackend({ backend: 'nonsense' }), BACKENDS.DRIVE);
  assert.equal(backendFor({ backend: 'github' }).name, 'github');
  assert.equal(typeof backendFor({ backend: 'github' }).backend.readDoc, 'function');
});

test('老配置（没有 backend 字段）仍走 Drive，行为不回归', () => {
  const legacy = { clientId: 'x.apps.googleusercontent.com', driveFile: 'bookmarks.json' };
  assert.equal(resolveBackend(legacy), BACKENDS.DRIVE);
  assert.equal(backendFor(legacy).name, 'drive');
});

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * GitHub 后端端到端：走真实统一接口（readDoc/writeDoc/saveSnapshot/...），
 * 只把网络层换成内存假仓库。
 *
 * 这正是 "backend.readDoc is not a function" 漏掉的那条路径 ——
 * 之前的单元测试只测 readFile/writeFile 这些底层函数，
 * 上层调的统一接口从来没被真正执行过。
 */

const CFG = { owner: 'me', repo: 'bm', branch: 'main', path: 'bookmarks.json' };
const TOKEN = 'ghp_test';

/** 内存版 GitHub Contents API */
function makeRepo() {
  const files = new Map(); // path -> { content, sha }

  let seq = 0;
  const nextSha = () => 'sha' + ++seq;

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const raw = String(url).replace('https://api.github.com', '');
    const pathPart = raw.split('?')[0];
    const qs = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '');

    const m = /^\/repos\/me\/bm\/contents\/(.+)$/.exec(pathPart);
    const json = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: async () => JSON.stringify(body)
    });

    // 目录列表
    if (m && !m[1].includes('.') && method === 'GET') {
      const dir = decodeURIComponent(m[1]);
      const entries = [];
      for (const [p, f] of files) {
        if (p.startsWith(dir + '/')) {
          entries.push({ type: 'file', name: p.slice(dir.length + 1), path: p, sha: f.sha, size: f.content.length });
        }
      }
      return entries.length ? json(entries) : json({ message: 'Not Found' }, 404);
    }

    const path = m ? decodeURIComponent(m[1]) : null;
    if (!path) return json({ message: 'Not Found' }, 404);

    if (method === 'GET') {
      const accept = String((init.headers && init.headers.Accept) || '');
      const cur = files.get(path);
      if (!cur) return json({ message: 'Not Found' }, 404);
      if (accept.includes('raw')) {
        return { ok: true, status: 200, headers: new Headers(), text: async () => cur.content };
      }
      return json({
        sha: cur.sha,
        size: cur.content.length,
        encoding: 'base64',
        content: Buffer.from(cur.content, 'utf8').toString('base64')
      });
    }

    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      const cur = files.get(path);
      if (cur && body.sha !== cur.sha) {
        return json({ message: 'bookmarks.json is at ' + cur.sha + ' but expected ' + body.sha }, 409);
      }
      if (!cur && body.sha) {
        return json({ message: 'sha does not exist' }, 422);
      }
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      const sha = nextSha();
      files.set(path, { content: text, sha });
      return json({ content: { sha }, commit: { sha: 'c' + seq } });
    }

    if (method === 'DELETE') {
      const body = JSON.parse(init.body);
      const cur = files.get(path);
      if (!cur) return json({ message: 'Not Found' }, 404);
      if (body.sha && body.sha !== cur.sha) return json({ message: 'Conflict' }, 409);
      files.delete(path);
      return json({ commit: { sha: 'del' + ++seq } });
    }

    if (pathPart === '/repos/me/bm/commits') {
      return json([{ sha: 'c1', commit: { message: 'sync', author: { date: '2026-01-01T00:00:00Z' } } }]);
    }

    return json({ message: 'Not Found' }, 404);
  };

  return files;
}

const gh = await import('../src/lib/storage/github.js');
const { missingBackendMethods } = await import('../src/lib/storage/index.js');

function doc(n) {
  return JSON.stringify({
    schemaVersion: 2,
    revision: n,
    writer: 'dev-t',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'b1', parentId: 'root', type: 'bookmark', title: '中文', url: 'https://e.com/', index: 0, deleted: false, deletedAt: 0, updatedAt: 2, deviceId: 'dev-t' }]
  });
}

test('统一接口在 GitHub 后端上完全可用（就是这次报错的那条路径）', async () => {
  assert.deepEqual(missingBackendMethods(gh), []);
});

test('readDoc 首次返回 exists:false，写入后能读回', async () => {
  const files = makeRepo();
  const first = await gh.readDoc(CFG, { token: TOKEN });
  assert.equal(first.exists, false);

  const w = await gh.writeDoc(CFG, doc(1), { token: TOKEN, message: 'init' });
  assert.ok(w.version);
  assert.equal(files.has('bookmarks.json'), true);

  const second = await gh.readDoc(CFG, { token: TOKEN });
  assert.equal(second.exists, true);
  assert.equal(second.version, w.version);
  assert.equal(JSON.parse(second.text).nodes[0].title, '中文');
});

test('writeDoc 用旧 sha 写会 CONFLICT（乐观锁生效）', async () => {
  makeRepo();
  const w1 = await gh.writeDoc(CFG, doc(1), { token: TOKEN });
  // 模拟另一台设备先写
  await gh.writeDoc(CFG, doc(2), { token: TOKEN, version: w1.version });

  await assert.rejects(
    () => gh.writeDoc(CFG, doc(3), { token: TOKEN, version: w1.version }),
    (err) => err.code === 'CONFLICT'
  );
});

test('headDoc 只取版本，能检测到变化', async () => {
  makeRepo();
  const w1 = await gh.writeDoc(CFG, doc(1), { token: TOKEN });
  const h1 = await gh.headDoc(CFG, { token: TOKEN });
  assert.equal(h1.sha, w1.version);

  await gh.writeDoc(CFG, doc(2), { token: TOKEN, version: h1.sha });
  const h2 = await gh.headDoc(CFG, { token: TOKEN });
  assert.notEqual(h2.sha, h1.sha);
});

test('快照：写入 -> 列表 -> 读回 -> 裁剪', async () => {
  const files = makeRepo();
  for (let i = 0; i < 4; i++) {
    const ts = 1730000000000 + i * 60000;
    await gh.saveSnapshot(CFG, { name: 'snap-' + new Date(ts).toISOString().replace(/[:.]/g, '-') + '_dev-x_pre-sync.json', text: doc(i), token: TOKEN });
  }
  assert.equal([...files.keys()].filter((k) => k.startsWith('bcs-history/')).length, 4);

  const list = await gh.listSnapshots(CFG, { token: TOKEN, limit: 10 });
  assert.equal(list.length, 4);
  assert.ok(list[0].ts >= list[3].ts, '应按时间倒序');
  assert.ok(list[0].id.startsWith('bcs-history/'));

  const one = await gh.readSnapshot(CFG, list[0].id, { token: TOKEN });
  assert.equal(JSON.parse(one.text).schemaVersion, 2);

  const pruned = await gh.pruneSnapshots(CFG, { token: TOKEN, keep: 2 });
  assert.equal(pruned.removed, 2);
  assert.equal((await gh.listSnapshots(CFG, { token: TOKEN })).length, 2);
});

test('readSnapshot 拒绝路径穿越', async () => {
  makeRepo();
  await assert.rejects(() => gh.readSnapshot(CFG, '../../etc/passwd', { token: TOKEN }), (err) => err.code === 'BAD_SNAPSHOT_PATH');
});

test('readAtVersion 能按 commit 读回历史文档', async () => {
  makeRepo();
  await gh.writeDoc(CFG, doc(7), { token: TOKEN });
  const res = await gh.readAtVersion(CFG, { commit: 'c1', token: TOKEN });
  assert.equal(JSON.parse(res.text).revision, 7);
});

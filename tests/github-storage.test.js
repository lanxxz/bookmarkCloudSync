import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * GitHub 后端的契约测试：用假的 fetch 模拟 GitHub Contents API。
 * 重点验证三件事：
 *  1. 读文档时能正确解 base64（中文标题）；
 *  2. 写文档时带上 sha，云端被别人改过会抛 CONFLICT（而不是静默覆盖）；
 *  3. 大文件（>1MB，encoding: 'none'）会退回 raw 拉取。
 */

const CFG = { owner: 'me', repo: 'bookmarks', branch: 'main', path: 'bookmarks.json' };
const TOKEN = 'ghp_test';

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

const DOC = { schemaVersion: 2, revision: 3, nodes: [{ id: 'a', title: '中文书签', url: 'https://例子.com/' }] };

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const path = String(url).replace('https://api.github.com', '');
    const key = (init.method || 'GET') + ' ' + path.split('?')[0];
    const handler = routes[key] || routes[(init.method || 'GET') + ' ' + path];
    if (!handler) return jsonRes({ message: 'Not Found' }, { status: 404 });
    return handler(init, path);
  };
  return calls;
}

const { readFile, writeFile, headFile, listDir, listCommits, cfgFromSettings } = await import('../src/lib/storage/github.js');
const { StorageError, isConflict } = await import('../src/lib/storage/base.js');

test('readFile 解出 UTF-8 中文内容', async () => {
  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({
        sha: 'sha-1',
        size: 100,
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(DOC), 'utf8').toString('base64')
      })
  });
  const res = await readFile(CFG, 'bookmarks.json', { token: TOKEN });
  assert.equal(res.exists, true);
  assert.equal(res.version, 'sha-1');
  assert.equal(JSON.parse(res.text).nodes[0].title, '中文书签');
});

test('readFile 对 encoding=none 的大文件改走 raw', async () => {
  const raw = JSON.stringify(DOC);
  let sawRaw = false;
  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': (init) => {
      const accept = String(init.headers.Accept || '');
      if (accept.includes('raw')) {
        sawRaw = true;
        return jsonRes(raw);
      }
      return jsonRes({ sha: 'sha-big', size: 5_000_000, encoding: 'none', content: '' });
    }
  });
  const res = await readFile(CFG, 'bookmarks.json', { token: TOKEN });
  assert.equal(sawRaw, true);
  assert.equal(res.size, 5_000_000);
  assert.equal(JSON.parse(res.text).revision, 3);
});

test('readFile 文件不存在时返回 exists:false', async () => {
  installFetch({});
  const res = await readFile(CFG, 'bookmarks.json', { token: TOKEN });
  assert.equal(res.exists, false);
});

test('writeFile 带上 sha 且能返回新版本', async () => {
  const calls = installFetch({
    'PUT /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({ content: { sha: 'sha-2' }, commit: { sha: 'commit-2' } })
  });
  const res = await writeFile(CFG, 'bookmarks.json', '{"a":1}', { token: TOKEN, version: 'sha-1', message: 'sync' });
  assert.equal(res.version, 'sha-2');
  assert.equal(res.commit, 'commit-2');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.sha, 'sha-1', '必须带旧 sha 做乐观锁');
  assert.equal(body.branch, 'main');
  assert.equal(Buffer.from(body.content, 'base64').toString('utf8'), '{"a":1}');
});

test('writeFile 遇到 409 抛 CONFLICT（上层据此重读重合并）', async () => {
  installFetch({
    'PUT /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({ message: 'is at abc but expected def' }, { status: 409 })
  });
  await assert.rejects(
    () => writeFile(CFG, 'bookmarks.json', '{}', { token: TOKEN, version: 'stale' }),
    (err) => {
      assert.equal(err instanceof StorageError, true);
      assert.equal(err.code, 'CONFLICT');
      return true;
    }
  );
});

test('401 抛 TOKEN_INVALID，403 限流抛 RATE_LIMITED', async () => {
  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': () => jsonRes({ message: 'Bad credentials' }, { status: 401 })
  });
  await assert.rejects(() => readFile(CFG, 'bookmarks.json', { token: TOKEN }), (err) => err.code === 'TOKEN_INVALID');

  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } })
  });
  await assert.rejects(() => readFile(CFG, 'bookmarks.json', { token: TOKEN }), (err) => err.code === 'RATE_LIMITED');
});

test('headFile 只取 sha，不下载正文', async () => {
  let downloads = 0;
  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': (init) => {
      downloads++;
      assert.equal(String(init.headers.Accept || '').includes('raw'), false);
      return jsonRes({ sha: 'sha-x', size: 42, path: 'bookmarks.json' });
    }
  });
  const head = await headFile(CFG, 'bookmarks.json', { token: TOKEN });
  assert.equal(head.sha, 'sha-x');
  assert.equal(downloads, 1);
});

test('listDir 目录不存在时返回空数组', async () => {
  installFetch({});
  const files = await listDir(CFG, 'bcs-history', { token: TOKEN });
  assert.deepEqual(files, []);
});

test('listCommits 请求 path 与 sha 参数', async () => {
  let seen = '';
  installFetch({
    'GET /repos/me/bookmarks/commits': (_init, path) => {
      seen = path;
      return jsonRes([{ sha: 'c1', commit: { message: 'sync', author: { date: '2026-01-01T00:00:00Z' } } }]);
    }
  });
  const commits = await listCommits(CFG, 'bookmarks.json', { token: TOKEN, limit: 5 });
  assert.equal(commits.length, 1);
  assert.match(seen, /path=bookmarks\.json/);
  assert.match(seen, /per_page=5/);
});

test('cfgFromSettings 缺仓库时抛 NOT_CONFIGURED', () => {
  assert.throws(() => cfgFromSettings({ githubOwner: '', githubRepo: '' }), (err) => err.code === 'NOT_CONFIGURED');
  const cfg = cfgFromSettings({ githubOwner: 'me', githubRepo: 'bm', githubBranch: '', githubPath: '' });
  assert.equal(cfg.branch, 'main');
  assert.equal(cfg.path, 'bookmarks.json');
});

test('写文件时缺 sha 报 SHA_MISSING，而不是 CONFLICT', async () => {
  installFetch({
    'PUT /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, { status: 422 })
  });
  await assert.rejects(
    () => writeFile(CFG, 'bookmarks.json', '{}', { token: TOKEN }),
    (err) => {
      assert.equal(err.code, 'SHA_MISSING');
      assert.equal(isConflict(err), false, '不能进并发重试分支');
      assert.match(err.message, /没有提供 sha/);
      return true;
    }
  );
});

test('写文件时 sha 不匹配仍报 CONFLICT', async () => {
  installFetch({
    'PUT /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({ message: 'bookmarks.json does not match 1111111' }, { status: 409 })
  });
  await assert.rejects(
    () => writeFile(CFG, 'bookmarks.json', '{}', { token: TOKEN, version: 'wrong' }),
    (err) => {
      assert.equal(err.code, 'CONFLICT');
      assert.equal(isConflict(err), true);
      return true;
    }
  );
});

test('带 sha 的写入会被请求体携带（GitHub 更新文件的硬性要求）', async () => {
  let seen = null;
  installFetch({
    'PUT /repos/me/bookmarks/contents/bookmarks.json': (init) => {
      seen = JSON.parse(init.body);
      return jsonRes({ content: { sha: 'newsha' }, commit: { sha: 'c1' } });
    }
  });
  const res = await writeFile(CFG, 'bookmarks.json', '{"a":1}', { token: TOKEN, version: 'oldsha' });
  assert.equal(seen.sha, 'oldsha');
  assert.equal(res.version, 'newsha');
});

test('readFile 自动解包"文件内容是 API 响应对象"的情况', async () => {
  const inner = Buffer.from(JSON.stringify(DOC), 'utf8').toString('base64');
  const apiResp = {
    name: 'bookmarks.json', path: 'bookmarks.json', sha: 'sha-1', size: 500,
    url: 'u', html_url: 'h', git_url: 'g', download_url: 'd', type: 'file',
    content: inner, encoding: 'base64'
  };
  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({
        sha: 'sha-1', size: 900, encoding: 'base64',
        content: Buffer.from(JSON.stringify(apiResp), 'utf8').toString('base64')
      })
  });
  const res = await readFile(CFG, 'bookmarks.json', { token: TOKEN });
  assert.equal(res.exists, true);
  assert.equal(res.unwrapped, true, '应标记已解包');
  const doc = JSON.parse(res.text);
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.nodes[0].title, '中文书签');
});

test('readFile 遇到 content 为空壳时原样返回，不假装成功', async () => {
  const apiResp = {
    name: 'bookmarks.json', path: 'bookmarks.json', sha: 'sha-1', size: 900,
    url: 'u', html_url: 'h', git_url: 'g', download_url: 'd', type: 'file',
    content: '', encoding: 'none'
  };
  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({
        sha: 'sha-1', size: 900, encoding: 'base64',
        content: Buffer.from(JSON.stringify(apiResp), 'utf8').toString('base64')
      })
  });
  const res = await readFile(CFG, 'bookmarks.json', { token: TOKEN });
  assert.equal(res.unwrapped, false);
  assert.equal(JSON.parse(res.text).content, '');
});

test('没带 sha 时自动取 HEAD sha 重试一次（而不是冒泡成并发冲突）', async () => {
  let puts = 0;
  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({ sha: 'head-latest', size: 10, encoding: 'base64', content: Buffer.from('{}', 'utf8').toString('base64') }),
    'PUT /repos/me/bookmarks/contents/bookmarks.json': (init) => {
      puts++;
      const body = JSON.parse(init.body);
      if (!body.sha) return jsonRes({ message: 'Invalid request. "sha" wasn\'t supplied.' }, { status: 422 });
      return jsonRes({ content: { sha: 'newsha' }, commit: { sha: 'c1' } });
    }
  });
  const res = await writeFile(CFG, 'bookmarks.json', '{"a":1}', { token: TOKEN });
  assert.equal(puts, 2, '应写两次：第一次被 422 拒，第二次带上 HEAD sha');
  assert.equal(res.version, 'newsha');
});

test('sha 不匹配（409）不会被自动重试掩盖', async () => {
  let puts = 0;
  installFetch({
    'GET /repos/me/bookmarks/contents/bookmarks.json': () =>
      jsonRes({ sha: 'head-latest', size: 10, encoding: 'base64', content: Buffer.from('{}', 'utf8').toString('base64') }),
    'PUT /repos/me/bookmarks/contents/bookmarks.json': () => {
      puts++;
      return jsonRes({ message: 'bookmarks.json is at abc but expected def' }, { status: 409 });
    }
  });
  await assert.rejects(
    () => writeFile(CFG, 'bookmarks.json', '{"a":1}', { token: TOKEN, version: 'stale' }),
    (err) => err.code === 'CONFLICT'
  );
  assert.equal(puts, 1, '409 不该重试');
});

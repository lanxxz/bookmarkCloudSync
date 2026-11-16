import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 两台设备先后同步同一份云端文档。
 * 现场：Chrome 同步成功，紧接着 ego lite 同步报「云端已被其它设备更新（sha 不匹配）」。
 * 这里用可控的假 GitHub 复现这条链路，确保顺序同步不产生 409。
 */

const DOC_PATH = '/repos/me/bm/contents/bookmarks.json';
const CFG = { backend: 'github', githubOwner: 'me', githubRepo: 'bm', githubBranch: 'main', githubPath: 'bookmarks.json' };

let seq = 0;
function makeRepo() {
  const files = new Map();
  const commits = [];
  return {
    files,
    commits,
    fetch: async (url, init = {}) => {
      const method = init.method || 'GET';
      const u = String(url);
      const path = u.replace('https://api.github.com', '').split('?')[0];
      const res = (b, s = 200) => ({
        ok: s >= 200 && s < 300,
        status: s,
        headers: new Headers(),
        text: async () => (typeof b === 'string' ? b : JSON.stringify(b))
      });

      if (path === DOC_PATH && method === 'GET') {
        const cur = files.get('bookmarks.json');
        if (!cur) return res({ message: 'Not Found' }, 404);
        const accept = String((init.headers && init.headers.Accept) || '');
        if (accept.includes('raw')) return { ok: true, status: 200, headers: new Headers(), text: async () => cur.content };
        return res({ sha: cur.sha, size: cur.content.length, encoding: 'base64', content: Buffer.from(cur.content, 'utf8').toString('base64') });
      }
      if (path === DOC_PATH && method === 'PUT') {
        const body = JSON.parse(init.body);
        const cur = files.get('bookmarks.json');
        if (cur && body.sha !== cur.sha) {
          return res({ message: 'bookmarks.json does not match ' + cur.sha }, 409);
        }
        if (!cur && body.sha) return res({ message: "sha wasn't supplied" }, 422);
        const text = Buffer.from(body.content, 'base64').toString('utf8');
        const sha = 'sha' + ++seq;
        files.set('bookmarks.json', { content: text, sha });
        commits.unshift({ sha: 'c' + seq, commit: { message: body.message, author: { date: new Date().toISOString() } } });
        return res({ content: { sha }, commit: { sha: 'c' + seq } });
      }
      if (path.startsWith('/repos/me/bm/commits')) return res(commits.map((c) => c));
      if (path.startsWith('/repos/me/bm/contents/bcs-history')) return res([]);
      return res({ message: 'Not Found' }, 404);
    }
  };
}

function docOf(titles, rev = 1, writer = 'dev-a') {
  return JSON.stringify({
    schemaVersion: 2,
    revision: rev,
    writer,
    createdAt: 1,
    updatedAt: 2,
    nodes: titles.map((t, i) => ({
      id: 'n' + i, parentId: 'root', type: 'bookmark', title: t,
      url: 'https://e.com/' + i, index: i, deleted: false, deletedAt: 0, updatedAt: 2, deviceId: writer
    }))
  });
}

test('设备A写入后设备B紧接着写入：不应出现 sha 不匹配', async () => {
  const repo = makeRepo();
  globalThis.fetch = repo.fetch;
  const store = new Map();
  store.set('bcs_github_auth', { token: 't', login: 'me', owner: 'me', repo: 'bm' });
  globalThis.chrome = {
    storage: { local: { get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}), set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); }, remove: async (k) => store.delete(k) } },
    runtime: { lastError: null }
  };

  // A 设备写入
  const shaA = 'sha' + ++seq;
  repo.files.set('bookmarks.json', { content: docOf(['A 的书签'], 1, 'dev-a'), sha: shaA });

  const gh = await import('../src/lib/storage/github.js');
  const read1 = await gh.readDoc({ owner: 'me', repo: 'bm', branch: 'main', path: 'bookmarks.json' }, { token: 't' });
  assert.equal(read1.exists, true);
  assert.equal(read1.version, shaA, '读到的应是当前 HEAD 的 blob sha');

  // B 设备读同一个 HEAD 后写入
  const w = await gh.writeDoc(
    { owner: 'me', repo: 'bm', branch: 'main', path: 'bookmarks.json' },
    docOf(['A 的书签', 'B 的书签'], 2, 'dev-b'),
    { token: 't', version: read1.version, message: 'B sync' }
  );
  assert.ok(w.version, '写入应成功并返回新 sha');
  assert.notEqual(w.version, shaA);
});

test('回溯历史恢复后写入：乐观锁必须用当前 HEAD 的 sha，而不是历史 commit 的 blob sha', async () => {
  // 这是上一版引入的回归：用历史 blob sha 写当前文件 → 必然 409
  const shell = JSON.stringify({ name: 'bookmarks.json', path: 'bookmarks.json', sha: 'headsha', size: 9, url: 'u', html_url: 'h', git_url: 'g', download_url: 'd', type: 'file', content: '', encoding: 'none' });

  const repo = {
    files: new Map([['bookmarks.json', { content: shell, sha: 'headsha' }]]),
    oldBlob: { sha: 'oldblob', content: docOf(['历史里的书签'], 1, 'dev-a') },
    fetch: null
  };
  repo.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = String(url);
    const path = u.replace('https://api.github.com', '').split('?')[0];
    const res = (b, s = 200) => ({ ok: s >= 200 && s < 300, status: s, headers: new Headers(), text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) });

    if (path === DOC_PATH && method === 'GET') {
      const m = /[?&]ref=([^&]+)/.exec(u);
      const ref = m ? decodeURIComponent(m[1]) : 'main';
      const accept = String((init.headers && init.headers.Accept) || '');
      if (ref !== 'main') {
        if (ref === 'cold') {
          if (accept.includes('raw')) return { ok: true, status: 200, headers: new Headers(), text: async () => repo.oldBlob.content };
          return res({ sha: 'oldblob', size: repo.oldBlob.content.length, encoding: 'base64', content: Buffer.from(repo.oldBlob.content, 'utf8').toString('base64') });
        }
        return res({ message: 'Not Found' }, 404);
      }
      const cur = repo.files.get('bookmarks.json');
      if (accept.includes('raw')) return { ok: true, status: 200, headers: new Headers(), text: async () => cur.content };
      return res({ sha: cur.sha, size: cur.content.length, encoding: 'base64', content: Buffer.from(cur.content, 'utf8').toString('base64') });
    }
    if (path === DOC_PATH && method === 'PUT') {
      const body = JSON.parse(init.body);
      const cur = repo.files.get('bookmarks.json');
      if (body.sha !== cur.sha) return res({ message: 'bookmarks.json does not match ' + cur.sha }, 409);
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      repo.files.set('bookmarks.json', { content: text, sha: 'newhead' });
      return res({ content: { sha: 'newhead' }, commit: { sha: 'cnew' } });
    }
    if (path.startsWith('/repos/me/bm/commits')) {
      return res([{ sha: 'cold', commit: { message: 'sync r1', author: { date: '2026-01-01T00:00:00Z' } } }]);
    }
    if (path.startsWith('/repos/me/bm/contents/bcs-history')) return res([]);
    return res({ message: 'Not Found' }, 404);
  };

  globalThis.fetch = repo.fetch;
  const store2 = new Map();
  store2.set('bcs_github_auth', { token: 't', login: 'me', owner: 'me', repo: 'bm' });
  globalThis.chrome = {
    storage: { local: { get: async (k) => (store2.has(k) ? { [k]: store2.get(k) } : {}), set: async (o) => { for (const [k, v] of Object.entries(o)) store2.set(k, v); }, remove: async (k) => store2.delete(k) } },
    runtime: { lastError: null }
  };

  const { readRemote } = await import('../src/lib/sync.js');
  const r = await readRemote({ token: 't', settings: CFG });
  assert.ok(r.recoveredFrom, '应标记回溯');
  assert.equal(r.etag, 'headsha', '乐观锁必须是当前 HEAD 的 sha，不是历史 blob sha');

  // 用这个 etag 写入应当成功
  const gh = await import('../src/lib/storage/github.js');
  const w = await gh.writeDoc({ owner: 'me', repo: 'bm', branch: 'main', path: 'bookmarks.json' }, docOf(['x'], 3, 'dev-a'), { token: 't', version: r.etag, message: 'after recovery' });
  assert.equal(w.version, 'newhead');
});

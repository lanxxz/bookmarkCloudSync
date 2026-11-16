import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 云端当前版本被写成"GitHub API 响应空壳"，但 git 历史里有完好版本。
 * 期望：同步自动回溯历史并继续，而不是抛 invalid-doc 卡死。
 */

const CFG = { owner: 'me', repo: 'bm', branch: 'main', path: 'bookmarks.json' };
const TOKEN = 't';

const GOOD = JSON.stringify({
  schemaVersion: 2,
  revision: 5,
  writer: 'dev-a',
  createdAt: 1,
  updatedAt: 2,
  nodes: [
    { id: 'b1', parentId: 'root', type: 'bookmark', title: '历史版本里的书签', url: 'https://ok.com/', index: 0, deleted: false, deletedAt: 0, updatedAt: 2, deviceId: 'dev-a' }
  ]
});

// 当前 HEAD：一个 content 为空的 API 响应对象
const SHELL = JSON.stringify({
  name: 'bookmarks.json',
  path: 'bookmarks.json',
  sha: 'head123',
  size: 2_000_000,
  url: 'https://api.github.com/x',
  html_url: 'https://github.com/x',
  git_url: 'https://api.github.com/y',
  download_url: 'https://raw/x',
  type: 'file',
  content: '',
  encoding: 'none'
});

function install({ headIsShell = true, commits = ['c3', 'c2', 'c1'], goodText = GOOD } = {}) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = String(url);
    seen.push(method + ' ' + u.replace('https://api.github.com', ''));
    if (process.env.BCS_DEBUG_FETCH) console.log('FETCH', method, u);
    const path = u.replace('https://api.github.com', '').split('?')[0];

    if (process.env.BCS_DEBUG_FETCH) console.log('ROUTE path=', JSON.stringify(path), 'method=', method, 'accept=', String((init.headers&&init.headers.Accept)||''), 'match=', path === '/repos/me/bm/contents/bookmarks.json');
    const respond = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    });

    // 文档读取（可带 ref=<commit>）
    if (path === '/repos/me/bm/contents/bookmarks.json' && method === 'GET') {
      /* content 为空的文件会走 Accept: raw 分支，此时应直接返回原始文本 */
      const accept = String((init.headers && init.headers.Accept) || '');
      /* ref 可能是分支名（main）或 commit sha。分支名 = 当前版本，不是历史版本。 */
      const mRef = /[?&]ref=([^&]+)/.exec(u);
      const refRaw = mRef ? decodeURIComponent(mRef[1]) : '';
      const isBranch = !refRaw || refRaw === 'main';
      if (accept.includes('raw')) {
        if (refRaw === 'c2') return { ok: true, status: 200, headers: new Headers(), text: async () => goodText };
        if (refRaw === 'c3') return { ok: true, status: 200, headers: new Headers(), text: async () => '{"broken"' };
        if (!isBranch) return respond({ message: 'Not Found' }, 404);
        return { ok: true, status: 200, headers: new Headers(), text: async () => (headIsShell ? SHELL : GOOD) };
      }
      const ref = isBranch ? null : refRaw;
      if (ref) {
        // 历史 commit：只有 c2 有好内容（模拟部分 commit 也坏了）
        if (ref === 'c2') return respond({ sha: 'blob-c2', size: GOOD.length, encoding: 'base64', content: Buffer.from(goodText, 'utf8').toString('base64') });
        if (ref === 'c3') return respond({ sha: 'blob-c3', size: 10, encoding: 'base64', content: Buffer.from('{"broken"', 'utf8').toString('base64') });
        return respond({ message: 'Not Found' }, 404);
      }
      const _payload = { sha: 'head123', size: 2_000_000, encoding: 'base64', content: Buffer.from(headIsShell ? SHELL : GOOD, 'utf8').toString('base64') };
      if (process.env.BCS_DEBUG_FETCH) console.log('PAYLOAD ok keys=', Object.keys(_payload).join(','));
      return respond(_payload);
    }

    // commit 列表（路径带 query，需要 startsWith 匹配）
    if (path.startsWith('/repos/me/bm/commits')) {
      return respond(commits.map((s, i) => ({ sha: s, commit: { message: 'sync r' + (9 - i), author: { date: '2026-01-0' + (i + 1) + 'T00:00:00Z' } } })));
    }
    return respond({ message: 'Not Found' }, 404);
  };
  return seen;
}

/* ---- 用一个最小可用的 setting/backend 环境驱动 readRemote ---- */

async function withEnv(fn) {
  const store = new Map();
  /* resolveToken 会从 chrome.storage.local 读取 GitHub 凭证 */
  store.set('bcs_github_auth', { token: TOKEN, login: 'me', owner: 'me', repo: 'bm' });
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
        remove: async (k) => store.delete(k)
      }
    },
    runtime: { lastError: null }
  };
  return fn(store);
}

const { readRemote } = await import('../src/lib/sync.js');
if (process.env.BCS_DEBUG_FETCH) {
  const ghDbg = await import('../src/lib/storage/github.js');
  globalThis.__dbgReadDoc = async (cfg, opts) => {
    const out = await ghDbg.readDoc(cfg, opts);
    console.log('READDOC', JSON.stringify({ exists: out.exists, size: out.size, len: (out.text||'').length, head: (out.text||'').slice(0,40) }));
    return out;
  };
}

test('云端当前版本是空壳时，自动回溯到历史 commit 并返回可用文档', async () => {
  await withEnv(async () => {
    install({ headIsShell: true });
    const r = await readRemote({
      token: TOKEN,
      settings: { backend: 'github', githubOwner: 'me', githubRepo: 'bm', githubBranch: 'main', githubPath: 'bookmarks.json' }
    });

    assert.equal(r.exists, true);
    assert.ok(r.recoveredFrom, '应标记为已从历史恢复');
    assert.equal(r.recoveredFrom.sha, 'c2', '应跳过内容也坏掉的 c3');
    /* 乐观锁必须用【当前 HEAD】的 sha（head123），不是历史版本的 blob sha。
     * 用历史 blob sha 写当前文件，GitHub 会一直回 409 does not match。 */
    assert.equal(r.etag, 'head123', '乐观锁必须是当前 HEAD 的 sha');
    assert.equal(r.recoveredFrom.overwritesHead, 'head123');
    const titles = [...r.doc.nodes.values()].map((n) => n.title);
    assert.deepEqual(titles, ['历史版本里的书签']);
  });
});

test('云端当前版本正常时不会去翻历史', async () => {
  await withEnv(async () => {
    const seen = install({ headIsShell: false });
    const r = await readRemote({
      token: TOKEN,
      settings: { backend: 'github', githubOwner: 'me', githubRepo: 'bm', githubBranch: 'main', githubPath: 'bookmarks.json' }
    });
    assert.equal(r.recoveredFrom || null, null);
    assert.equal(r.etag, 'head123');
    assert.equal(seen.some((s) => s.includes('/commits')), false, '不该产生额外请求');
  });
});


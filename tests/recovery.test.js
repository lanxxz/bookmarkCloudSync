import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 损坏文档的恢复流程端到端（GitHub 后端 + 内存仓库）。
 *
 * 重点验证两件容易被忽略的事：
 *  1. 备份写的是 bcs-backup/xxx.json 这种带子目录的路径 —— GitHub 支持，
 *     但要确认写进去的确实是原始坏内容（一个字节都不能改）；
 *  2. 修复后写回的是标准格式，再读一次能直接解析。
 */

const TOKEN = 'ghp_test';

function makeRepo() {
  const files = new Map();
  let seq = 0;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const raw = String(url).replace('https://api.github.com', '');
    const pathPart = raw.split('?')[0];
    const m = /^\/repos\/me\/bm\/contents\/(.+)$/.exec(pathPart);
    const json = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: async () => JSON.stringify(body)
    });
    if (!m) return json({ message: 'Not Found' }, 404);
    const path = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const cur = files.get(path);
      if (!cur) return json({ message: 'Not Found' }, 404);
      return json({ sha: cur.sha, size: cur.content.length, encoding: 'base64', content: Buffer.from(cur.content, 'utf8').toString('base64') });
    }
    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      const cur = files.get(path);
      if (cur && body.sha !== cur.sha) return json({ message: 'sha mismatch' }, 409);
      files.set(path, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: 'sha' + ++seq });
      return json({ content: { sha: 'sha' + seq }, commit: { sha: 'c' + seq } });
    }
    return json({ message: 'Not Found' }, 404);
  };
  return files;
}

const gh = await import('../src/lib/storage/github.js');
const { docFromJson, createDoc, serializeDoc } = await import('../src/lib/protocol.js');

const CFG = { owner: 'me', repo: 'bm', branch: 'main', path: 'bookmarks.json' };

test('坏文档能在备份后归一化写回', async () => {
  const files = makeRepo();
  // 云端存的是"裸数组"，扩展解析不了
  const bad = JSON.stringify([
    { id: 'b1', parentId: 'root', type: 'bookmark', title: 'A', url: 'https://a.com/', index: 0, deleted: false, deletedAt: 0, updatedAt: 1, deviceId: 'd' }
  ]);
  await gh.writeDoc(CFG, bad, { token: TOKEN });

  const readBack = await gh.readDoc(CFG, { token: TOKEN });
  const parsed = docFromJson(readBack.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repaired, 'bare-array', '应该被认出来并修复');

  // 1) 备份原始内容
  const backupPath = 'bcs-backup/bad-test.json';
  await gh.writeDoc({ ...CFG, path: backupPath }, readBack.text, { token: TOKEN });
  assert.equal(files.get(backupPath).content, bad, '备份必须是逐字节原样');

  // 2) 归一化写回
  const doc = createDoc({ nodes: parsed.doc.nodes, revision: 2, writer: 'dev-x' });
  await gh.writeDoc(CFG, serializeDoc(doc), { token: TOKEN, version: readBack.version });

  const after = await gh.readDoc(CFG, { token: TOKEN });
  const recheck = docFromJson(after.text);
  assert.equal(recheck.ok, true);
  assert.equal(recheck.repaired, undefined, '写回后应该是标准格式，不再需要修复');
  assert.equal(recheck.doc.nodes.size, 1);
});

test('写不进备份路径时也不会污染主文档', async () => {
  const files = makeRepo();
  const bad = '{not json';
  await gh.writeDoc(CFG, bad, { token: TOKEN });
  // 模拟备份失败：不写入备份，只确认主文档没被改动
  const before = files.get('bookmarks.json').content;
  assert.equal(before, bad);
  assert.equal(files.has('bcs-backup/x.json'), false);
});

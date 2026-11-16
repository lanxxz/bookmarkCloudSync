/**
 * GitHub 私有仓库作为云端存储。
 *
 * 为什么这条路对 Chrome + ego(lite) 特别合适：
 *  1. 不需要 Google Cloud Console、不需要 OAuth 同意屏幕，只要一个 fine-grained PAT；
 *  2. 完全不依赖 chrome.identity —— ego(lite) 缺这个 API 也能用；
 *  3. 每次同步就是一次 git commit，版本历史天然免费，误删可以 checkout 回来；
 *  4. Private 仓库只有你自己可见。
 *
 * 并发控制：Contents API 的 sha 等价于 ETag。写文档时带上 sha，
 * 若云端在此期间被别人改过，GitHub 返回 409 / 422，我们抛 CONFLICT 让上层重读重合并。
 *
 * 大文件：Contents API 对 >1MB 的文件不返回内联 base64（encoding = 'none'），
 * 此时改用 Accept: application/vnd.github.raw 拉原始字节。
 */
import { StorageError, toBase64Utf8, fromBase64Utf8, sanitizePath, retrying } from './base.js';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_HISTORY_DIR = 'bcs-history';
const API_VERSION = '2022-11-28';
const MAX_INLINE_BYTES = 1_000_000;
const HARD_LIMIT_BYTES = 90 * 1024 * 1024;

/* ---------------- 凭证 ---------------- */

const AUTH_KEY = 'bcs_github_auth';

export async function readGithubAuth() {
  const res = await chrome.storage.local.get(AUTH_KEY);
  return res[AUTH_KEY] || null;
}

export async function writeGithubAuth(value) {
  if (value) await chrome.storage.local.set({ [AUTH_KEY]: value });
  else await chrome.storage.local.remove(AUTH_KEY);
  return value;
}

export async function getGithubToken() {
  const auth = await readGithubAuth();
  return auth && auth.token ? auth.token : '';
}

export async function requireGithubToken() {
  const token = await getGithubToken();
  if (token) return token;
  throw new StorageError('未配置 GitHub Token，请在设置里填写 fine-grained PAT', { code: 'AUTH_REQUIRED' });
}

/* ---------------- HTTP ---------------- */

function headers(token, extra = {}) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    ...extra
  };
}

function mapError(res, text, what) {
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  const message = (json && json.message) || text.slice(0, 300) || 'HTTP ' + res.status;

  if (res.status === 401) {
    return new StorageError('GitHub Token 无效或已过期：' + message, { status: 401, code: 'TOKEN_INVALID' });
  }
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      return new StorageError('GitHub API 限流（每小时 5000 次），大约 ' + Math.max(1, Math.round((reset - Date.now()) / 60000)) + ' 分钟后恢复', {
        status: 403,
        code: 'RATE_LIMITED',
        retryable: true,
        detail: { reset }
      });
    }
    return new StorageError('没有权限：' + message + '（检查 PAT 是否包含该仓库的 Contents 读写权限）', { status: 403, code: 'FORBIDDEN' });
  }
  if (res.status === 404) {
    return new StorageError('仓库或路径不存在：' + message, { status: 404, code: 'NOT_FOUND' });
  }
  if (res.status === 409 || res.status === 422) {
    /* 只有明确的 sha 不匹配才是并发冲突。
     * "sha wasn't supplied" / "Invalid request... sha" 是调用方没带 sha，属于代码错误，
     * 误判成 CONFLICT 会让上层反复重读重试，永远修不好。 */
    const shaMissing = /sha\b.*(supplied|required|missing)|(supplied|required|missing).*\bsha\b/i.test(message);
    if (shaMissing) {
      return new StorageError(what + ' 失败：写入时没有提供 sha（更新已存在文件必须带上 blob sha）：' + message, {
        status: res.status,
        code: 'SHA_MISSING'
      });
    }
    const shaMismatch = /sha.*(does not match|mismatch|is at|but expected)/i.test(message);
    if (res.status === 409 || shaMismatch) {
      return new StorageError('云端已被其它设备更新（sha 不匹配）', { status: res.status, code: 'CONFLICT' });
    }
    return new StorageError(what + ' 失败：' + message, { status: res.status, code: 'UNPROCESSABLE' });
  }
  return new StorageError(what + ' 失败 HTTP ' + res.status + '：' + message, {
    status: res.status,
    code: 'HTTP_' + res.status,
    retryable: res.status === 429 || res.status >= 500
  });
}

/* ---------------- 基础调用 ---------------- */

async function ghFetch(path, { token, method = 'GET', body, accept, raw = false } = {}) {
  const auth = token || (await requireGithubToken());
  const res = await fetch(GITHUB_API + path, {
    method,
    headers: headers(auth, {
      ...(accept ? { Accept: accept } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json; charset=UTF-8' } : {})
    }),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw mapError(res, text, method + ' ' + path.split('?')[0]);
  if (raw) return { text, res };
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function repoPath(cfg, sub = '') {
  const owner = encodeURIComponent(cfg.owner);
  const repo = encodeURIComponent(cfg.repo);
  const base = '/repos/' + owner + '/' + repo;
  return sub ? base + sub : base;
}

function fileApiPath(cfg, path) {
  const clean = sanitizePath(path, 'bookmarks.json');
  return repoPath(cfg, '/contents/' + clean.split('/').map(encodeURIComponent).join('/'));
}

/* ---------------- 配置 ---------------- */

export function cfgFromSettings(settings) {
  const owner = String(settings.githubOwner || '').trim();
  const repo = String(settings.githubRepo || '').trim();
  if (!owner || !repo) {
    throw new StorageError('请先在设置里填写 GitHub 仓库（owner/repo）', { code: 'NOT_CONFIGURED' });
  }
  return {
    owner,
    repo,
    branch: String(settings.githubBranch || 'main').trim() || 'main',
    path: sanitizePath(settings.githubPath, 'bookmarks.json')
  };
}

/* ---------------- 读 ---------------- */

/**
 * 读取文件内容。
 * @returns {Promise<{exists:false}|{exists:true,text:string,version:string,size:number}>}
 */
export async function readFile(cfg, path, { token, ref } = {}) {
  const api = fileApiPath(cfg, path);
  const query = '?ref=' + encodeURIComponent(ref || cfg.branch);
  let meta;
  try {
    meta = await ghFetch(api + query, { token });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return { exists: false };
    throw err;
  }
  if (Array.isArray(meta)) {
    throw new StorageError('路径指向的是目录而不是文件：' + path, { code: 'IS_DIRECTORY' });
  }
  const size = Number(meta.size) || 0;
  if (size > HARD_LIMIT_BYTES) {
    throw new StorageError('文件过大（' + Math.round(size / 1024 / 1024) + 'MB），超出 Contents API 处理范围', { code: 'TOO_LARGE' });
  }

  // ≤1MB 走内联 base64；更大的文件 GitHub 会返回 encoding: 'none'
  if (meta.encoding !== 'none' && meta.content) {
    const text = fromBase64Utf8(meta.content);
    /* 自愈：文件里躺着的是一份 Contents API 响应对象时，真数据在它自己的
     * content 字段里。这种情况通常是外部工具误写。能解出来就用解出来的。 */
    const unwrapped = unwrapNestedApiResponse(text);
    return { exists: true, text: unwrapped || text, version: meta.sha, size, unwrapped: !!unwrapped };
  }

  const { text } = await ghFetch(api + query, {
    token,
    accept: 'application/vnd.github.raw',
    raw: true
  });
  const unwrappedRaw = unwrapNestedApiResponse(text);
  return { exists: true, text: unwrappedRaw || text, version: meta.sha, size, unwrapped: !!unwrappedRaw };
}

/** 只取元数据（sha / size），不下载正文 —— 给远端轮询用 */
export async function headFile(cfg, path, { token } = {}) {
  const api = fileApiPath(cfg, path);
  try {
    const meta = await ghFetch(api + '?ref=' + encodeURIComponent(cfg.branch), { token });
    if (Array.isArray(meta)) return null;
    return { sha: meta.sha, size: Number(meta.size) || 0, path: meta.path };
  } catch (err) {
    if (err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

/* ---------------- 写 ---------------- */

export async function writeFile(cfg, path, text, { token, version, message } = {}) {
  const api = fileApiPath(cfg, path);
  const makeBody = (sha) => {
    const body = {
      message: message || 'chore(bcs): sync bookmarks ' + new Date().toISOString(),
      content: toBase64Utf8(text),
      branch: cfg.branch
    };
    if (sha) body.sha = sha;
    return body;
  };

  /*
   * 兜底通道：调用方没给 sha（或给的已被云端刷新）时，GitHub 对已存在的文件
   * 会返回 422 "sha wasn't supplied"。这类错误不该冒泡成"并发冲突"，
   * 而是说明我们手上的版本号过期了 —— 现取一次 HEAD sha 再写一遍。
   *
   * 这不是静默覆盖：拿到的最新 sha 就是乐观锁，期间若又被改动，
   * 这一次仍会失败并如实抛出，由上层决定重读重合并。
   */
  const attemptWith = (sha) =>
    retrying(
      async () => {
        const res = await ghFetch(api, { token, method: 'PUT', body: makeBody(sha) });
        const contentSha = (res.content && res.content.sha) || '';
        return {
          version: contentSha,
          commit: (res.commit && res.commit.sha) || '',
          changed: true
        };
      },
      { retries: 2 }
    );

  try {
    return await attemptWith(version);
  } catch (err) {
    if (err && err.code === 'SHA_MISSING') {
      const head = await headFile(cfg, path, { token }).catch(() => null);
      if (head && head.sha) {
        return attemptWith(head.sha);
      }
    }
    throw err;
  }
}

export async function deleteFile(cfg, path, { token } = {}) {
  const api = fileApiPath(cfg, path);
  const current = await ghFetch(api + '?ref=' + encodeURIComponent(cfg.branch), { token }).catch(() => null);
  if (!current || Array.isArray(current)) return { deleted: false };
  await retrying(
    async () => {
      await ghFetch(api, {
        token,
        method: 'DELETE',
        body: { message: 'chore(bcs): prune snapshot ' + path, sha: current.sha, branch: cfg.branch }
      });
      return true;
    },
    { retries: 1 }
  );
  return { deleted: true };
}

/* ---------------- 目录 / 提交 ---------------- */

export async function listDir(cfg, dir, { token } = {}) {
  const base = repoPath(cfg, '/contents/' + dir.split('/').map(encodeURIComponent).join('/'));
  try {
    const res = await ghFetch(base + '?ref=' + encodeURIComponent(cfg.branch), { token });
    return Array.isArray(res) ? res : [];
  } catch (err) {
    if (err.code === 'NOT_FOUND') return [];
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 统一存储接口
 *
 * 上层（sync / history / alarms / selftest）只认这一套名字。
 * Drive 那边是原生实现，GitHub 这边是薄适配：把路径参数补上、
 * 把返回字段对齐，避免上层再按后端分支。
 *
 * 接口清单见 storage/index.js 的 BACKEND_INTERFACE，
 * 有契约测试保证两个后端都完整实现，漏一个就红。
 * ------------------------------------------------------------------ */

/** 读同步文档 */
export async function readDoc(cfg, { token } = {}) {
  const res = await readFile(cfg, cfg.path, { token });
  if (!res.exists) return { exists: false };
  return { exists: true, text: res.text, version: res.version, size: res.size };
}

/** 只取文档版本（sha），用于远端轮询 */
export async function headDoc(cfg, { token } = {}) {
  const head = await headFile(cfg, cfg.path, { token });
  if (!head) return null;
  return { sha: head.sha, size: head.size };
}

/**
 * 写同步文档。
 * version 是上次读到的 blob sha，带上去做乐观锁；
 * 云端被别人改过时 GitHub 返回 409/422，这里透传 CONFLICT。
 */
export async function writeDoc(cfg, text, { token, version, message } = {}) {
  const res = await writeFile(cfg, cfg.path, text, { token, version, message });
  return { version: res.version, commit: res.commit, changed: true, message };
}

/* ---------------- 快照 ---------------- */

/** 写一份快照到 bcs-history/ */
export async function saveSnapshot(cfg, { name, text, token, message } = {}) {
  const rel = GITHUB_HISTORY_DIR + '/' + name;
  const res = await writeFile(cfg, rel, text, {
    token,
    message: message || 'chore(bcs): snapshot ' + name
  });
  return { id: rel, name, version: res.version };
}

/** 列出 bcs-history/ 下的快照，按文件名（含 ISO 时间）倒序 */
export async function listSnapshots(cfg, { token, limit = 30 } = {}) {
  const files = await listDir(cfg, GITHUB_HISTORY_DIR, { token });
  const snaps = files
    .filter((f) => f.type === 'file' && /^snap-.*\.json$/.test(f.name))
    .map((f) => ({
      id: GITHUB_HISTORY_DIR + '/' + f.name,
      name: f.name,
      size: Number(f.size || 0),
      version: f.sha || '',
      ts: parseSnapshotTs(f.name)
    }));
  snaps.sort((a, b) => b.ts - a.ts);
  return snaps.slice(0, Math.max(1, limit));
}

/** 读一份快照的正文 */
export async function readSnapshot(cfg, id, { token } = {}) {
  const rel = String(id || '').replace(/^\/+/, '');
  if (!/^[^/]+\/.+\.json$/.test(rel)) {
    throw new StorageError('快照路径不合法：' + rel, { code: 'BAD_SNAPSHOT_PATH' });
  }
  const file = await readFile(cfg, rel, { token });
  if (!file.exists) throw new StorageError('快照不存在：' + rel, { code: 'NOT_FOUND' });
  return { text: file.text, version: file.version };
}

/** 环形裁剪：只保留最新的 keep 份 */
export async function pruneSnapshots(cfg, { token, keep = 10 } = {}) {
  const snaps = await listSnapshots(cfg, { token, limit: 10000 });
  const extra = snaps.slice(Math.max(1, keep));
  let removed = 0;
  for (const snap of extra) {
    try {
      await deleteFile(cfg, snap.id, { token });
      removed++;
    } catch {
      /* 单个失败不影响其它 */
    }
  }
  return { total: snaps.length, removed, kept: Math.min(snaps.length, keep) };
}

/**
 * 按版本读回内容。
 *  - 传 id（快照路径）-> 读该快照文件
 *  - 传 commit（sha）-> 读该 commit 下的同步文档
 */
export async function readAtVersion(cfg, { id, commit, token } = {}) {
  if (commit) {
    const file = await readFile(cfg, cfg.path, { token, ref: commit });
    if (!file.exists) throw new StorageError('该 commit 里没有同步文档', { code: 'NOT_FOUND' });
    return { text: file.text, version: file.version };
  }
  if (!id) throw new StorageError('缺少快照 id 或 commit', { code: 'NO_VERSION' });
  return readSnapshot(cfg, id, { token });
}

/** 从 snap-2026-11-16T08-30-00-000Z_... 里解析出时间戳 */
function parseSnapshotTs(name) {
  const m = /^snap-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return 0;
  return Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + 'Z') || 0;
}

/** 指定路径的提交历史 —— GitHub 模式下它就是"快照列表" */
export async function listCommits(cfg, path, { token, limit = 30 } = {}) {
  const base = repoPath(cfg, '/commits');
  const clean = sanitizePath(path, 'bookmarks.json');
  const params = new URLSearchParams({ path: clean, per_page: String(Math.min(100, Math.max(1, limit))) });
  try {
    const res = await ghFetch(base + '?' + params.toString() + '&sha=' + encodeURIComponent(cfg.branch), { token });
    return Array.isArray(res) ? res : [];
  } catch (err) {
    if (err.code === 'NOT_FOUND') return [];
    throw err;
  }
}

/* ---------------- 探测 ---------------- */

export async function probeRepo(cfg, { token } = {}) {
  const info = await ghFetch(repoPath(cfg), { token });
  const rate = await ghFetch('/rate_limit', { token }).catch(() => null);
  return {
    private: !!info.private,
    fullName: info.full_name,
    defaultBranch: info.default_branch,
    permissions: info.permissions || {},
    pushedAt: info.pushed_at,
    rateRemaining: rate && rate.rate ? rate.rate.remaining : null,
    rateLimit: rate && rate.rate ? rate.rate.limit : null
  };
}

/** 列出当前 Token 可见的仓库，用于设置页的下拉选择 */
export async function listRepos({ token, limit = 50 } = {}) {
  const params = new URLSearchParams({
    per_page: String(Math.min(100, Math.max(1, limit))),
    sort: 'updated',
    affiliation: 'owner,collaborator,organization_member'
  });
  const res = await ghFetch('/user/repos?' + params.toString(), { token });
  return (Array.isArray(res) ? res : []).map((r) => ({
    fullName: r.full_name,
    owner: r.owner ? r.owner.login : '',
    name: r.name,
    private: !!r.private,
    defaultBranch: r.default_branch,
    canPush: !!(r.permissions && r.permissions.push),
    pushedAt: r.pushed_at
  }));
}

export async function probeAccount({ token } = {}) {
  const user = await ghFetch('/user', { token });
  return { login: user.login, name: user.name || '', avatar: user.avatar_url || '' };
}

/**
 * 校验并保存 PAT。
 * 尽量早失败：先验 token 本身，再验仓库可见性与写权限。
 */
export async function connectGithub({ token, owner, repo } = {}) {
  const clean = String(token || '').trim();
  if (!clean) throw new StorageError('Token 为空', { code: 'EMPTY_TOKEN' });
  const account = await probeAccount({ token: clean });
  const info = await probeRepo({ owner, repo }, { token: clean });
  if (!info.permissions || !(info.permissions.push || info.permissions.admin || info.permissions.maintain)) {
    throw new StorageError('该 Token 没有仓库写权限（需要 Contents: Read and write）', { code: 'NO_WRITE' });
  }
  const record = { token: clean, login: account.login, owner, repo, addedAt: Date.now() };
  await writeGithubAuth(record);
  return { ...record, repoInfo: info };
}

/**
 * 文件内容本身是一份 Contents API 响应对象时，把里面真正的正文取出来。
 *
 * 现场：bookmarks.json 里躺着 { name, path, sha, ..., content, encoding }，
 * 真数据在 content（base64）里。外部工具误写过一次就会永久卡住同步，
 * 这里做一次透明解包，让读取路径自己恢复。
 *
 * 解不出来就返回 null，调用方按原样处理（后续 docFromJson 会给出可读诊断）。
 */
export function unwrapNestedApiResponse(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw || raw[0] !== '{') return null;
  let outer;
  try {
    outer = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return null;
  if (Array.isArray(outer.nodes)) return null; // 本来就是文档
  const looksApi = typeof outer.sha === 'string' && typeof outer.path === 'string';
  if (!looksApi) return null;
  if (typeof outer.content !== 'string' || !outer.content) return null;

  let inner;
  try {
    inner = fromBase64Utf8(outer.content);
  } catch {
    return null;
  }
  if (!inner) return null;
  const trimmed = inner.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

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
    if (/sha/i.test(message) || res.status === 409) {
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
    return { exists: true, text: fromBase64Utf8(meta.content), version: meta.sha, size };
  }

  const { text } = await ghFetch(api + query, {
    token,
    accept: 'application/vnd.github.raw',
    raw: true
  });
  return { exists: true, text, version: meta.sha, size };
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
  const body = {
    message: message || 'chore(bcs): sync bookmarks ' + new Date().toISOString(),
    content: toBase64Utf8(text),
    branch: cfg.branch
  };
  if (version) body.sha = version;

  return retrying(
    async () => {
      const res = await ghFetch(api, { token, method: 'PUT', body });
      const contentSha = (res.content && res.content.sha) || '';
      return {
        version: contentSha,
        commit: (res.commit && res.commit.sha) || '',
        changed: true
      };
    },
    { retries: 2 }
  );
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

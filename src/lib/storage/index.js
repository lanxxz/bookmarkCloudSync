/**
 * 存储后端路由。
 *
 * 目前支持两种：
 *  - drive  ：Google Drive appDataFolder（默认，需要 Google OAuth）
 *  - github ：GitHub 私有仓库（只需要 PAT，不依赖 chrome.identity）
 *
 * 两者对外接口完全一致：
 *   readDoc / headDoc / writeDoc / saveSnapshot / listSnapshots / readSnapshot /
 *   pruneSnapshots / readAtVersion
 */
import * as driveBackend from './drive.js';
import * as githubBackend from './github.js';
import { StorageError } from './base.js';
import { requireToken, peekToken } from '../auth.js';

export { StorageError, isConflict, isAuthError } from './base.js';
export const BACKENDS = Object.freeze({ DRIVE: 'drive', GITHUB: 'github' });

/**
 * 后端必须实现的全部方法。
 *
 * 这份清单不是文档，而是被 tests/storage-contract.test.js 实际使用的断言源：
 * 任何一个后端漏实现一个方法，测试立刻红。
 *
 * 起因：GitHub 后端最早只有 readFile/writeFile 这套底层名字，
 * 而 sync.js 调的是统一接口 readDoc —— 于是运行时报
 * "backend.readDoc is not a function"，静态检查完全看不出来。
 */
export const BACKEND_INTERFACE = Object.freeze([
  'cfgFromSettings',
  'readDoc',
  'headDoc',
  'writeDoc',
  'saveSnapshot',
  'listSnapshots',
  'readSnapshot',
  'pruneSnapshots',
  'readAtVersion'
]);

/** 校验某个后端是否满足接口约定，返回缺失的方法名 */
export function missingBackendMethods(backend) {
  return BACKEND_INTERFACE.filter((name) => typeof backend[name] !== 'function');
}

/** GitHub 是后加的，所以老用户的 storage 里没有 backend 字段，默认走 drive 保持行为不变 */
export function resolveBackend(settings) {
  const name = settings && settings.backend === BACKENDS.GITHUB ? BACKENDS.GITHUB : BACKENDS.DRIVE;
  return name;
}

export function getBackend(name) {
  if (name === BACKENDS.GITHUB) return githubBackend;
  return driveBackend;
}

export function backendFor(settings) {
  const name = resolveBackend(settings);
  const backend = getBackend(name);
  /*
   * 运行时兜底：契约测试是在 CI 里跑的，但用户装的是打包产物。
   * 万一某个后端漏了方法，这里给出"缺哪个"的明确错误，
   * 而不是让人对着 "xxx is not a function" 猜。
   */
  const missing = missingBackendMethods(backend);
  if (missing.length) {
    throw new StorageError(
      '存储后端 ' + name + ' 缺少方法：' + missing.join(', ') + '（扩展包可能不完整，请重新安装）',
      { code: 'BACKEND_INCOMPLETE', detail: { backend: name, missing } }
    );
  }
  return { name, backend };
}

/** 后端展示名 */
export function backendLabel(name) {
  return name === BACKENDS.GITHUB ? 'GitHub 私有仓库' : 'Google Drive';
}

/**
 * 每种后端的连接状态：是否配置完成、是否已授权、当前账号/仓库。
 * UI 和工作进程共用这一个入口，避免两处判断不一致。
 */
export async function backendStatus(settings) {
  const name = resolveBackend(settings);
  if (name === BACKENDS.GITHUB) {
    const auth = await githubBackend.readGithubAuth();
    const owner = String(settings.githubOwner || '').trim();
    const repo = String(settings.githubRepo || '').trim();
    return {
      backend: name,
      label: backendLabel(name),
      configured: !!(owner && repo),
      authorized: !!(auth && auth.token),
      account: auth && auth.login ? auth.login : '',
      target: owner && repo ? owner + '/' + repo : '',
      branch: settings.githubBranch || 'main'
    };
  }
  return {
    backend: name,
    label: backendLabel(name),
    configured: !!settings.clientId || settings.authMode === 'manual',
    authorized: true,
    account: settings.account || '',
    target: settings.driveFile || 'bookmarks.json',
    branch: ''
  };
}

/**
 * 取当前后端需要的"凭证"。
 * Drive 要 OAuth access token，GitHub 要 PAT —— 上层统一叫 token 即可。
 */
export async function resolveToken(settings) {
  const name = resolveBackend(settings);
  if (name === BACKENDS.GITHUB) return githubBackend.requireGithubToken();
  return requireToken();
}

/** 只探测有没有凭证，不发起授权 */
export async function peekTokenFor(settings) {
  const name = resolveBackend(settings);
  if (name === BACKENDS.GITHUB) return githubBackend.getGithubToken();
  const t = await peekToken();
  return t ? t.accessToken : '';
}

export async function requireReady(settings) {
  const { name, backend } = backendFor(settings);
  if (name === BACKENDS.GITHUB) {
    await githubBackend.requireGithubToken();
    backend.cfgFromSettings(settings);
  }
  return name;
}

export { StorageError as Error };

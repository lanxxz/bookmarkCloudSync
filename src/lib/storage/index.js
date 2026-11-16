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

export { StorageError, isConflict, isAuthError } from './base.js';
export const BACKENDS = Object.freeze({ DRIVE: 'drive', GITHUB: 'github' });

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
  return { name, backend: getBackend(name) };
}

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
  if (name === BACKENDS.GITHUB) {
    const { requireGithubToken } = await import('./github.js');
    return requireGithubToken();
  }
  const { requireToken } = await import('../auth.js');
  return requireToken();
}

/** 只探测有没有凭证，不发起授权 */
export async function peekTokenFor(settings) {
  const name = resolveBackend(settings);
  if (name === BACKENDS.GITHUB) {
    const { getGithubToken } = await import('./github.js');
    return getGithubToken();
  }
  const { peekToken } = await import('../auth.js');
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

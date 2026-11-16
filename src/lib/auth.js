/**
 * Google OAuth 2.0（chrome.identity）。
 *
 * 支持两种模式，按配置自动选择：
 *  A. PKCE 授权码模式（推荐）：OAuth 客户端类型选「Web 应用」，
 *     重定向 URI 填 https://<EXTENSION_ID>.chromiumapp.org/。
 *     有 client_secret 就带上（Google Web 客户端需要），没有就用 PKCE 裸奔。
 *  B. 隐式模式：response_type=token，拿不到 refresh_token，靠静默重授权续期。
 * 另支持「手动粘贴 access token」，用于本地调试，不落盘 refresh token。
 *
 * 所有请求都只走 oauth2.googleapis.com，不经过任何第三方。
 */
import { logger } from './log.js';
import { withRetry } from './util.js';

const AUTH_KEY = 'bcs_auth';
const SETTINGS_KEY = 'bcs_settings';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/* ---------------- settings ---------------- */

export const DEFAULT_SETTINGS = {
  clientId: '',
  clientSecret: '',
  authMode: 'pkce', // pkce | implicit | manual
  account: '', // 上次登录的邮箱，仅用于展示
  driveFile: 'bookmarks.json',
  historyKeep: 10,
  localHistoryKeep: 30,
  autoSync: true,
  syncIntervalMinutes: 15,
  debounceMs: 4000,
  minIntervalMs: 30000,
  fieldConflict: 'latest', // latest | local | remote
  deleteConflict: 'keep', // keep | delete
  maxAutoDeletes: 50,
  maxAutoDeleteRatio: 0.25,
  tombstoneDays: 90,
  includeOtherBookmarks: true,
  excludeFolders: [],
  verbose: false
};

export async function getSettings() {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = res[SETTINGS_KEY] || {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/* ---------------- token cache ---------------- */

let tokenCache = null; // { accessToken, expiresAt, scope }
let authPromise = null;

function redirectUri() {
  return chrome.identity.getRedirectURL('oauth2');
}

export async function getAuthState() {
  const settings = await getSettings();
  const cached = await readCachedAuth();
  const token = await peekToken();
  return {
    configured: !!settings.clientId || settings.authMode === 'manual',
    mode: settings.authMode,
    account: settings.account,
    hasToken: !!token,
    expiresAt: token ? token.expiresAt : 0,
    hasRefreshToken: !!(cached && cached.refreshToken),
    redirectUri: safeRedirect(),
    scope: SCOPE
  };
}

function safeRedirect() {
  try {
    return redirectUri();
  } catch {
    return 'https://<extension-id>.chromiumapp.org/oauth2';
  }
}

async function readCachedAuth() {
  const res = await chrome.storage.local.get(AUTH_KEY);
  return res[AUTH_KEY] || null;
}

async function writeCachedAuth(value) {
  if (value) await chrome.storage.local.set({ [AUTH_KEY]: value });
  else await chrome.storage.local.remove(AUTH_KEY);
  tokenCache = value ? { accessToken: value.accessToken, expiresAt: value.expiresAt, scope: value.scope } : null;
}

export async function peekToken() {
  if (tokenCache && tokenCache.accessToken && tokenCache.expiresAt - Date.now() > 30_000) return tokenCache;
  const cached = await readCachedAuth();
  if (!cached || !cached.accessToken) return null;
  tokenCache = { accessToken: cached.accessToken, expiresAt: cached.expiresAt, scope: cached.scope };
  if (cached.expiresAt - Date.now() <= 30_000) return null;
  return tokenCache;
}

/** 获取可用 access token；过期则刷新，刷新失败则返回 null（由调用方决定是否重授权） */
export async function getToken({ interactive = false } = {}) {
  if (authPromise) return authPromise;
  authPromise = (async () => {
    const ok = await peekToken();
    if (ok) return ok.accessToken;

    const cached = await readCachedAuth();
    if (cached && cached.refreshToken) {
      try {
        const renewed = await refreshWithRefreshToken(cached.refreshToken);
        await writeCachedAuth({ ...cached, ...renewed });
        return renewed.accessToken;
      } catch (err) {
        logger.warn('刷新 access token 失败', err);
      }
    }
    if (cached && cached.tokenType === 'manual' && cached.accessToken && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }
    if (!interactive) return null;
    await authorize();
    const after = await peekToken();
    return after ? after.accessToken : null;
  })();
  try {
    return await authPromise;
  } finally {
    authPromise = null;
  }
}

/** 需要 token 的地方统一走这里：拿不到就抛 AuthError，由 UI 引导授权 */
export async function requireToken() {
  const token = await getToken({ interactive: false });
  if (token) return token;
  const err = new Error('未授权或授权已过期，请在扩展设置中连接 Google 账号');
  err.code = 'AUTH_REQUIRED';
  throw err;
}

/* ---------------- PKCE 工具 ---------------- */

function base64UrlEncode(bytes) {
  let str = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier(len = 64) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes).slice(0, len);
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

/* ---------------- 授权流程 ---------------- */

export async function authorize() {
  const settings = await getSettings();
  if (settings.authMode === 'manual') {
    throw Object.assign(new Error('当前为手动 token 模式，请在选项中粘贴 access token'), { code: 'MANUAL_MODE' });
  }
  if (!settings.clientId) {
    throw Object.assign(new Error('请先在设置中填写 OAuth Client ID'), { code: 'NO_CLIENT_ID' });
  }
  return settings.authMode === 'implicit' ? authorizeImplicit(settings) : authorizePkce(settings);
}

async function authorizePkce(settings) {
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const state = randomVerifier(16);
  const params = new URLSearchParams({
    client_id: settings.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: settings.account || ''
  });
  const url = AUTH_ENDPOINT + '?' + params.toString();
  logger.info('开始 PKCE 授权流程');
  const redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const parsed = new URL(redirect);
  const returnedState = parsed.searchParams.get('state');
  if (returnedState && returnedState !== state) {
    throw Object.assign(new Error('授权 state 校验失败，已中止'), { code: 'STATE_MISMATCH' });
  }
  const err = parsed.searchParams.get('error');
  if (err) throw Object.assign(new Error('授权被拒绝：' + err), { code: 'AUTH_DENIED', detail: parsed.searchParams.get('error_description') });
  const code = parsed.searchParams.get('code');
  if (!code) throw Object.assign(new Error('授权回调缺少 code'), { code: 'NO_CODE' });

  const body = new URLSearchParams({
    client_id: settings.clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri()
  });
  if (settings.clientSecret) body.set('client_secret', settings.clientSecret);

  const token = await fetchToken(body);
  const profile = await fetchProfile(token.access_token);
  const record = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || '',
    expiresAt: Date.now() + (token.expires_in || 3600) * 1000 - 60_000,
    scope: token.scope || SCOPE,
    tokenType: 'bearer',
    account: profile ? profile.email : settings.account,
    obtainedAt: Date.now()
  };
  await writeCachedAuth(record);
  await saveSettings({ account: record.account });
  logger.success('Google 授权成功' + (record.account ? '：' + record.account : ''));
  return record;
}

async function authorizeImplicit(settings) {
  const state = randomVerifier(16);
  const params = new URLSearchParams({
    client_id: settings.clientId,
    response_type: 'token',
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state,
    include_granted_scopes: 'true',
    login_hint: settings.account || ''
  });
  logger.info('开始隐式授权流程');
  const redirect = await chrome.identity.launchWebAuthFlow({ url: AUTH_ENDPOINT + '?' + params.toString(), interactive: true });
  const hash = redirect.includes('#') ? redirect.slice(redirect.indexOf('#') + 1) : '';
  const parsed = new URLSearchParams(hash);
  if (parsed.get('state') && parsed.get('state') !== state) {
    throw Object.assign(new Error('授权 state 校验失败，已中止'), { code: 'STATE_MISMATCH' });
  }
  const err = parsed.get('error');
  if (err) throw Object.assign(new Error('授权被拒绝：' + err), { code: 'AUTH_DENIED' });
  const accessToken = parsed.get('access_token');
  if (!accessToken) throw Object.assign(new Error('授权回调缺少 access_token'), { code: 'NO_TOKEN' });
  const expiresIn = Number(parsed.get('expires_in') || 3600);
  const profile = await fetchProfile(accessToken);
  const record = {
    accessToken,
    refreshToken: '',
    expiresAt: Date.now() + expiresIn * 1000 - 60_000,
    scope: parsed.get('scope') || SCOPE,
    tokenType: 'bearer',
    account: profile ? profile.email : settings.account,
    obtainedAt: Date.now()
  };
  await writeCachedAuth(record);
  await saveSettings({ account: record.account });
  logger.success('Google 授权成功（隐式模式，1 小时后需自动续期）');
  return record;
}

export async function signOut() {
  const cached = await readCachedAuth();
  if (cached && cached.accessToken && cached.tokenType !== 'manual') {
    try {
      await fetch(REVOKE_ENDPOINT + '?token=' + encodeURIComponent(cached.accessToken), { method: 'POST' });
    } catch (err) {
      logger.warn('撤销 token 失败（忽略）', err);
    }
  }
  await writeCachedAuth(null);
  await saveSettings({ account: '' });
  logger.info('已断开 Google 账号');
}

export async function setManualToken(accessToken, account = '') {
  const token = String(accessToken || '').trim();
  if (!token) throw Object.assign(new Error('token 为空'), { code: 'EMPTY_TOKEN' });
  const profile = await fetchProfile(token);
  if (!profile) throw Object.assign(new Error('token 无效或没有 drive.appdata 权限'), { code: 'INVALID_TOKEN' });
  const record = {
    accessToken: token,
    refreshToken: '',
    expiresAt: Date.now() + 55 * 60 * 1000,
    scope: SCOPE,
    tokenType: 'manual',
    account: account || profile.email,
    obtainedAt: Date.now()
  };
  await writeCachedAuth(record);
  await saveSettings({ account: record.account, authMode: 'manual' });
  return record;
}

/* ---------------- 网络 ---------------- */

async function fetchToken(body) {
  return withRetry(
    async () => {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      if (!res.ok) {
        const text = await res.text();
        const error = new Error('token 交换失败 HTTP ' + res.status + ' ' + text.slice(0, 300));
        error.code = 'TOKEN_EXCHANGE_FAILED';
        error.status = res.status;
        throw error;
      }
      return res.json();
    },
    {
      retries: 2,
      shouldRetry: (e) => e.status === 429 || e.status >= 500
    }
  );
}

async function refreshWithRefreshToken(refreshToken) {
  const settings = await getSettings();
  const body = new URLSearchParams({
    client_id: settings.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  if (settings.clientSecret) body.set('client_secret', settings.clientSecret);
  const token = await fetchToken(body);
  return {
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in || 3600) * 1000 - 60_000,
    scope: token.scope || SCOPE
  };
}

export async function fetchProfile(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user || null;
  } catch {
    return null;
  }
}

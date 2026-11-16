/**
 * 存储后端公共设施：错误类型、UTF-8 安全的 base64、版本号归一化。
 *
 * 为什么要有这一层：同步引擎只关心「读文档 / 写文档 / 列快照 / 读快照」四件事，
 * 至于底层是 Google Drive 还是 GitHub 私有仓库，不应该污染合并逻辑。
 */

export class StorageError extends Error {
  constructor(message, { status = 0, code = 'STORAGE_ERROR', retryable = false, detail } = {}) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export function isConflict(err) {
  return err && (err.code === 'CONFLICT' || err.code === 'PRECONDITION_FAILED' || err.status === 409 || err.status === 412);
}

export function isAuthError(err) {
  return err && (err.code === 'TOKEN_INVALID' || err.code === 'AUTH_REQUIRED' || err.status === 401);
}

/* ---------------- base64（必须走 UTF-8，书签标题全是中文） ---------------- */

export function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function fromBase64Utf8(b64) {
  const clean = String(b64 || '').replace(/[\s\r\n]/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------------- 路径 ---------------- */

/** 文档路径只允许一层目录 + 文件名，拒绝 .. 与绝对路径 */
export function sanitizePath(raw, fallback = 'bookmarks.json') {
  const input = String(raw || '').trim().replace(/\\/g, '/');
  if (!input) return fallback;
  const parts = input
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
  if (!parts.length) return fallback;
  return parts.slice(-3).join('/');
}

export function nowMs() {
  return Date.now();
}

/** 统一的退避重试：只对 429 / 5xx / 显式 retryable 生效 */
export async function retrying(fn, { retries = 2, base = 400, shouldRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const canRetry = shouldRetry ? shouldRetry(err) : err && (err.status === 429 || err.status >= 500 || err.retryable);
      if (!canRetry || attempt === retries) break;
      await new Promise((r) => setTimeout(r, base * Math.pow(2, attempt) + Math.floor(Math.random() * 150)));
    }
  }
  throw lastErr;
}

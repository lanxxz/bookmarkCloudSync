/**
 * Google Drive v3 REST 客户端（只用 appDataFolder 私有空间）。
 *
 * 设计要点：
 *  - 所有文件都在 appDataFolder 里，用户网盘里看不到，也不会和普通文件混淆；
 *  - 主文档用 ETag / If-Match 做乐观并发（412 = 云端被别人改过，重读重合并）；
 *  - 历史快照是独立文件，带 manifest，按环形队列裁剪；
 *  - 单次上传 5MB 以内走 multipart，超过走 resumable（书签极少超过）。
 */
import { withRetry } from './util.js';
import { requireToken } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const APP_DATA = 'appDataFolder';
export const HISTORY_DIR_NAME = 'bcs-history';

export class DriveError extends Error {
  constructor(message, { status = 0, code = 'DRIVE_ERROR', retryable = false, detail } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

function shouldRetry(err) {
  if (!(err instanceof DriveError)) return false;
  if (err.status === 429) return true;
  if (err.status >= 500) return true;
  return err.retryable;
}

async function api(path, { method = 'GET', headers = {}, body, token, expectJson = true } = {}) {
  const auth = token || (await requireToken());
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: { Authorization: 'Bearer ' + auth, ...headers },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = res.status === 401 ? 'TOKEN_INVALID' : res.status === 403 ? 'FORBIDDEN' : res.status === 404 ? 'NOT_FOUND' : res.status === 412 ? 'PRECONDITION_FAILED' : 'HTTP_' + res.status;
    throw new DriveError('Drive API ' + method + ' ' + path.split('?')[0] + ' -> ' + res.status + ' ' + text.slice(0, 400), {
      status: res.status,
      code,
      retryable: res.status === 429 || res.status >= 500
    });
  }
  if (!expectJson) return res;
  if (res.status === 204) return {};
  return res.json();
}

/* ---------------- 查询 ---------------- */

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,version,md5Checksum,parents';

export async function listAppData({ token, q, fields = FILE_FIELDS, pageSize = 100, pageToken } = {}) {
  const params = new URLSearchParams({
    spaces: APP_DATA,
    pageSize: String(pageSize),
    orderBy: 'modifiedTime desc',
    fields: 'nextPageToken,files(' + fields + ')'
  });
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  return api('/files?' + params.toString(), { token });
}

export async function findFile(name, { token, mimeType, trashed = false } = {}) {
  const clauses = ['name = ' + quote(name), 'trashed = ' + trashed];
  if (mimeType) clauses.push('mimeType = ' + quote(mimeType));
  const res = await listAppData({ token, q: clauses.join(' and '), pageSize: 10 });
  const files = res.files || [];
  return files.length ? files[0] : null;
}

function quote(v) {
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/* ---------------- 元数据 ---------------- */

export async function getFileMeta(fileId, { token } = {}) {
  return api('/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent(FILE_FIELDS), { token });
}

export async function getFileText(fileId, { token } = {}) {
  const auth = token || (await requireToken());
  const res = await fetch(API + '/files/' + encodeURIComponent(fileId) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + auth }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DriveError('下载文件失败 HTTP ' + res.status + ' ' + text.slice(0, 300), {
      status: res.status,
      code: res.status === 401 ? 'TOKEN_INVALID' : 'DOWNLOAD_FAILED',
      retryable: res.status === 429 || res.status >= 500
    });
  }
  return { text: await res.text(), etag: res.headers.get('ETag') || '', lastModified: res.headers.get('Last-Modified') || '' };
}

/**
 * 单独取一次 ETag。Drive 的媒体下载不保证带 ETag，
 * 缺了就没法做 If-Match 乐观并发，所以这里补一个元数据请求从响应头里取。
 */
export async function getFileEtag(fileId, { token } = {}) {
  const auth = token || (await requireToken());
  const res = await fetch(API + '/files/' + encodeURIComponent(fileId) + '?fields=id,version,modifiedTime,md5Checksum', {
    headers: { Authorization: 'Bearer ' + auth }
  });
  if (!res.ok) return { etag: '', version: 0 };
  const meta = await res.json().catch(() => ({}));
  return {
    etag: res.headers.get('ETag') || '',
    version: Number(meta.version) || 0,
    modifiedTime: meta.modifiedTime || '',
    md5Checksum: meta.md5Checksum || ''
  };
}

/** 带 ETag 的读取：返回 { meta, text, etag }，用于乐观并发 */
export async function readJsonFile(name, { token } = {}) {
  const meta = await findFile(name, { token });
  if (!meta) return null;
  const { text, etag } = await getFileText(meta.id, { token });
  let finalEtag = etag;
  if (!finalEtag) {
    const extra = await getFileEtag(meta.id, { token }).catch(() => ({ etag: '' }));
    finalEtag = extra.etag;
  }
  return { meta, text, etag: finalEtag };
}

/* ---------------- 上传 ---------------- */

function multipartBody(meta, content, boundary) {
  const head =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n';
  const tail = '\r\n--' + boundary + '--';
  return new Blob([head, content, tail], { type: 'multipart/related; boundary=' + boundary });
}

/** 新建文件（parent = appDataFolder），返回 meta */
export async function createTextFile(name, content, { token, mimeType = 'application/json' } = {}) {
  return withRetry(
    async () => {
      const auth = token || (await requireToken());
      const boundary = 'bcs' + Math.random().toString(36).slice(2);
      const meta = { name, parents: [APP_DATA], mimeType };
      const body = multipartBody(meta, content, boundary);
      const res = await fetch(UPLOAD + '/files?uploadType=multipart&fields=' + encodeURIComponent(FILE_FIELDS), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + auth,
          'Content-Type': 'multipart/related; boundary=' + boundary
        },
        body
      });
      return parseUpload(res, 'create', name);
    },
    { retries: 2, shouldRetry }
  );
}

/** 覆盖已有文件内容；带 If-Match 时冲突返回 PRECONDITION_FAILED */
export async function updateTextFile(fileId, content, { token, etag, mimeType = 'application/json', name } = {}) {
  return withRetry(
    async () => {
      const auth = token || (await requireToken());
      const boundary = 'bcs' + Math.random().toString(36).slice(2);
      const meta = {};
      if (name) meta.name = name;
      meta.mimeType = mimeType;
      const body = multipartBody(meta, content, boundary);
      const headers = {
        Authorization: 'Bearer ' + auth,
        'Content-Type': 'multipart/related; boundary=' + boundary
      };
      if (etag) headers['If-Match'] = etag;
      const res = await fetch(UPLOAD + '/files/' + encodeURIComponent(fileId) + '?uploadType=multipart&fields=' + encodeURIComponent(FILE_FIELDS), {
        method: 'PATCH',
        headers,
        body
      });
      return parseUpload(res, 'update', name || fileId);
    },
    { retries: 2, shouldRetry }
  );
}

async function parseUpload(res, action, name) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = res.status === 412 ? 'PRECONDITION_FAILED' : res.status === 401 ? 'TOKEN_INVALID' : 'UPLOAD_FAILED';
    throw new DriveError(action + ' ' + name + ' 失败 HTTP ' + res.status + ' ' + text.slice(0, 300), {
      status: res.status,
      code,
      retryable: res.status === 429 || res.status >= 500
    });
  }
  return res.json();
}

/** 在 appDataFolder 里建子目录（multipart 传空 body 建文件夹会 400，所以单独走元数据接口） */
export async function createFolder(name, { token, parentId } = {}) {
  return withRetry(
    async () => {
      const auth = token || (await requireToken());
      const res = await fetch(API + '/files?fields=' + encodeURIComponent(FILE_FIELDS), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + auth,
          'Content-Type': 'application/json; charset=UTF-8'
        },
        body: JSON.stringify({
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId || APP_DATA]
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new DriveError('创建目录 ' + name + ' 失败 HTTP ' + res.status + ' ' + text.slice(0, 300), {
          status: res.status,
          code: 'CREATE_FOLDER_FAILED',
          retryable: res.status === 429 || res.status >= 500
        });
      }
      return res.json();
    },
    { retries: 2, shouldRetry }
  );
}

export async function deleteFile(fileId, { token } = {}) {
  return withRetry(
    async () => {
      const auth = token || (await requireToken());
      const res = await fetch(API + '/files/' + encodeURIComponent(fileId), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + auth }
      });
      if (!res.ok && res.status !== 404) {
        throw new DriveError('删除文件失败 HTTP ' + res.status, { status: res.status, code: 'DELETE_FAILED', retryable: res.status >= 500 });
      }
      return { deleted: res.status === 204 || res.status === 200 };
    },
    { retries: 2, shouldRetry }
  );
}

export async function getStorageAbout({ token } = {}) {
  return api('/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)', { token });
}

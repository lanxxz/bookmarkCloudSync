/**
 * Google Drive 适配层：把已有的 drive.js 包成与 GitHub 后端同形的接口。
 *
 * 这样同步引擎只认「readDoc / writeDoc / listSnapshots / saveSnapshot / restoreSnapshot」
 * 五件事，切换后端不需要改任何合并逻辑。
 */
import {
  readJsonFile,
  createTextFile,
  updateTextFile,
  deleteFile,
  findFile,
  getFileText,
  listAppData,
  createFolder
} from '../drive.js';
import { StorageError, fromBase64Utf8 } from './base.js';
import { HISTORY_DIR_NAME } from '../drive.js';

export const KIND = 'drive';

export function cfgFromSettings(settings) {
  return { path: String(settings.driveFile || 'bookmarks.json') };
}

function wrap(err) {
  if (err instanceof StorageError) return err;
  const status = err.status || 0;
  return new StorageError(err.message, {
    status,
    code: status === 412 ? 'CONFLICT' : code(err),
    retryable: status === 429 || status >= 500
  });
}

function code(err) {
  if (err.code) return err.code;
  if (err.status === 401) return 'TOKEN_INVALID';
  if (err.status === 404) return 'NOT_FOUND';
  return 'DRIVE_ERROR';
}

/** 读当前文档 */
export async function readDoc(cfg, { token } = {}) {
  try {
    const file = await readJsonFile(cfg.path, { token });
    if (!file) return { exists: false };
    return { exists: true, text: file.text, version: file.etag || '', size: file.text.length, fileId: file.meta.id };
  } catch (err) {
    throw wrap(err);
  }
}

/** 只取元数据，用于远端轮询 */
export async function headDoc(cfg, { token } = {}) {
  try {
    const meta = await findFile(cfg.path, { token });
    if (!meta) return null;
    return { sha: meta.md5Checksum || meta.id + ':' + meta.modifiedTime, size: Number(meta.size) || 0, modifiedTime: meta.modifiedTime };
  } catch (err) {
    throw wrap(err);
  }
}

/**
 * 写文档。version 在这里是 ETag：
 * 有文件名冲突（412）就抛 CONFLICT，交由上层重读重合并。
 */
export async function writeDoc(cfg, text, { token, version, message } = {}) {
  try {
    /*
     * 关键：必须先按文件名查一次，再决定 create 还是 update。
     * 如果只按 version 是否为空来判断，一旦 ETag 缺失就会走 create 分支，
     * 结果同一个文件名被反复"新建"，云端堆出一堆同名文件，同步直接错乱。
     */
    const current = await findFile(cfg.path, { token });
    if (current) {
      const res = await updateTextFile(current.id, text, {
        token,
        etag: version || undefined,
        name: cfg.path
      });
      return {
        version: res.__etag || '',
        fileId: res.id || current.id,
        changed: true,
        message,
        updated: true
      };
    }
    const created = await createTextFile(cfg.path, text, { token });
    return { version: created.__etag || '', fileId: created.id, changed: true, message, created: true };
  } catch (err) {
    throw wrap(err);
  }
}

/* ---------------- 快照 ---------------- */

async function ensureHistoryFolder({ token }) {
  const found = await findFile(HISTORY_DIR_NAME, { token, mimeType: 'application/vnd.google-apps.folder' });
  if (found) return found.id;
  const created = await createFolder(HISTORY_DIR_NAME, { token }).catch(async () => {
    const again = await findFile(HISTORY_DIR_NAME, { token, mimeType: 'application/vnd.google-apps.folder' });
    if (again) return again;
    throw new StorageError('无法创建云端历史目录', { code: 'HISTORY_DIR_FAILED' });
  });
  return created.id;
}

async function uploadToFolder(folderId, name, content, { token }) {
  const { requireToken } = await import('../auth.js');
  const auth = token || (await requireToken());
  const boundary = 'bcs' + Math.random().toString(36).slice(2);
  const meta = { name, parents: [folderId], mimeType: 'application/json' };
  const head =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n';
  const tail = '\r\n--' + boundary + '--';
  const body = new Blob([head, content, tail], { type: 'multipart/related; boundary=' + boundary });
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new StorageError('上传历史快照失败 HTTP ' + res.status + ' ' + text.slice(0, 200), { status: res.status, code: 'SNAPSHOT_UPLOAD_FAILED' });
  }
  return res.json();
}

export async function saveSnapshot(cfg, { name, text, token }) {
  const folderId = await ensureHistoryFolder({ token });
  const meta = await uploadToFolder(folderId, name, text, { token });
  return { id: meta.id, name, version: meta.id };
}

export async function listSnapshots(cfg, { token, limit = 30 } = {}) {
  const folderId = await ensureHistoryFolder({ token });
  const all = [];
  let pageToken;
  do {
    const page = await listAppData({
      token,
      q: "'" + folderId + "' in parents and trashed = false",
      pageSize: 100,
      pageToken,
      fields: 'id,name,modifiedTime,size'
    });
    for (const f of page.files || []) all.push(f);
    pageToken = page.nextPageToken;
  } while (pageToken);
  all.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  return all.slice(0, limit).map((f) => ({
    id: f.id,
    name: f.name,
    size: Number(f.size || 0),
    ts: new Date(f.modifiedTime).getTime(),
    version: f.id
  }));
}

export async function readSnapshot(cfg, id, { token } = {}) {
  const { text } = await getFileText(id, { token });
  return { text };
}

export async function pruneSnapshots(cfg, { token, keep = 10 } = {}) {
  const folderId = await ensureHistoryFolder({ token });
  const all = [];
  let pageToken;
  do {
    const page = await listAppData({
      token,
      q: "'" + folderId + "' in parents and trashed = false",
      pageSize: 100,
      pageToken,
      fields: 'id,name,modifiedTime,size'
    });
    for (const f of page.files || []) all.push(f);
    pageToken = page.nextPageToken;
  } while (pageToken);
  all.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  const extra = all.slice(Math.max(1, keep));
  let removed = 0;
  for (const f of extra) {
    try {
      await deleteFile(f.id, { token });
      removed++;
    } catch {
      /* 单个删除失败不影响其它 */
    }
  }
  return { total: all.length, removed };
}

/** Drive 模式下"从某个历史版本恢复"= 按文件 id 读回内容 */
export async function readAtVersion(cfg, { id, token } = {}) {
  if (!id) throw new StorageError('缺少快照 id', { code: 'NO_VERSION' });
  const { text } = await getFileText(id, { token });
  return { text, version: id };
}

export { fromBase64Utf8 };

/**
 * IndexedDB 封装：状态 + 快照。
 *  - state：单条记录（syncState），存同步状态/映射表引用
 *  - snapshots：本地快照（推送前 + 拉取前都会留一份）
 *  - cache：本地文件的 etag / modifiedTime 缓存
 * 全部放在扩展自己的 origin 下，不受书签 API 影响。
 */

const DB_NAME = 'bcs';
const DB_VERSION = 1;
const STORE_STATE = 'state';
const STORE_SNAPSHOTS = 'snapshots';
const STORE_META = 'meta';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const s = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
        s.createIndex('byKind', 'kind');
        s.createIndex('byTime', 'ts');
      }
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------- state ---------------- */

export async function getIdbState(key) {
  const db = await openDb();
  return wrap(tx(db, STORE_STATE, 'readonly').get(key));
}

export async function setIdbState(key, value) {
  const db = await openDb();
  await wrap(tx(db, STORE_STATE, 'readwrite').put(value, key));
  return value;
}

/* ---------------- snapshots ---------------- */

export async function putSnapshot(record) {
  const db = await openDb();
  await wrap(tx(db, STORE_SNAPSHOTS, 'readwrite').put(record));
  return record;
}

export async function getSnapshot(id) {
  const db = await openDb();
  return wrap(tx(db, STORE_SNAPSHOTS, 'readonly').get(id));
}

export async function listSnapshots(limit = 50) {
  const db = await openDb();
  const store = tx(db, STORE_SNAPSHOTS, 'readonly');
  const rows = await wrap(store.index('byTime').getAll());
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, limit);
}

export async function deleteSnapshot(id) {
  const db = await openDb();
  await wrap(tx(db, STORE_SNAPSHOTS, 'readwrite').delete(id));
}

export async function countSnapshots() {
  const db = await openDb();
  return wrap(tx(db, STORE_SNAPSHOTS, 'readonly').count());
}

/** 本地快照裁剪：保留最近 localKeep 条，且不超过总预算 */
export async function pruneLocalSnapshots(localKeep) {
  const rows = await listSnapshots(100000);
  const extra = rows.slice(localKeep);
  for (const row of extra) await deleteSnapshot(row.id);
  return extra.length;
}

/* ---------------- meta ---------------- */

export async function getMeta(key) {
  const db = await openDb();
  return wrap(tx(db, STORE_META, 'readonly').get(key));
}

export async function setMeta(key, value) {
  const db = await openDb();
  await wrap(tx(db, STORE_META, 'readwrite').put(value, key));
  return value;
}

export async function clearAll() {
  const db = await openDb();
  for (const store of [STORE_STATE, STORE_SNAPSHOTS, STORE_META]) {
    await wrap(tx(db, store, 'readwrite').clear());
  }
}

#!/usr/bin/env node
/**
 * 用最小 chrome API 桩把所有模块真正 import 一遍。
 * 任何缺失的具名导出、循环依赖问题都会在这一步暴露，而不是等到浏览器里报错。
 */
const listeners = { addListener() {}, removeListener() {} };
const noop = () => {};
const asyncNoop = async () => ({});
const store = new Map();

globalThis.chrome = {
  runtime: {
    onInstalled: listeners,
    onStartup: listeners,
    onMessage: listeners,
    lastError: undefined,
    getURL: (p) => 'chrome-extension://test/' + p,
    getManifest: () => ({ version: '1.0.0' }),
    sendMessage: asyncNoop,
    openOptionsPage: noop
  },
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return store.has(key) ? { [key]: store.get(key) } : {};
        return Object.fromEntries(store);
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      async remove(key) {
        store.delete(key);
      }
    },
    onChanged: listeners
  },
  bookmarks: {
    getTree(cb) {
      cb([{ id: '0', children: [{ id: '1', title: '书签栏', children: [] }] }]);
    },
    getSubTree(id, cb) {
      cb([{ id, children: [] }]);
    },
    get(id, cb) {
      cb([]);
    },
    create(info, cb) {
      cb({ id: 'new-' + Math.random().toString(36).slice(2), ...info });
    },
    update(id, changes, cb) {
      cb({ id, ...changes });
    },
    move(id, dest, cb) {
      cb({ id, ...dest });
    },
    remove(id, cb) {
      cb();
    },
    removeTree(id, cb) {
      cb();
    },
    search(q, cb) {
      cb([]);
    },
    onCreated: listeners,
    onRemoved: listeners,
    onChanged: listeners,
    onMoved: listeners,
    onChildrenReordered: listeners,
    onImportEnded: listeners
  },
  alarms: {
    async clear() {
      return true;
    },
    create: noop,
    onAlarm: listeners
  },
  identity: {
    getRedirectURL: (p) => 'https://test.chromiumapp.org/' + p,
    launchWebAuthFlow: async () => 'https://test.chromiumapp.org/oauth2?code=x'
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  contextMenus: {
    removeAll(cb) {
      if (cb) cb();
    },
    create: noop,
    onClicked: listeners
  },
  notifications: { create: noop },
  tabs: { async create() {} }
};

const modules = [
  '../src/lib/util.js',
  '../src/lib/protocol.js',
  '../src/lib/messages.js',
  '../src/lib/log.js',
  '../src/lib/idb.js',
  '../src/lib/auth.js',
  '../src/lib/drive.js',
  '../src/lib/history.js',
  '../src/lib/local.js',
  '../src/lib/sync.js',
  '../src/background/alarms.js',
  '../src/background/bookmark-watch.js',
  '../src/background/service-worker.js'
];

let failed = 0;
for (const m of modules) {
  try {
    await import(m);
    console.log('OK   ' + m.replace('../', ''));
  } catch (err) {
    failed++;
    console.error('FAIL ' + m.replace('../', '') + '  ' + err.message);
  }
}
if (failed) {
  console.error(failed + ' 个模块装载失败');
  process.exit(1);
}
console.log('全部模块装载通过');

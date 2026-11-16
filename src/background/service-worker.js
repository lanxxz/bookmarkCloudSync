/**
 * Service Worker 入口：消息路由 + 事件编排。
 *
 * Service Worker 会被浏览器随时杀掉（30 秒空闲），所以：
 *  - 所有状态都在 IndexedDB / chrome.storage，不依赖内存；
 *  - 定时任务交给 chrome.alarms；
 *  - 书签变化只做"防抖打标"，真正同步由 alarm 或用户手动触发。
 */
import { MSG } from '../lib/messages.js';
import { logger, readLogs, clearLogs } from '../lib/log.js';
import {
  getSettings,
  saveSettings,
  authorize,
  signOut,
  getAuthState,
  setManualToken
} from '../lib/auth.js';
import {
  sync,
  previewSync,
  applyPendingSync,
  cancelPending,
  getStatus,
  ensureDeviceId,
  restoreSnapshot,
  resetSyncState,
  isLocked,
  loadState,
  inspectRemote,
  repairRemote
} from '../lib/sync.js';
import { getLocalSnapshots, listRemoteSnapshots, saveLocalSnapshot, SNAPSHOT_KIND } from '../lib/history.js';
import { scanLocal } from '../lib/local.js';
import { installWatch, requestAutoSync, bindSyncRunner } from './bookmark-watch.js';
import { setupAlarms, ALARM_SYNC, ALARM_REMOTE, checkRemoteChanged, markRemoteSeen } from './alarms.js';
import { createDoc, serializeDoc, docStats, docFromJson } from '../lib/protocol.js';
import { runSelfTest } from '../lib/selftest.js';
import { backendStatus, BACKENDS, resolveBackend, peekTokenFor } from '../lib/storage/index.js';
import { connectGithub, readGithubAuth, writeGithubAuth, listRepos } from '../lib/storage/github.js';

const CONTEXT_MENU_ID = 'bcs-sync-now';

/* ------------------------------------------------------------------ *
 * 安装 / 启动
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await logger.info('扩展已安装/更新：' + details.reason);
  await ensureDeviceId();
  await setupAlarms();
  installWatch();
  bindSyncRunner((reason) => runSync(reason || 'auto'));
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: CONTEXT_MENU_ID, title: '立即同步书签', contexts: ['action'] });
    });
  } catch {
    /* 某些 Chromium 分支不支持 action 上下文，忽略 */
  }
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options.html?welcome=1') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await logger.info('浏览器启动，恢复监听');
  await setupAlarms();
  installWatch();
  bindSyncRunner((reason) => runSync(reason || 'auto'));
  chrome.alarms.create(ALARM_REMOTE, { delayInMinutes: 1, periodInMinutes: 5 });
});

chrome.contextMenus?.onClicked?.addListener((info) => {
  if (info.menuItemId === CONTEXT_MENU_ID) runSync('context-menu');
});

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  handleMessage(message, sender)
    .then((res) => sendResponse({ ok: true, data: res }))
    .catch((err) => {
      logger.error('消息处理失败 ' + message.type + '：' + err.message, err);
      sendResponse({ ok: false, error: err.message, code: err.code || 'ERROR' });
    });
  return true; // 异步响应
});

async function handleMessage(msg) {
  switch (msg.type) {
    case MSG.PING:
      return { pong: true, at: Date.now() };

    case MSG.GET_STATUS:
      return getStatus();

    case MSG.DEVICE_INFO:
      return { deviceId: await ensureDeviceId(), ...(await getStatus()) };

    case MSG.SELF_TEST:
      return runSelfTest();

    case MSG.BACKEND_STATUS: {
      const settings = await getSettings();
      return backendStatus(settings);
    }

    case MSG.BACKEND_SET: {
      const backend = msg.backend === BACKENDS.GITHUB ? BACKENDS.GITHUB : BACKENDS.DRIVE;
      const next = await saveSettings({ backend });
      const status = await backendStatus(next);
      logger.info('存储后端切换为 ' + status.label);
      return status;
    }

    case MSG.GITHUB_CONNECT: {
      const settings = await getSettings();
      const owner = String(msg.owner || settings.githubOwner || '').trim();
      const repo = String(msg.repo || settings.githubRepo || '').trim();
      const res = await connectGithub({ token: msg.token, owner, repo });
      await saveSettings({
        backend: BACKENDS.GITHUB,
        githubOwner: owner,
        githubRepo: repo,
        githubBranch: msg.branch || settings.githubBranch || (res.repoInfo && res.repoInfo.defaultBranch) || 'main',
        githubPath: msg.path || settings.githubPath || 'bookmarks.json',
        account: res.login
      });
      logger.success('已连接 GitHub 仓库 ' + owner + '/' + repo + '（' + res.login + '）');
      return { ...res, status: await backendStatus(await getSettings()) };
    }

    case MSG.GITHUB_DISCONNECT:
      await writeGithubAuth(null);
      await saveSettings({ githubOwner: '', githubRepo: '', account: '' });
      logger.info('已断开 GitHub 连接');
      return { ok: true };

    case MSG.GITHUB_STATUS: {
      const settings = await getSettings();
      const auth = await readGithubAuth();
      return { auth: auth ? { login: auth.login, owner: auth.owner, repo: auth.repo, addedAt: auth.addedAt } : null, status: await backendStatus(settings) };
    }

    case MSG.GITHUB_REPOS: {
      const auth = await readGithubAuth();
      if (!auth || !auth.token) throw new Error('请先填写并验证 GitHub Token');
      return listRepos({ token: auth.token, limit: msg.limit || 50 });
    }

    case MSG.GET_SETTINGS:
      return getSettings();

    case MSG.SAVE_SETTINGS: {
      const next = await saveSettings(msg.patch || {});
      await setupAlarms(next);
      return next;
    }

    case MSG.AUTH_STATE:
      return getAuthState();

    case MSG.AUTH_START:
      return authorize();

    case MSG.AUTH_SIGNOUT:
      return signOut();

    case MSG.SET_MANUAL_TOKEN:
      return setManualToken(msg.token, msg.account);

    case MSG.SYNC_NOW:
      return runSync(msg.reason || 'manual');

    case MSG.PREVIEW:
      return previewSync();

    case MSG.APPLY_PREVIEW:
      return applyPendingSync();

    case MSG.CANCEL_PENDING:
      return cancelPending();

    case MSG.GET_LOGS:
      return readLogs();

    case MSG.CLEAR_LOGS:
      return clearLogs();

    case MSG.LIST_SNAPSHOTS: {
      const local = await getLocalSnapshots(60);
      const settings = await getSettings();
      let remote = [];
      try {
        const token = await peekTokenFor(settings);
        if (token) remote = await listRemoteSnapshots({ token, settings });
      } catch (err) {
        logger.warn('读取云端快照列表失败', err);
      }
      return { local, remote };
    }

    case MSG.CREATE_SNAPSHOT: {
      const settings = await getSettings();
      const state = await loadState();
      const local = await scanLocal({
        mapping: state?.mapping,
        deviceId: state?.deviceId,
        excludeFolders: settings.excludeFolders
      });
      const record = await saveLocalSnapshot({
        index: local.nodes,
        kind: SNAPSHOT_KIND.MANUAL,
        deviceId: state?.deviceId || '',
        reason: msg.reason || '手动快照'
      });
      return { id: record.id, count: record.count, ts: record.ts };
    }

    case MSG.RESTORE_SNAPSHOT:
      return restoreSnapshot({ source: msg.source || 'local', id: msg.id, mode: msg.mode || 'replace' });

    case MSG.EXPORT_DOC: {
      const state = await loadState();
      const settings = await getSettings();
      const local = await scanLocal({
        mapping: state?.mapping,
        deviceId: state?.deviceId,
        excludeFolders: settings.excludeFolders
      });
      const doc = createDoc({ nodes: local.nodes, revision: 0, writer: state?.deviceId || '' });
      return { json: serializeDoc(doc), stats: docStats({ nodes: local.nodes, revision: 0, updatedAt: 0 }) };
    }

    case MSG.IMPORT_DOC: {
      const parsed = docFromJson(msg.json);
      if (!parsed.ok) throw new Error('文件格式不正确：' + (parsed.error || 'unknown'));
      const deviceId = await ensureDeviceId();
      const current = await scanLocal({ mapping: null, deviceId });
      await saveLocalSnapshot({
        index: current.nodes,
        kind: SNAPSHOT_KIND.RESTORE,
        deviceId,
        reason: '导入前自动备份'
      });
      const record = await saveLocalSnapshot({
        index: parsed.doc.nodes,
        kind: SNAPSHOT_KIND.MANUAL,
        deviceId,
        reason: '导入文件'
      });
      return restoreSnapshot({ source: 'local', id: record.id, mode: msg.mode || 'replace' });
    }

    case MSG.REMOTE_INSPECT:
      return inspectRemote();

    case MSG.REPAIR_REMOTE:
      return repairRemote({ mode: msg.mode || 'repair', confirmOverwrite: !!msg.confirmOverwrite });

    case MSG.DEDUPE_REMOTE:
      return repairRemote({ mode: 'dedupe', confirmOverwrite: true });

    case MSG.RESET_SYNC:
      return resetSyncState();

    case MSG.OPEN_OPTIONS:
      chrome.runtime.openOptionsPage();
      return { opened: true };

    default:
      throw Object.assign(new Error('未知消息类型：' + msg.type), { code: 'UNKNOWN_MESSAGE' });
  }
}

/* ------------------------------------------------------------------ *
 * 同步入口（含节流）
 * ------------------------------------------------------------------ */

let lastRun = 0;

async function runSync(reason) {
  if (isLocked()) return { ok: false, skipped: true, message: '同步正在进行中' };
  const settings = await getSettings();
  const backend = resolveBackend(settings);
  const token = await peekTokenFor(settings);
  if (!token) {
    return {
      ok: false,
      error: 'AUTH_REQUIRED',
      message: backend === BACKENDS.GITHUB ? '请先在设置里填写 GitHub Token' : '请先在设置里连接 Google 账号'
    };
  }

  const gap = Date.now() - lastRun;
  const isAuto = reason === 'auto' || reason === 'alarm' || reason === 'remote-change' || reason === 'deferred';
  if (isAuto && gap < (settings.minIntervalMs || 30000)) {
    return { ok: false, skipped: true, reason: 'throttled', message: '距上次同步 ' + Math.round(gap / 1000) + ' 秒，已跳过' };
  }
  lastRun = Date.now();

  const result = await sync({ reason, token, settings });
  await updateBadge(result);
  // 自己写完立刻记下远端版本，避免下一轮轮询把"我刚推的"当成别人的改动
  if (result.ok) await markRemoteSeen({ settings }).catch(() => {});
  if (result.ok && result.toLocal && (result.toLocal.created || result.toLocal.deleted)) {
    notify('书签已同步：新增 ' + result.toLocal.created + '，删除 ' + result.toLocal.deleted);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 徽标 & 通知
 * ------------------------------------------------------------------ */

async function updateBadge(result) {
  try {
    if (result && result.blocked) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#e8a33d' });
      return;
    }
    if (result && result.ok === false && result.error) {
      await chrome.action.setBadgeText({ text: 'x' });
      await chrome.action.setBadgeBackgroundColor({ color: '#d9534f' });
      return;
    }
    await chrome.action.setBadgeText({ text: '' });
  } catch {
    /* ignore */
  }
}

function notify(message) {
  try {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Bookmark Cloud Sync',
      message
    });
  } catch {
    /* 通知不可用则忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 启动注册
 * ------------------------------------------------------------------ */

installWatch();
bindSyncRunner((reason) => runSync(reason || 'auto'));
setupAlarms().catch((err) => logger.warn('初始化定时任务失败', err));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_SYNC) {
    const settings = await getSettings();
    if (settings.autoSync) await runSync('alarm');
    await updateBadge(await getStatus().catch(() => null));
  } else if (alarm.name === ALARM_REMOTE) {
    const changed = await checkRemoteChanged().catch(() => false);
    if (changed) await runSync('remote-change');
  } else if (alarm.name === 'bcs-sync-debounce') {
    requestAutoSync('debounced');
  }
});

logger.info('service worker 已启动');

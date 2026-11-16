/**
 * 自检：在"真实浏览器环境"里逐项验证能力，而不是等同步报错才排查。
 *
 * 为什么需要它：ego(lite) 这类 Chromium 分支对扩展 API 的支持程度不一，
 * 有的没有 chrome.identity，有的 bookmarks 事件不全。部署前跑一遍能立刻定位。
 */
import { getSettings, getAuthState, peekToken } from './auth.js';
import { findFile } from './drive.js';
import { scanLocal } from './local.js';
import { loadState } from './sync.js';

function ok(name, detail) {
  return { name, status: 'ok', detail: detail || '' };
}
function warn(name, detail) {
  return { name, status: 'warn', detail: detail || '' };
}
function fail(name, detail) {
  return { name, status: 'fail', detail: detail || '' };
}

export async function runSelfTest() {
  const checks = [];

  /* 1. 基础 API */
  checks.push(chrome.bookmarks ? ok('chrome.bookmarks') : fail('chrome.bookmarks', '当前浏览器没有书签 API'));
  checks.push(chrome.storage?.local ? ok('chrome.storage') : fail('chrome.storage'));
  checks.push(chrome.alarms ? ok('chrome.alarms') : fail('chrome.alarms', '无法做定时补偿'));
  checks.push(
    chrome.identity && chrome.identity.launchWebAuthFlow
      ? ok('chrome.identity')
      : warn('chrome.identity', '缺少授权 API，需使用「手动 token」模式')
  );
  checks.push(
    chrome.bookmarks?.onCreated ? ok('bookmarks 事件') : warn('bookmarks 事件', '只能靠定时同步')
  );

  /* 2. 书签树可读 */
  try {
    const state = await loadState();
    const scan = await scanLocal({ mapping: state?.mapping || new Map(), deviceId: state?.deviceId || 'probe' });
    const count = scan.stats.bookmarks + scan.stats.folders;
    checks.push(count >= 0 ? ok('读取书签树', count + ' 个节点') : warn('读取书签树', '未读到节点'));
    checks.push(scan.barId ? ok('书签栏定位', 'id=' + scan.barId) : warn('书签栏定位', '未找到书签栏'));
  } catch (err) {
    checks.push(fail('读取书签树', err.message));
  }

  /* 3. 写入能力（建一个临时书签再删掉） */
  try {
    const parent = await new Promise((resolve, reject) => {
      chrome.bookmarks.getTree((tree) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        const root = tree && tree[0];
        const bar = (root?.children || [])[0];
        resolve(bar ? bar.id : null);
      });
    });
    if (!parent) {
      checks.push(warn('写入书签', '找不到书签栏，跳过'));
    } else {
      const created = await new Promise((resolve, reject) => {
        chrome.bookmarks.create({ parentId: parent, title: 'BCS self-test', url: 'https://example.com/bcs-selftest' }, (node) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          resolve(node);
        });
      });
      await new Promise((resolve) => chrome.bookmarks.remove(created.id, () => resolve()));
      checks.push(ok('写入书签', '创建并删除成功'));
    }
  } catch (err) {
    checks.push(fail('写入书签', err.message));
  }

  /* 4. 配置与授权 */
  const settings = await getSettings();
  checks.push(settings.clientId ? ok('OAuth Client ID', settings.clientId.slice(0, 24) + '…') : warn('OAuth Client ID', '未填写'));
  const auth = await getAuthState();
  checks.push(auth.hasToken ? ok('授权状态', auth.account || '已授权') : warn('授权状态', '未授权'));

  /* 5. 云端连通性 */
  const token = await peekToken();
  if (!token) {
    checks.push(warn('Drive 连通性', '未授权，跳过'));
  } else {
    try {
      const file = await findFile(settings.driveFile || 'bookmarks.json', { token });
      checks.push(
        ok('Drive appDataFolder', file ? '已存在同步文件（' + file.name + '）' : '尚未创建同步文件，首次同步会自动建立')
      );
    } catch (err) {
      checks.push(fail('Drive appDataFolder', err.message));
    }
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  return {
    checks,
    summary: { total: checks.length, ok: checks.length - failed - warned, warn: warned, fail: failed },
    verdict: failed ? 'fail' : warned ? 'warn' : 'ok'
  };
}

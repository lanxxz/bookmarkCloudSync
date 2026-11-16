import { MSG } from '../lib/messages.js';
import { formatRelative, formatTime } from '../lib/util.js';

const $ = (id) => document.getElementById(id);

function send(type, extra) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...(extra || {}) }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!res) return reject(new Error('后台无响应'));
      if (!res.ok) return reject(Object.assign(new Error(res.error || '操作失败'), { code: res.code }));
      resolve(res.data);
    });
  });
}

function setBusy(busy, label) {
  for (const id of ['btn-sync', 'btn-preview', 'btn-snapshot', 'btn-apply-pending']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
  if (label) $('status-text').textContent = label;
}

function showAlert(msg) {
  const box = $('alert');
  if (!msg) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.textContent = msg;
  box.classList.remove('hidden');
}

async function refresh() {
  try {
    const status = await send(MSG.GET_STATUS);
    renderStatus(status);
  } catch (err) {
    $('status-text').textContent = '读取状态失败';
    $('status-dot').className = 'dot err';
    showAlert(err.message);
  }
}

function renderStatus(s) {
  const dot = $('status-dot');
  dot.className = 'dot';
  const backendName = s.backendLabel || '云端';
  $('account-line').textContent = s.connected
    ? backendName + '：' + (s.target || s.account || '已连接')
    : backendName + '：未连接' + (s.account ? '（' + s.account + '）' : '');
  $('last-sync').textContent = s.lastSyncAt ? formatRelative(s.lastSyncAt) : '从未';
  $('revision').textContent = s.revision ? 'r' + s.revision : '—';
  $('device-id').textContent = s.deviceId ? s.deviceId.replace(/^dev-/, '').slice(0, 10) : '—';
  $('last-error').textContent = s.lastError ? '错误：' + s.lastError : '';

  if (!s.configured) {
    dot.classList.add('warn');
    $('status-text').textContent = s.backend === 'github' ? '需要先填写 GitHub 仓库' : '需要先填写 OAuth Client ID';
  } else if (!s.connected) {
    dot.classList.add('warn');
    $('status-text').textContent = s.backend === 'github' ? '未填写 GitHub Token' : '未授权，请连接 Google 账号';
  } else if (s.pending) {
    dot.classList.add('warn');
    $('status-text').textContent = '等待确认删除操作';
  } else if (s.lastError) {
    dot.classList.add('err');
    $('status-text').textContent = '上次同步失败';
  } else {
    dot.classList.add('ok');
    $('status-text').textContent = s.lastSyncAt ? '同步正常' : '已就绪，等待首次同步';
  }

  renderPending(s.pending);
  renderConflicts(s.conflicts);
  refreshCount();
}

async function refreshCount() {
  try {
    const doc = await send(MSG.EXPORT_DOC);
    $('local-count').textContent = doc.stats.total + ' 个（书签 ' + doc.stats.bookmarks + ' / 目录 ' + doc.stats.folders + '）';
  } catch {
    $('local-count').textContent = '—';
  }
}

function renderPending(pending) {
  const box = $('pending-box');
  if (!pending) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  $('pending-reason').textContent = pending.reason || '检测到大批量删除';
  const list = $('pending-list');
  list.textContent = '';
  const items = pending.deletes || [];
  for (const d of items.slice(0, 12)) {
    const li = document.createElement('li');
    li.textContent = (d.type === 'folder' ? '📁 ' : '🔗 ') + (d.title || '(无标题)');
    list.appendChild(li);
  }
  if (items.length > 12) {
    const li = document.createElement('li');
    li.textContent = '… 以及另外 ' + (items.length - 12) + ' 项';
    list.appendChild(li);
  }
}

function renderConflicts(conflicts) {
  const box = $('conflict-box');
  const list = $('conflict-list');
  list.textContent = '';
  if (!conflicts || !conflicts.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  for (const c of conflicts.slice(0, 8)) {
    const li = document.createElement('li');
    const title = (c.detail && (c.detail.title || c.detail.url)) || c.id;
    li.textContent = labelOf(c.kind) + '：' + String(title).slice(0, 46);
    list.appendChild(li);
  }
}

function labelOf(kind) {
  switch (kind) {
    case 'delete-vs-modify': return '删除/修改冲突（已保留）';
    case 'field': return '字段冲突（按时间取新）';
    case 'orphan': return '父节点丢失（已挂到书签栏）';
    case 'cycle': return '循环引用（已修复）';
    case 'duplicate-id': return '同 ID 内容不同';
    default: return kind;
  }
}

async function doSync() {
  showAlert('');
  setBusy(true, '同步中…');
  try {
    const res = await send(MSG.SYNC_NOW, { reason: 'manual' });
    if (res && res.blocked) {
      showAlert(res.message || '需要确认删除操作');
    } else if (res && res.ok === false) {
      showAlert(res.message || res.error || '同步失败');
      if (res.error === 'AUTH_REQUIRED') $('btn-open-options').textContent = '⚙';
    } else if (res && res.skipped) {
      showAlert(res.message || '已跳过');
    } else if (res) {
      const t = res.toLocal || {};
      showAlert(
        '完成：本地 +' + (t.created || 0) + ' / 更新 ' + (t.updated || 0) + ' / 移动 ' + (t.moved || 0) + ' / 删除 ' + (t.deleted || 0) +
        '，冲突 ' + (res.conflictCount || 0)
      );
    }
  } catch (err) {
    showAlert(err.message);
  } finally {
    setBusy(false);
    await refresh();
  }
}

async function doPreview() {
  showAlert('');
  setBusy(true, '计算差异…');
  const box = $('preview-box');
  try {
    const res = await send(MSG.PREVIEW);
    const lines = [];
    lines.push('云端文档：' + (res.remoteExists ? '存在（r' + res.remoteRevision + '）' : '尚不存在，首次同步将上传本机书签'));
    lines.push('合并后节点：' + res.mergedStats.total + '（书签 ' + res.mergedStats.bookmarks + ' / 目录 ' + res.mergedStats.folders + ' / 墓碑 ' + res.mergedStats.tombstones + '）');
    lines.push('');
    lines.push('[将要写入本机]');
    lines.push('  新建 ' + res.toLocal.creates + '，更新 ' + res.toLocal.updates + '，移动 ' + res.toLocal.moves + '，删除 ' + res.toLocal.deletes);
    lines.push('[将要写入云端]');
    lines.push('  新建 ' + res.toCloud.created + '，更新 ' + res.toCloud.updated + '，删除 ' + res.toCloud.deleted);
    if (res.conflictCount) {
      lines.push('');
      lines.push('[冲突 ' + res.conflictCount + ' 条]');
      for (const c of res.conflicts.slice(0, 6)) {
        lines.push('  · ' + labelOf(c.kind) + ' ' + String((c.detail && (c.detail.title || c.detail.url)) || c.id).slice(0, 40));
      }
    }
    if (res.preview && res.preview.deletes.length) {
      lines.push('');
      lines.push('[本机将被删除]');
      for (const d of res.preview.deletes.slice(0, 8)) lines.push('  - ' + (d.title || '(无标题)'));
    }
    $('preview-text').textContent = lines.join('\n');
    box.classList.remove('hidden');
    if (res.guard && res.guard.blocked) showAlert(res.guard.reason);
  } catch (err) {
    showAlert(err.message);
  } finally {
    setBusy(false);
    $('status-text').textContent = '就绪';
  }
}

async function doSnapshot() {
  showAlert('');
  try {
    const res = await send(MSG.CREATE_SNAPSHOT, { reason: '手动快照' });
    showAlert('已保存快照：' + res.count + ' 个节点');
  } catch (err) {
    showAlert(err.message);
  }
}

async function doApplyPending() {
  setBusy(true, '执行中…');
  try {
    const res = await send(MSG.APPLY_PREVIEW);
    showAlert('已执行：删除 ' + res.applied.deleted + ' 项');
  } catch (err) {
    showAlert(err.message);
  } finally {
    setBusy(false);
    await refresh();
  }
}

async function doCancelPending() {
  try {
    await send(MSG.CANCEL_PENDING);
    showAlert('已取消待确认的删除');
  } catch (err) {
    showAlert(err.message);
  }
  await refresh();
}

async function loadLogs() {
  const box = $('logs-box');
  const list = $('log-list');
  const open = box.classList.toggle('hidden') === false;
  if (!open) return;
  try {
    const logs = await send(MSG.GET_LOGS);
    list.textContent = '';
    for (const row of logs.slice(-60).reverse()) {
      const li = document.createElement('li');
      li.className = row.level;
      li.textContent = formatTime(row.t) + ' ' + row.message;
      list.appendChild(li);
    }
  } catch (err) {
    list.textContent = '读取日志失败：' + err.message;
  }
}

$('btn-sync').addEventListener('click', doSync);
$('btn-preview').addEventListener('click', doPreview);
$('btn-snapshot').addEventListener('click', doSnapshot);
$('btn-apply-pending').addEventListener('click', doApplyPending);
$('btn-cancel-pending').addEventListener('click', doCancelPending);
$('btn-open-options').addEventListener('click', () => send(MSG.OPEN_OPTIONS).catch(() => {}));
$('btn-logs').addEventListener('click', loadLogs);
$('btn-clear-logs').addEventListener('click', async () => {
  await send(MSG.CLEAR_LOGS).catch(() => {});
  $('log-list').textContent = '';
});

refresh();
setInterval(refresh, 5000);

import { MSG } from '../lib/messages.js';
import { formatTime } from '../lib/util.js';

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

let toastTimer = null;
function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (kind === 'error' ? ' error' : kind === 'warn' ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3800);
}

/* ---------------- 设置读写 ---------------- */

const FIELDS = [
  ['client-id', 'clientId', 'text'],
  ['client-secret', 'clientSecret', 'text'],
  ['auth-mode', 'authMode', 'text'],
  ['auto-sync', 'autoSync', 'bool'],
  ['sync-interval', 'syncIntervalMinutes', 'int'],
  ['debounce', 'debounceMs', 'int'],
  ['min-interval', 'minIntervalMs', 'secondsToMs'],
  ['drive-file', 'driveFile', 'text'],
  ['history-keep', 'historyKeep', 'int'],
  ['local-history-keep', 'localHistoryKeep', 'int'],
  ['tombstone-days', 'tombstoneDays', 'int'],
  ['field-conflict', 'fieldConflict', 'text'],
  ['delete-conflict', 'deleteConflict', 'text'],
  ['max-auto-deletes', 'maxAutoDeletes', 'int'],
  ['exclude-folders', 'excludeFolders', 'list']
];

function applySettings(s) {
  const backend = s.backend === 'github' ? 'github' : 'drive';
  const radio = $(backend === 'github' ? 'backend-github' : 'backend-drive');
  if (radio) radio.checked = true;
  applyBackendVisibility(backend);
  $('gh-token').value = '';
  $('gh-repo').value = s.githubOwner && s.githubRepo ? s.githubOwner + '/' + s.githubRepo : '';
  $('gh-branch-input').value = s.githubBranch || 'main';
  $('gh-path-input').value = s.githubPath || 'bookmarks.json';
  $('client-id').value = s.clientId || '';
  $('client-secret').value = s.clientSecret || '';
  $('auth-mode').value = s.authMode || 'pkce';
  $('auto-sync').value = String(!!s.autoSync);
  $('sync-interval').value = s.syncIntervalMinutes;
  $('debounce').value = s.debounceMs;
  $('min-interval').value = Math.round((s.minIntervalMs || 30000) / 1000);
  $('drive-file').value = s.driveFile || 'bookmarks.json';
  $('history-keep').value = s.historyKeep;
  $('local-history-keep').value = s.localHistoryKeep;
  $('tombstone-days').value = s.tombstoneDays;
  $('field-conflict').value = s.fieldConflict;
  $('delete-conflict').value = s.deleteConflict;
  $('max-auto-deletes').value = s.maxAutoDeletes;
  $('exclude-folders').value = (s.excludeFolders || []).join(',');
  toggleManualRow();
}

function collectSettings() {
  const patch = {};
  patch.backend = currentBackend();
  const slug = parseRepoSlug($('gh-repo').value);
  patch.githubOwner = slug ? slug.owner : '';
  patch.githubRepo = slug ? slug.repo : '';
  patch.githubBranch = $('gh-branch-input').value.trim() || 'main';
  patch.githubPath = $('gh-path-input').value.trim() || 'bookmarks.json';
  patch.clientId = $('client-id').value.trim();
  patch.clientSecret = $('client-secret').value.trim();
  patch.authMode = $('auth-mode').value;
  patch.autoSync = $('auto-sync').value === 'true';
  patch.syncIntervalMinutes = clampInt($('sync-interval').value, 1, 180, 15);
  patch.debounceMs = clampInt($('debounce').value, 1000, 60000, 4000);
  patch.minIntervalMs = clampInt($('min-interval').value, 5, 3600, 30) * 1000;
  patch.driveFile = ($('drive-file').value.trim() || 'bookmarks.json').replace(/[\\/]/g, '_');
  patch.historyKeep = clampInt($('history-keep').value, 1, 100, 10);
  patch.localHistoryKeep = clampInt($('local-history-keep').value, 5, 200, 30);
  patch.tombstoneDays = clampInt($('tombstone-days').value, 7, 365, 90);
  patch.fieldConflict = $('field-conflict').value;
  patch.deleteConflict = $('delete-conflict').value;
  patch.maxAutoDeletes = clampInt($('max-auto-deletes').value, 1, 10000, 50);
  patch.excludeFolders = $('exclude-folders')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
  return patch;
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function toggleManualRow() {
  $('manual-token-row').style.display = $('auth-mode').value === 'manual' ? 'flex' : 'none';
}

/* ---------------- 后端切换 ---------------- */

function currentBackend() {
  const checked = document.querySelector('input[name="backend"]:checked');
  return checked && checked.value === 'github' ? 'github' : 'drive';
}

function applyBackendVisibility(backend) {
  $('card-github').classList.toggle('hidden', backend !== 'github');
  $('card-drive').classList.toggle('hidden', backend !== 'drive');
  for (const opt of document.querySelectorAll('.backend-option')) {
    opt.classList.toggle('selected', opt.dataset.backend === backend);
  }
  $('welcome').classList.toggle('hidden', backend !== 'drive' || !new URLSearchParams(location.search).get('welcome'));
}

async function switchBackend(backend) {
  applyBackendVisibility(backend);
  try {
    const status = await send(MSG.BACKEND_SET, { backend });
    toast('已切换到 ' + status.label);
    await refreshAuth();
    await loadSnapshots();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------- GitHub ---------------- */

function parseRepoSlug(raw) {
  const v = String(raw || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  const parts = v.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

async function refreshGithubStatus() {
  try {
    const res = await send(MSG.GITHUB_STATUS);
    const status = res.status || {};
    if (status.backend !== 'github') {
      $('gh-state').textContent = '当前未使用 GitHub 后端';
      $('gh-target').textContent = status.target || '—';
      $('gh-branch').textContent = '—';
      return;
    }
    $('gh-state').textContent = status.authorized
      ? '已连接' + (status.account ? '（' + status.account + '）' : '')
      : status.configured
        ? '已填写仓库，但还没有有效 Token'
        : '未配置';
    $('gh-target').textContent = status.target || '—';
    $('gh-branch').textContent = (status.branch || 'main') + ' / ' + ($('gh-path-input').value || 'bookmarks.json');
    if (!status.configured && !$('gh-repo').value) $('btn-gh-connect').classList.add('primary');
  } catch (err) {
    $('gh-state').textContent = '读取失败：' + err.message;
  }
}

async function connectGithubFromForm() {
  const token = $('gh-token').value.trim();
  const slug = parseRepoSlug($('gh-repo').value);
  if (!token) return toast('请先填写 Fine-grained PAT', 'warn');
  if (!slug) return toast('仓库格式应为 owner/repo', 'warn');
  $('btn-gh-connect').disabled = true;
  try {
    const res = await send(MSG.GITHUB_CONNECT, {
      token,
      owner: slug.owner,
      repo: slug.repo,
      branch: $('gh-branch-input').value.trim() || 'main',
      path: $('gh-path-input').value.trim() || 'bookmarks.json'
    });
    $('gh-token').value = '';
    if (res.repoInfo && res.repoInfo.private === false) {
      toast('已连接，但该仓库是公开的 —— 建议改成 Private，否则书签内容对所有人可见', 'warn');
    } else {
      toast('已连接 ' + slug.owner + '/' + slug.repo);
    }
    await refreshGithubStatus();
    await refreshAuth();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('btn-gh-connect').disabled = false;
  }
}

async function listGithubRepos() {
  const token = $('gh-token').value.trim();
  if (token) {
    // 先把 token 存下来才能列仓库
    const slug = parseRepoSlug($('gh-repo').value) || { owner: '', repo: '' };
    if (!slug.owner) {
      toast('请先填写完整仓库名再点「连接仓库」，或用下面的方式直接输入', 'warn');
    }
  }
  try {
    const repos = await send(MSG.GITHUB_REPOS, { limit: 50 });
    const dl = $('gh-repo-list');
    dl.textContent = '';
    for (const r of repos) {
      const opt = document.createElement('option');
      opt.value = r.fullName;
      opt.label = (r.private ? '🔒 ' : '🌐 ') + r.fullName + (r.canPush ? '' : '（无写权限）');
      dl.appendChild(opt);
    }
    toast('已加载 ' + repos.length + ' 个仓库，点击输入框可选');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------- 授权 ---------------- */

async function refreshAuth() {
  const backend = currentBackend();
  if (backend === 'github') {
    $('auth-account').textContent = $('gh-state').textContent;
    $('auth-state').textContent = 'GitHub 后端（不需要 Google 授权）';
    return;
  }
  try {
    const state = await send(MSG.AUTH_STATE);
    $('auth-account').textContent = state.account || '未连接';
    $('auth-state').textContent = state.hasToken
      ? '已授权' + (state.hasRefreshToken ? '（可自动续期）' : '（短期 token）')
      : state.configured
        ? '未授权'
        : '未配置 Client ID';
    $('redirect-uri').textContent = state.redirectUri;
    $('btn-auth').disabled = state.mode === 'manual';
  } catch (err) {
    toast('读取授权状态失败：' + err.message, 'error');
  }
}

async function doAuth() {
  $('btn-auth').disabled = true;
  try {
    await send(MSG.SAVE_SETTINGS, { patch: collectSettings() });
    await send(MSG.AUTH_START);
    toast('授权成功');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('btn-auth').disabled = false;
    await refreshAuth();
  }
}

async function doSignOut() {
  try {
    await send(MSG.AUTH_SIGNOUT);
    toast('已断开 Google 账号');
  } catch (err) {
    toast(err.message, 'error');
  }
  await refreshAuth();
}

/* ---------------- 快照 ---------------- */

let snapshotTab = 'remote';
let snapshotCache = { local: [], remote: [] };

async function loadSnapshots() {
  const box = $('snapshot-list');
  box.textContent = '加载中…';
  try {
    snapshotCache = await send(MSG.LIST_SNAPSHOTS);
  } catch (err) {
    box.textContent = '读取失败：' + err.message;
    return;
  }
  renderSnapshots();
}

function renderSnapshots() {
  const box = $('snapshot-list');
  const rows = snapshotTab === 'remote' ? snapshotCache.remote : snapshotCache.local;
  box.textContent = '';
  if (!rows || !rows.length) {
    const p = document.createElement('div');
    p.className = 'snap-empty';
    p.textContent = snapshotTab === 'remote' ? '云端还没有快照（首次同步后会自动生成）' : '本地还没有快照';
    box.appendChild(p);
    return;
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'snap-item';

    const left = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = formatTime(row.ts) + ' · ' + (row.kind || 'snapshot');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (row.count ? row.count + ' 个节点 · ' : '') + (row.size ? Math.round(row.size / 1024) + ' KB · ' : '') + (row.source === 'drive' ? 'Drive' : '本地');
    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const btnMerge = document.createElement('button');
    btnMerge.className = 'ghost small';
    btnMerge.textContent = '合并恢复';
    btnMerge.addEventListener('click', () => restore(row, 'merge'));
    const btnReplace = document.createElement('button');
    btnReplace.className = 'ghost small';
    btnReplace.textContent = '覆盖恢复';
    btnReplace.addEventListener('click', () => restore(row, 'replace'));
    actions.appendChild(btnMerge);
    actions.appendChild(btnReplace);

    item.appendChild(left);
    item.appendChild(actions);
    box.appendChild(item);
  }
}

async function restore(row, mode) {
  const warn =
    mode === 'replace'
      ? '覆盖恢复会先清空本机书签（永久文件夹除外），然后用快照重建。\n恢复前会自动保存当前状态快照。\n\n确定继续？'
      : '合并恢复只把快照里缺失的节点补回本机，不会删除现有书签。\n\n确定继续？';
  if (!confirm(warn)) return;
  try {
    const res = await send(MSG.RESTORE_SNAPSHOT, { source: row.source, id: row.id, mode });
    toast('恢复完成：' + res.restored + ' 个节点' + (res.errors && res.errors.length ? '，' + res.errors.length + ' 个错误' : ''));
  } catch (err) {
    toast(err.message, 'error');
  }
  await loadSnapshots();
}

/* ---------------- 日志 ---------------- */

async function loadLogs() {
  try {
    const logs = await send(MSG.GET_LOGS);
    const list = $('log-list');
    list.textContent = '';
    for (const row of logs.slice(-120).reverse()) {
      const li = document.createElement('li');
      li.className = row.level;
      li.textContent = formatTime(row.t) + ' ' + row.message;
      list.appendChild(li);
    }
  } catch (err) {
    $('log-list').textContent = '读取日志失败：' + err.message;
  }
}

/* ---------------- 导入导出 ---------------- */

async function exportDoc() {
  try {
    const data = await send(MSG.EXPORT_DOC);
    const blob = new Blob([data.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bookmarks-export-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出 ' + data.stats.total + ' 个节点');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------- 事件绑定 ---------------- */

$('btn-save').addEventListener('click', async () => {
  try {
    await send(MSG.SAVE_SETTINGS, { patch: collectSettings() });
    $('save-hint').textContent = '已保存 ' + new Date().toLocaleTimeString();
    toast('设置已保存');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('btn-sync').addEventListener('click', async () => {
  toast('同步中…');
  try {
    const res = await send(MSG.SYNC_NOW, { reason: 'options' });
    if (res.blocked) toast(res.message || '需要确认删除', 'warn');
    else if (res.ok === false) toast(res.message || res.error || '同步失败', 'error');
    else toast('完成：本地 +' + res.toLocal.created + ' / -' + res.toLocal.deleted);
  } catch (err) {
    toast(err.message, 'error');
  }
  await loadLogs();
});

$('btn-preview').addEventListener('click', async () => {
  try {
    const res = await send(MSG.PREVIEW);
    toast(
      '将要写入本机：+' + res.toLocal.creates + ' ~' + res.toLocal.updates + ' -' + res.toLocal.deletes +
        '；写入云端：+' + res.toCloud.created + ' -' + res.toCloud.deleted
    );
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('btn-auth').addEventListener('click', doAuth);
$('btn-signout').addEventListener('click', doSignOut);
$('btn-copy-redirect').addEventListener('click', async () => {
  const text = $('redirect-uri').textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制重定向 URI');
  } catch {
    toast('复制失败，请手动选中复制', 'error');
  }
});

$('auth-mode').addEventListener('change', toggleManualRow);

$('btn-manual-token').addEventListener('click', async () => {
  const token = $('manual-token').value.trim();
  if (!token) return toast('请先粘贴 token', 'warn');
  try {
    await send(MSG.SET_MANUAL_TOKEN, { token });
    toast('token 已保存');
  } catch (err) {
    toast(err.message, 'error');
  }
  await refreshAuth();
});

/* ---------------- 云端健康 ---------------- */

function showHealth(lines) {
  const box = $('health-out');
  box.textContent = lines.join('\n');
  box.classList.remove('hidden');
}

async function inspectRemoteDoc() {
  showHealth(['检查中…']);
  try {
    const r = await send(MSG.REMOTE_INSPECT);
    if (!r.exists) {
      showHealth(['云端还没有同步文件（' + r.path + '）。点「立即同步」会创建。']);
      return;
    }
    const lines = [
      '后端：' + r.backend,
      '路径：' + r.path,
      '版本：' + (r.version ? r.version.slice(0, 24) : '—'),
      '大小：' + r.size + ' 字节',
      '结构：' + r.shape,
      '可解析：' + (r.parsable ? '是' : '否'),
      r.repaired ? '自动修复：' + r.repaired : '',
      r.errors.length ? '问题：\n  · ' + r.errors.join('\n  · ') : '',
      '',
      '—— 前 800 字符 ——',
      r.preview
    ].filter((l) => l !== '');
    showHealth(lines);
  } catch (err) {
    showHealth(['检查失败：' + err.message]);
  }
}

async function repairRemoteDoc() {
  if (!confirm('会先把当前的云端文件备份到 bcs-backup/，再归一化写回。\n如果结构无法识别，会提示你改用「用本机重建」。\n\n继续？')) return;
  showHealth(['修复中…']);
  try {
    const r = await send(MSG.REPAIR_REMOTE, { mode: 'repair' });
    if (r.ok) {
      showHealth(['已修复：' + r.nodes + ' 个节点，云端版本 r' + r.revision, '备份：' + r.backup]);
      toast('云端文档已归一化');
    } else {
      showHealth(['无法自动修复：' + r.error, r.backup ? '原始内容已备份到 ' + r.backup : '', '', '建议改用「用本机重建」。']);
      toast('需要手动处理', 'warn');
    }
  } catch (err) {
    showHealth(['修复失败：' + err.message]);
  }
}

async function rebuildRemoteDoc() {
  if (!confirm('这会把云端文档整份替换成"当前这台电脑的书签"。\n另一台设备上独有的书签不会保留。\n原始内容会先备份到 bcs-backup/。\n\n确定继续？')) return;
  if (!confirm('再确认一次：云端将被本机书签覆盖。')) return;
  showHealth(['重建中…']);
  try {
    const r = await send(MSG.REPAIR_REMOTE, { mode: 'rebuild', confirmOverwrite: true });
    showHealth(['已重建：' + r.nodes + ' 个节点，云端版本 r' + r.revision, '备份：' + r.backup]);
    toast('云端文档已用本机书签重建');
  } catch (err) {
    showHealth(['重建失败：' + err.message]);
  }
}

async function dedupeRemoteDoc() {
  if (
    !confirm(
      '用于"同一批书签被存成一式两份"的情况：\n' +
        '同一层级下标题与网址完全相同的副本，只保留第一份，其余打墓碑（不是物理删除）。\n' +
        '原始内容会先备份到 bcs-backup/。\n\n继续？'
    )
  )
    return;
  showHealth(['去重中…']);
  try {
    const r = await send(MSG.DEDUPE_REMOTE);
    if (!r.ok) {
      showHealth([...String(r.error).split('\n'), '', r.backup ? '原始内容已备份到 ' + r.backup : '', '可以先把上面「实际结构 / 文件开头」发给我。']);
      toast('需要手动处理', 'warn');
      return;
    }
    if (!r.removed) {
      showHealth(['云端没有发现重复副本（' + r.nodes + ' 个节点），无需改动。', '备份：' + r.backup]);
      toast('没有重复副本');
      return;
    }
    const lines = [
      '已清理重复副本：打墓碑 ' + r.removed + ' 个节点',
      '剩余节点：' + r.nodes + '，云端版本 r' + r.revision,
      '备份：' + r.backup,
      '',
      '—— 重复组（最多 20 条）——'
    ];
    for (const g of r.groups || []) {
      lines.push('  · ' + (g.type === 'folder' ? '[文件夹] ' : '') + (g.title || '(无标题)') + ' ×' + g.copies);
    }
    if (r.groupCount > (r.groups || []).length) lines.push('  …共 ' + r.groupCount + ' 组');
    lines.push('', '去重后请再点一次「立即同步」。');
    showHealth(lines);
    toast('已清理 ' + r.removed + ' 个重复节点');
  } catch (err) {
    showHealth(['去重失败：' + err.message]);
  }
}

$('btn-inspect').addEventListener('click', inspectRemoteDoc);
$('btn-repair').addEventListener('click', repairRemoteDoc);
$('btn-dedupe').addEventListener('click', dedupeRemoteDoc);
$('btn-rebuild').addEventListener('click', rebuildRemoteDoc);

$('btn-snapshot').addEventListener('click', async () => {
  try {
    const res = await send(MSG.CREATE_SNAPSHOT, { reason: '手动快照' });
    toast('已保存快照：' + res.count + ' 个节点');
  } catch (err) {
    toast(err.message, 'error');
  }
  await loadSnapshots();
});

for (const opt of document.querySelectorAll('input[name="backend"]')) {
  opt.addEventListener('change', () => switchBackend(currentBackend()));
}

$('btn-gh-connect').addEventListener('click', connectGithubFromForm);
$('btn-gh-repos').addEventListener('click', listGithubRepos);
$('btn-gh-disconnect').addEventListener('click', async () => {
  if (!confirm('断开后 Token 会从本机删除，云端数据不受影响。继续？')) return;
  try {
    await send(MSG.GITHUB_DISCONNECT);
    toast('已断开 GitHub 连接');
  } catch (err) {
    toast(err.message, 'error');
  }
  await refreshGithubStatus();
});

$('btn-selftest').addEventListener('click', async () => {
  const list = $('selftest-list');
  list.textContent = '检测中…';
  try {
    const res = await send(MSG.SELF_TEST);
    list.textContent = '';
    for (const c of res.checks) {
      const li = document.createElement('li');
      li.className = c.status;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = c.status === 'ok' ? 'OK' : c.status === 'warn' ? '注意' : '失败';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name;
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = c.detail || '';
      li.append(tag, name, detail);
      list.appendChild(li);
    }
    const s = res.summary;
    $('selftest-verdict').textContent = '通过 ' + s.ok + ' / 注意 ' + s.warn + ' / 失败 ' + s.fail;
    toast(res.verdict === 'ok' ? '自检全部通过' : res.verdict === 'warn' ? '自检完成，有需要注意的项' : '自检发现失败项', res.verdict === 'ok' ? '' : res.verdict);
  } catch (err) {
    list.textContent = '';
    toast(err.message, 'error');
  }
});

$('btn-refresh-snapshots').addEventListener('click', loadSnapshots);
$('btn-export').addEventListener('click', exportDoc);
$('btn-refresh-logs').addEventListener('click', loadLogs);
$('btn-clear-logs').addEventListener('click', async () => {
  await send(MSG.CLEAR_LOGS).catch(() => {});
  $('log-list').textContent = '';
});

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('重置同步基线会丢弃「上次同步结果」的记忆，下次同步将重新比较全量。\n本机书签和云端文件都不会被删除。\n\n继续？')) return;
  try {
    await send(MSG.RESET_SYNC);
    toast('已重置同步基线');
  } catch (err) {
    toast(err.message, 'error');
  }
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
    tab.classList.add('active');
    snapshotTab = tab.dataset.tab;
    renderSnapshots();
  });
}

/* ---------------- 启动 ---------------- */

(async function init() {
  const manifest = chrome.runtime.getManifest();
  $('version-badge').textContent = 'v' + manifest.version;
  if (new URLSearchParams(location.search).get('welcome')) $('welcome').classList.remove('hidden');

  const settings = await send(MSG.GET_SETTINGS).catch(() => null);
  if (settings) applySettings(settings);
  await refreshAuth();
  await refreshGithubStatus();
  await loadLogs();
  await loadSnapshots();

  const status = await send(MSG.GET_STATUS).catch(() => null);
  if (status) $('device-footer').textContent = '设备 ' + (status.deviceId || '—');
})();

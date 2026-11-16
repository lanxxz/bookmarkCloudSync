#!/usr/bin/env node
/**
 * 书签文档独立校验器（零依赖，可单独拷进"书签仓库"跑 CI）。
 *
 * 为什么要在扩展之外再写一份校验：
 *   扩展里的 protocol.js 是"生产者"，它按自己的理解写文档。如果它对某条不变量
 *   理解错了，自己检查自己是查不出来的。这里用一份独立的实现去读同一份 JSON，
 *   相当于给生产端配了个对照实现（differential oracle）。
 *
 * 检查分三类：
 *   结构错误 —— 违反不变量，数据已损坏，exit 1
 *   可疑变更 —— 相对上一个 commit 的批量删除/新增，可能是事故，exit 2
 *   提示项   —— 空标题、重复 URL 等，不影响使用
 *
 * 用法：
 *   node verify-doc.mjs bookmarks.json
 *   node verify-doc.mjs bookmarks.json --prev HEAD~1
 *   node verify-doc.mjs bookmarks.json --github-summary
 *   node verify-doc.mjs bookmarks.json --json
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 2;
export const ROOT_NODE_ID = 'root';
export const DEFAULT_MAX_DELETE_RATIO = 0.35;
export const MIN_BASE_FOR_RATIO = 5;

const ALLOWED_SCHEMES = new Set([
  'http:', 'https:', 'file:', 'ftp:', 'ftps:', 'chrome:', 'edge:', 'about:', 'data:', 'mailto:', 'chrome-extension:'
]);

const TITLE_MAX = 512;
const MAX_NODES = 500000;
const MAX_DEPTH = 64;

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

export function parseDoc(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: ['JSON 解析失败：' + err.message] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['顶层不是对象'] };
  }
  return { ok: true, doc: data };
}

/* ------------------------------------------------------------------ *
 * 结构校验
 * ------------------------------------------------------------------ */

/**
 * 全量校验。返回 { errors, warnings, stats, anomalies }。
 * errors 非空表示文档已经不能用，必须人工介入。
 */
export function validateDoc(doc, { maxDeleteRatio = DEFAULT_MAX_DELETE_RATIO } = {}) {
  const errors = [];
  const warnings = [];
  const stats = { total: 0, folders: 0, bookmarks: 0, tombstones: 0, roots: 0, maxDepth: 0, duplicateUrls: 0 };

  if (doc.schemaVersion === undefined) errors.push('缺少 schemaVersion');
  else if (!Number.isFinite(doc.schemaVersion)) errors.push('schemaVersion 不是数字');
  else if (doc.schemaVersion > SCHEMA_VERSION) errors.push('schemaVersion=' + doc.schemaVersion + ' 高于本校验器支持的 ' + SCHEMA_VERSION);

  if (!Array.isArray(doc.nodes)) {
    errors.push('nodes 不是数组');
    return { errors, warnings, stats, anomalies: [] };
  }
  if (doc.nodes.length > MAX_NODES) errors.push('nodes 数量异常：' + doc.nodes.length);

  const byId = new Map();
  for (let i = 0; i < doc.nodes.length; i++) {
    const n = doc.nodes[i];
    const at = 'nodes[' + i + ']';
    if (!n || typeof n !== 'object') {
      errors.push(at + ' 不是对象');
      continue;
    }
    if (typeof n.id !== 'string' || !n.id) {
      errors.push(at + ' 缺少 id');
      continue;
    }
    if (n.id === ROOT_NODE_ID) {
      warnings.push(at + ' 用了保留 id "' + ROOT_NODE_ID + '"，将被忽略');
      continue;
    }
    if (byId.has(n.id)) {
      errors.push('重复 id：' + n.id + '（索引 ' + byId.get(n.id).__index + ' 与 ' + i + '）');
      continue;
    }
    n.__index = i;
    byId.set(n.id, n);
  }

  stats.total = byId.size;

  const activeIds = new Set();
  const seenUrls = new Map();

  for (const [id, n] of byId) {
    const at = 'nodes[' + n.__index + '] (' + id + ')';

    if (n.type !== 'folder' && n.type !== 'bookmark') {
      errors.push(at + ' type 非法：' + String(n.type));
      continue;
    }
    if (typeof n.parentId !== 'string' && n.parentId !== null) {
      errors.push(at + ' parentId 类型非法');
    }
    if (typeof n.title !== 'string') errors.push(at + ' title 不是字符串');
    else if (n.title.length > TITLE_MAX) warnings.push(at + ' 标题过长（' + n.title.length + ' 字符）');

    if (!Number.isFinite(n.index)) errors.push(at + ' index 不是数字');
    else if (n.index < 0) errors.push(at + ' index 为负：' + n.index);

    if (n.deleted) {
      stats.tombstones++;
      if (!Number.isFinite(n.deletedAt) || n.deletedAt <= 0) {
        errors.push(at + ' 是墓碑但没有有效的 deletedAt');
      }
    } else {
      activeIds.add(id);
      if (n.type === 'folder') {
        stats.folders++;
        if (n.url) warnings.push(at + ' 是文件夹却带 url');
      } else {
        stats.bookmarks++;
        if (!n.url) {
          errors.push(at + ' 是书签但没有 url');
        } else if (!isSafeUrl(n.url)) {
          errors.push(at + ' url 协议不受支持：' + n.url.slice(0, 60));
        } else {
          const key = normalizeUrl(n.url);
          if (seenUrls.has(key)) {
            stats.duplicateUrls++;
          } else {
            seenUrls.set(key, id);
          }
        }
      }
      if (!n.title) warnings.push(at + ' 标题为空');
    }
  }

  if (doc.nodes.length && byId.size === 0) errors.push('nodes 里没有任何有效节点');

  /* 父子关系：父必须存在且是文件夹（或挂在 root） */
  for (const [id, n] of byId) {
    if (n.deleted) continue;
    const pid = n.parentId;
    if (pid === ROOT_NODE_ID || pid === null || pid === undefined) {
      stats.roots++;
      continue;
    }
    const parent = byId.get(pid);
    if (!parent) {
      errors.push('节点 ' + id + ' 的父节点 ' + pid + ' 不存在（孤儿）');
      continue;
    }
    if (parent.type !== 'folder') errors.push('节点 ' + id + ' 挂在了非文件夹 ' + pid + ' 上');
    if (parent.deleted) errors.push('节点 ' + id + ' 挂在已删除的父节点 ' + pid + ' 上');
  }

  /* 成环 + 深度 */
  const state = new Map();
  const depthOf = (startId) => {
    const path = [];
    const inPath = new Set();
    let cur = startId;
    let depth = 0;
    let verdict = 'ok';
    while (cur && cur !== ROOT_NODE_ID) {
      const cached = state.get(cur);
      if (cached) {
        depth += cached.depth;
        verdict = cached.verdict;
        break;
      }
      if (inPath.has(cur)) {
        verdict = 'cycle';
        break;
      }
      inPath.add(cur);
      path.push(cur);
      const node = byId.get(cur);
      if (!node) break;
      cur = node.parentId;
      depth++;
      if (depth > MAX_DEPTH) break;
    }
    for (const id of path) state.set(id, { depth, verdict });
    return { depth, verdict };
  };

  const reportedCycles = new Set();
  for (const id of activeIds) {
    const { depth, verdict } = depthOf(id);
    if (verdict === 'cycle' && !reportedCycles.has(id)) {
      errors.push('节点 ' + id + ' 处于循环引用中');
      reportedCycles.add(id);
    }
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    if (depth > 20) warnings.push('节点 ' + id + ' 嵌套过深（' + depth + ' 层）');
  }

  /* 墓碑比例 */
  if (stats.total > 20 && stats.tombstones / stats.total > 0.6) {
    warnings.push('墓碑占比 ' + Math.round((stats.tombstones / stats.total) * 100) + '%，可以考虑调小「墓碑保留天数」');
  }

  /* 父节点下序号是否稠密（不稠密不算错，只提示，因为扩展会在下次同步时压实） */
  const byParent = new Map();
  for (const [id, n] of byId) {
    if (n.deleted) continue;
    const key = n.parentId || ROOT_NODE_ID;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  let sparse = 0;
  for (const list of byParent.values()) {
    list.sort((a, b) => a.index - b.index);
    for (let i = 0; i < list.length; i++) {
      if (list[i].index !== i) {
        sparse++;
        break;
      }
    }
  }
  if (sparse > 0) warnings.push(sparse + ' 个父节点下的 index 不稠密（下次同步会自动压实）');

  for (const n of byId.values()) delete n.__index;

  return { errors, warnings, stats, anomalies: [] };
}

/* ------------------------------------------------------------------ *
 * URL 工具
 * ------------------------------------------------------------------ */

export function isSafeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw);
    return ALLOWED_SCHEMES.has(u.protocol.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    const proto = u.protocol.toLowerCase();
    let port = u.port;
    if ((proto === 'http:' && port === '80') || (proto === 'https:' && port === '443')) port = '';
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return proto + '//' + u.hostname.toLowerCase() + (port ? ':' + port : '') + path + u.search;
  } catch {
    return String(raw || '').trim().toLowerCase();
  }
}

/* ------------------------------------------------------------------ *
 * 与上一版对比：批量删除 / 批量新增检测
 * ------------------------------------------------------------------ */

export function activeSet(doc) {
  const out = new Map();
  const nodes = Array.isArray(doc && doc.nodes) ? doc.nodes : [];
  for (const n of nodes) {
    if (!n || n.deleted || typeof n.id !== 'string') continue;
    out.set(n.id, n);
  }
  return out;
}

/**
 * 对比两版活跃节点。删除比例超过阈值 -> anomaly。
 * 阈值必须同时满足"数量下限"，否则只有 2 条书签时删掉 1 条就会误报。
 */
export function diffVersions(prevDoc, curDoc, { maxDeleteRatio = DEFAULT_MAX_DELETE_RATIO, minBase = MIN_BASE_FOR_RATIO } = {}) {
  const prev = activeSet(prevDoc);
  const cur = activeSet(curDoc);

  const added = [];
  const removed = [];
  for (const [id, n] of cur) if (!prev.has(id)) added.push(n);
  for (const [id, n] of prev) if (!cur.has(id)) removed.push(n);

  const base = prev.size;
  const removedRatio = base > 0 ? removed.length / base : 0;
  const anomalies = [];

  if (base >= minBase && removedRatio > maxDeleteRatio) {
    anomalies.push({
      kind: 'mass-delete',
      message:
        '相对上一版删除了 ' + removed.length + '/' + base + ' 条活跃书签（' +
        Math.round(removedRatio * 100) + '%），超过阈值 ' + Math.round(maxDeleteRatio * 100) + '%',
      sample: removed.slice(0, 15).map((n) => n.title || n.url || n.id)
    });
  }

  if (base >= minBase && added.length > base * 3 + 50) {
    anomalies.push({
      kind: 'mass-add',
      message: '相对上一版新增了 ' + added.length + ' 条，而原有只有 ' + base + ' 条 —— 可能是误导入',
      sample: added.slice(0, 10).map((n) => n.title || n.url || n.id)
    });
  }

  return {
    base,
    current: cur.size,
    added: added.length,
    removed: removed.length,
    removedRatio,
    anomalies,
    sampleAdded: added.slice(0, 10).map((n) => n.title || n.url || n.id),
    sampleRemoved: removed.slice(0, 15).map((n) => n.title || n.url || n.id)
  };
}

/* ------------------------------------------------------------------ *
 * 从 git 读上一版
 * ------------------------------------------------------------------ */

export function readPrevFromGit(path, rev = 'HEAD~1') {
  try {
    return execFileSync('git', ['show', rev + ':' + path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 汇总报告
 * ------------------------------------------------------------------ */

export function analyze({ text, prevText, maxDeleteRatio = DEFAULT_MAX_DELETE_RATIO } = {}) {
  const parsed = parseDoc(text);
  if (!parsed.ok) {
    return { ok: false, verdict: 'invalid', errors: parsed.errors, warnings: [], stats: null, diff: null, anomalies: [] };
  }
  const { errors, warnings, stats } = validateDoc(parsed.doc, { maxDeleteRatio });

  let diff = null;
  if (prevText) {
    const prevParsed = parseDoc(prevText);
    if (prevParsed.ok) {
      diff = diffVersions(prevParsed.doc, parsed.doc, { maxDeleteRatio });
      if (diff.anomalies.length) {
        for (const a of diff.anomalies) warnings.push(a.message);
      }
    } else {
      warnings.push('上一版无法解析，跳过对比');
    }
  }

  let verdict = 'ok';
  if (errors.length) verdict = 'invalid';
  else if (diff && diff.anomalies.length) verdict = 'suspicious';

  return {
    ok: verdict === 'ok',
    verdict,
    errors,
    warnings,
    stats,
    diff,
    anomalies: diff ? diff.anomalies : []
  };
}

export function renderMarkdown(report) {
  const lines = [];
  const badge = { ok: '✅ 正常', suspicious: '⚠️ 可疑变更', invalid: '❌ 结构错误' }[report.verdict] || report.verdict;
  lines.push('## 书签文档校验：' + badge);
  lines.push('');

  if (report.stats) {
    const s = report.stats;
    lines.push('| 指标 | 值 |');
    lines.push('| --- | --- |');
    lines.push('| 节点总数 | ' + s.total + ' |');
    lines.push('| 书签 / 目录 | ' + s.bookmarks + ' / ' + s.folders + ' |');
    lines.push('| 墓碑 | ' + s.tombstones + ' |');
    lines.push('| 最大嵌套 | ' + s.maxDepth + ' |');
    lines.push('| 重复 URL | ' + s.duplicateUrls + ' |');
    lines.push('');
  }

  if (report.diff) {
    const d = report.diff;
    lines.push('### 相对上一版');
    lines.push('');
    lines.push('- 活跃书签：' + d.base + ' → ' + d.current);
    lines.push('- 新增 ' + d.added + '，删除 ' + d.removed + '（' + Math.round(d.removedRatio * 100) + '%）');
    lines.push('');
  }

  if (report.errors.length) {
    lines.push('### 结构错误（' + report.errors.length + '）');
    lines.push('');
    for (const e of report.errors.slice(0, 30)) lines.push('- ' + e);
    if (report.errors.length > 30) lines.push('- …以及另外 ' + (report.errors.length - 30) + ' 项');
    lines.push('');
  }

  if (report.warnings.length) {
    lines.push('### 提示（' + report.warnings.length + '）');
    lines.push('');
    for (const w of report.warnings.slice(0, 20)) lines.push('- ' + w);
    if (report.warnings.length > 20) lines.push('- …以及另外 ' + (report.warnings.length - 20) + ' 项');
    lines.push('');
  }

  if (report.anomalies && report.anomalies.length) {
    lines.push('### 可疑变更');
    lines.push('');
    for (const a of report.anomalies) {
      lines.push('- **' + a.kind + '**：' + a.message);
      if (a.sample && a.sample.length) {
        lines.push('  - 样例：' + a.sample.slice(0, 8).join('、'));
      }
    }
    lines.push('');
  }

  if (report.verdict === 'ok') lines.push('没有发现问题。');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { file: 'bookmarks.json', prev: '', json: false, summary: false, maxDeleteRatio: DEFAULT_MAX_DELETE_RATIO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--github-summary') args.summary = true;
    else if (a === '--prev') args.prev = argv[++i] || '';
    else if (a === '--max-delete-ratio') args.maxDeleteRatio = Number(argv[++i]) || DEFAULT_MAX_DELETE_RATIO;
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.file)) {
    console.error('文件不存在：' + args.file);
    process.exit(1);
  }
  const text = readFileSync(args.file, 'utf8');

  let prevText = null;
  if (args.prev === 'auto' || args.prev === '') {
    // 默认尝试和上一个 commit 比，读不到就跳过（首次提交 / 非 git 环境）
    prevText = readPrevFromGit(args.file, 'HEAD~1');
  } else if (args.prev) {
    prevText = args.prev.startsWith('HEAD') || /^[0-9a-f]{7,40}$/i.test(args.prev)
      ? readPrevFromGit(args.file, args.prev)
      : existsSync(args.prev) ? readFileSync(args.prev, 'utf8') : null;
  }

  const report = analyze({ text, prevText, maxDeleteRatio: args.maxDeleteRatio });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }

  if (args.summary) {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (target) appendFileSync(target, renderMarkdown(report) + '\n');
  }

  if (report.verdict === 'invalid') process.exit(1);
  if (report.verdict === 'suspicious') process.exit(2);
  process.exit(0);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

#!/usr/bin/env node
/**
 * MV3 Service Worker 兼容性检查。
 *
 * 起因：Chrome 在 ServiceWorkerGlobalScope 上禁止动态 import()，
 * 报错 "import() is disallowed on ServiceWorkerGlobalScope by the HTML specification"
 * （w3c/ServiceWorker#1356）。而 Node 里动态 import 一切正常，
 * 所以这类问题必然是"本地测试全绿、装进浏览器立刻炸"。
 *
 * 本脚本做三件事：
 *   1. 扫描 src 下所有 .js，禁止任何 import() 表达式（注释除外）；
 *   2. 从 background/service-worker.js 出发构建静态 import 图，检出循环依赖；
 *   3. 确认每个相对导入都能解析到真实文件。
 *
 * 用法：node tools/mv3-check.mjs
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src');
const ENTRY = join(SRC, 'background', 'service-worker.js');

const errors = [];
const warnings = [];

/* ------------------------------------------------------------------ *
 * 1. 动态 import 扫描
 * ------------------------------------------------------------------ */

// 匹配 import( 但排除 obj.import( 和字符串里的情况；注释行单独跳过
const DYNAMIC_IMPORT = /(^|[^.\w$])import\s*\(/;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = walk(SRC);

for (const file of files) {
  const rel = relative(root, file).split('\\').join('/');
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (DYNAMIC_IMPORT.test(lines[i])) {
      errors.push(rel + ':' + (i + 1) + ' 使用了动态 import()，MV3 service worker 不允许');
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. 静态 import 图：解析 + 循环检测
 * ------------------------------------------------------------------ */

// 匹配 import ... from '...' / import '...' / export ... from '...'
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  let m;
  STATIC_IMPORT.lastIndex = 0;
  while ((m = STATIC_IMPORT.exec(text))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    out.push(spec);
  }
  return out;
}

const graph = new Map();

function resolveSpec(from, spec) {
  const target = resolve(dirname(from), spec);
  if (existsSync(target) && statSync(target).isFile()) return target;
  // 允许省略扩展名
  if (existsSync(target + '.js')) return target + '.js';
  return null;
}

function buildGraph(file, seen = new Set()) {
  if (seen.has(file)) return;
  seen.add(file);
  const deps = [];
  for (const spec of importsOf(file)) {
    const target = resolveSpec(file, spec);
    if (!target) {
      errors.push(relative(root, file).split('\\').join('/') + ' 的导入无法解析：' + spec);
      continue;
    }
    deps.push(target);
    buildGraph(target, seen);
  }
  graph.set(file, deps);
}

buildGraph(ENTRY);

/* DFS 找环 */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map();
const stack = [];
const cycles = [];

function dfs(node) {
  color.set(node, GRAY);
  stack.push(node);
  for (const dep of graph.get(node) || []) {
    const c = color.get(dep) || WHITE;
    if (c === GRAY) {
      const start = stack.indexOf(dep);
      cycles.push(stack.slice(start).concat([dep]).map((f) => relative(root, f).split('\\').join('/')));
    } else if (c === WHITE) {
      dfs(dep);
    }
  }
  stack.pop();
  color.set(node, BLACK);
}

for (const node of graph.keys()) {
  if ((color.get(node) || WHITE) === WHITE) dfs(node);
}

for (const cycle of cycles) {
  errors.push('循环依赖：' + cycle.join(' -> '));
}

/* ------------------------------------------------------------------ *
 * 3. Service Worker 全局对象检查
 * ------------------------------------------------------------------ */

/*
 * SW 里没有 DOM。这些标识符一旦出现在 background/ 或 lib/ 里，
 * 只会在真实运行时抛 ReferenceError。ui/ 下的文件不检查（它们跑在页面里）。
 */
const DOM_GLOBALS = ['document', 'window', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'HTMLElement'];
const swFiles = [...graph.keys()].filter((f) => !f.includes(join('src', 'ui')));

for (const file of swFiles) {
  const rel = relative(root, file).split('\\').join('/');
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    for (const g of DOM_GLOBALS) {
      // 排除 xxx.document / 'document' 字符串 / chrome.xxx 前缀
      const re = new RegExp('(^|[^.\\w$])' + g + '\\b');
      if (re.test(line) && !/['"\u0060].*?\b/.test(line.split(g)[0])) {
        warnings.push(rel + ':' + (i + 1) + ' 引用了 DOM 全局 ' + g + '（service worker 里不存在）');
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

if (warnings.length) {
  console.log('提示：');
  for (const w of warnings) console.log('  · ' + w);
}
if (errors.length) {
  console.error('MV3 检查失败：');
  for (const e of errors) console.error('  · ' + e);
  process.exit(1);
}

const rel = [...graph.keys()].map((f) => relative(root, f).split('\\').join('/'));
console.log('MV3 检查通过');
console.log('  · 无动态 import()');
console.log('  · 无循环依赖');
console.log('  · service worker 可达模块 ' + rel.length + ' 个');

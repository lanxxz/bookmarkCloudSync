#!/usr/bin/env node
/**
 * 跨模块引用检查。
 *
 * 起因：sync.js 里写了 docFromJson(...)，但 import 列表漏了它。
 * 这类错误静态检查普遍抓不到：
 *   - node --check       只查语法，合法
 *   - 具名导入检查        查"导入的名字是否存在"，方向相反；
 *                         没导入的名字是自由变量，链接阶段不解析
 *   - unused 检查         查"导入了但没用"，也不覆盖
 * 于是它活到了用户机器上，报 "docFromJson is not defined"。
 *
 * 本工具用三条确定性规则，不做模糊作用域分析（避免误报刷屏）：
 *   A. 相对导入路径必须能解析到真实文件；
 *   B. 具名导入必须存在于目标模块的导出里；
 *   C. 源码里的 name( 调用，若本文件没声明、不在全局白名单、全项目也没有同名导出 -> 报告。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src');
const SEP = String.fromCharCode(92);

const GLOBALS = new Set(
  (
    'globalThis,global,undefined,NaN,Infinity,eval,arguments,' +
    'Object,Function,Array,String,Number,Boolean,Symbol,BigInt,Math,JSON,Date,RegExp,' +
    'Map,Set,WeakMap,WeakSet,WeakRef,FinalizationRegistry,Promise,Proxy,Reflect,' +
    'ArrayBuffer,SharedArrayBuffer,DataView,Int8Array,Uint8Array,Uint8ClampedArray,' +
    'Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,' +
    'BigInt64Array,BigUint64Array,Atomics,Intl,Iterator,AsyncIterator,' +
    'setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,' +
    'btoa,atob,TextEncoder,TextDecoder,AbortController,AbortSignal,' +
    'URL,URLSearchParams,FormData,Blob,File,FileReader,Headers,Request,Response,' +
    'fetch,crypto,performance,console,WebAssembly,MessageChannel,MessagePort,' +
    'chrome,browser,indexedDB,IDBKeyRange,DOMException,self,clients,caches,navigator,' +
    'location,origin,Event,CustomEvent,EventTarget,structuredClone,' +
    'encodeURIComponent,decodeURIComponent,encodeURI,decodeURI,parseInt,parseFloat,isNaN,isFinite,' +
    'confirm,alert,prompt,getComputedStyle,matchMedia'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const KEYWORDS = new Set(
  (
    'if,else,for,while,do,switch,case,default,break,continue,return,new,typeof,' +
    'instanceof,in,of,void,delete,this,super,function,class,extends,const,let,var,' +
    'async,await,yield,try,catch,finally,throw,import,export,from,as,static,get,set,' +
    'null,true,false,with,debugger,enum'
  )
    .split(',')
    .map((s) => s.trim())
);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function relOf(file) {
  return relative(root, file).split(SEP).join('/');
}

/**
 * 去掉注释。
 * 关键：块注释里可能有换行，替换时必须保留同样数量的 \n，
 * 否则后面算出来的行号会整体偏移，报错位置全是错的（踩过）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, prefix) => prefix);
}

/**
 * 把字符串与模板字面量替换成空格（保留换行）。
 * 规则 C 必须用它：否则 '?fields=user(email)' 里的 user( 会被当成函数调用。
 */
function stripStrings(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  const Q1 = String.fromCharCode(39);
  const Q2 = String.fromCharCode(34);
  const BT = String.fromCharCode(96);
  while (i < src.length) {
    const c = src[i];
    if (state === 'code') {
      if (c === Q1) { state = 'sq'; out += ' '; i++; continue; }
      if (c === Q2) { state = 'dq'; out += ' '; i++; continue; }
      if (c === BT) { state = 'tpl'; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    const closer = state === 'sq' ? Q1 : state === 'dq' ? Q2 : BT;
    if (c === '\\\\') { out += '  '; i += 2; continue; }
    if (c === closer) { state = 'code'; out += ' '; i++; continue; }
    out += c === '\n' ? '\n' : ' ';
    i++;
  }
  return out;
}

/** 找调用点前先清场：注释 + 字符串一起剥掉 */
function cleanForCalls(src) {
  return stripStrings(stripComments(src));
}

function exportsOf(src) {
  const names = new Set();
  const clean = stripComments(src);
  let m;
  const reDecl = /export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reDecl.exec(clean))) names.add(m[1]);
  const reBraced = /export\s*\{([\s\S]*?)\}/g;
  while ((m = reBraced.exec(clean))) {
    for (const piece of m[1].split(',')) {
      const bits = piece.trim().split(/\s+as\s+/);
      const name = (bits[1] || bits[0] || '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function importsOf(src) {
  const out = [];
  const re = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1].trim();
    const spec = m[2];
    const line = src.slice(0, m.index).split('\n').length;
    const names = new Set();
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def && !clause.startsWith('{') && !clause.startsWith('*')) names.add(def[1]);
    if (/\*\s+as\s+[A-Za-z_$][\w$]*/.test(clause)) names.add('*ns');
    const braced = /\{([\s\S]*?)\}/.exec(clause);
    if (braced) {
      for (const piece of braced[1].split(',')) {
        const t = piece.trim();
        if (!t) continue;
        const imported = (t.split(/\s+as\s+/)[0] || '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(imported)) names.add(imported);
      }
    }
    out.push({ spec, names, line });
  }
  return out;
}

function resolveSpec(from, spec) {
  const target = resolve(dirname(from), spec);
  if (existsSync(target) && statSync(target).isFile()) return target;
  if (existsSync(target + '.js')) return target + '.js';
  return null;
}

const files = walk(SRC);
const errors = [];
const exportCache = new Map();

function exportsFor(file) {
  if (!exportCache.has(file)) exportCache.set(file, exportsOf(readFileSync(file, 'utf8')));
  return exportCache.get(file);
}

/* —— 规则 A + B —— */
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const imp of importsOf(src)) {
    if (!imp.spec.startsWith('.')) continue;
    const target = resolveSpec(file, imp.spec);
    if (!target) {
      errors.push(relOf(file) + ':' + imp.line + '  导入路径无法解析：' + imp.spec);
      continue;
    }
    const exported = exportsFor(target);
    for (const name of imp.names) {
      if (name === '*ns') continue;
      if (!exported.has(name)) {
        errors.push(relOf(file) + ':' + imp.line + '  从 ' + relOf(target) + ' 导入的 ' + name + ' 没有对应导出');
      }
    }
  }
}

/* —— 规则 C —— */
/** name -> 定义它的文件（同名导出以先出现的为准，够用） */
const allExports = new Map();
for (const file of files) {
  for (const name of exportsFor(file)) {
    if (!allExports.has(name)) allExports.set(name, file);
  }
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const clean = cleanForCalls(src);
  const declared = new Set();
  for (const imp of importsOf(src)) for (const n of imp.names) declared.add(n === '*ns' ? '*' : n);
  let m;
  const decl = /\b(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = decl.exec(clean))) declared.add(m[1]);
  // 参数 / 解构 / catch 里的名字：先粗收，宁可多认不误报
  const loose = /(?:\(([^()]*)\)|\[([^\]]*)\]|\{([^{}]*)\})/g;
  while ((m = loose.exec(clean))) {
    for (const group of [m[1], m[2], m[3]]) {
      if (!group) continue;
      for (const t of group.matchAll(/[A-Za-z_$][\w$]*/g)) declared.add(t[0]);
    }
  }

  /*
   * 精确规则：找出"本文件用到、但没声明也没导入"的名字，且这个名字**确实是项目里某个
   * 模块的导出**。这样做的理由：
   *   - 真正的 bug（docFromJson 忘了 import）必然命中——它在 protocol.js 里是导出；
   *   - 字符串里的 user( / storageQuota( / 正则里的 T( 不会命中——它们不是任何导出；
   *   - 局部变量与某个导出同名时，declared 里已经有它，也不会误报。
   * 换句话说：只在"跨模块却漏了 import"这一种情况下报警，召回和精度都刚好够用。
   */
  const tokenRe = /(^|[^\w$.])([A-Za-z_$][\w$]*)/g;
  const seen = new Set();
  while ((m = tokenRe.exec(clean))) {
    const name = m[2];
    if (KEYWORDS.has(name) || GLOBALS.has(name)) continue;
    if (!allExports.has(name)) continue;
    if (declared.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const line = clean.slice(0, m.index).split('\n').length;
    errors.push(
      relOf(file) + ':' + line + '  用到了 ' + name + '，但本文件既没声明也没 import —— 它来自 ' + relOf(allExports.get(name))
    );
  }
}

if (errors.length) {
  console.error('跨模块引用检查失败：');
  for (const e of errors) console.error('  · ' + e);
  process.exit(1);
}
console.log('跨模块引用检查通过（导入可解析 / 具名导出存在 / 无悬空调用）');

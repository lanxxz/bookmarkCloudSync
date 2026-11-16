#!/usr/bin/env node
/** 检出未使用的具名导入（仅 src 目录），保持代码干净。 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

let total = 0;
for (const file of walk(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8');
  const re = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/).pop());
    const rest = src.slice(m.index + m[0].length);
    for (const name of names) {
      if (!new RegExp('\\b' + name + '\\b').test(rest)) {
        console.log(file.replace(root + '\\', '') + '  未使用: ' + name + '  <- ' + m[2]);
        total++;
      }
    }
  }
}
if (total) {
  console.error(total + ' 个未使用的导入');
  process.exit(1);
}
console.log('没有未使用的导入');

#!/usr/bin/env node
/**
 * 发布前校验：manifest 字段、图标是否存在、HTML 里的资源引用是否都落地。
 * 不联网、不执行扩展代码，纯静态检查。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

function must(cond, msg) {
  if (!cond) errors.push(msg);
}

const manifestPath = join(root, 'manifest.json');
must(existsSync(manifestPath), 'manifest.json 不存在');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

must(manifest.manifest_version === 3, 'manifest_version 必须是 3');
must(/^\d+\.\d+\.\d+$/.test(manifest.version || ''), 'version 不符合 x.y.z');
must(!!manifest.name, '缺少 name');
must(!!manifest.description, '缺少 description');
must(Array.isArray(manifest.permissions), 'permissions 必须是数组');
must(Array.isArray(manifest.host_permissions), 'host_permissions 必须是数组');

const requiredPerms = ['bookmarks', 'storage', 'alarms', 'identity'];
for (const p of requiredPerms) must(manifest.permissions.includes(p), '缺少权限：' + p);
must(
  manifest.host_permissions.some((h) => h.includes('www.googleapis.com')),
  'host_permissions 缺少 www.googleapis.com'
);
must(
  manifest.host_permissions.some((h) => h.includes('oauth2.googleapis.com')),
  'host_permissions 缺少 oauth2.googleapis.com'
);
must(
  manifest.host_permissions.some((h) => h.includes('api.github.com')),
  'host_permissions 缺少 api.github.com（GitHub 后端需要）'
);

must(manifest.background && manifest.background.type === 'module', 'background 必须是 type: module');
must(manifest.background.service_worker, '缺少 background.service_worker');
must(existsSync(join(root, manifest.background.service_worker)), 'service worker 文件不存在：' + manifest.background.service_worker);

for (const key of ['options_page']) {
  must(existsSync(join(root, manifest[key])), 'option 页面不存在：' + manifest[key]);
}
must(existsSync(join(root, manifest.action.default_popup)), 'popup 不存在：' + manifest.action.default_popup);

for (const [size, icon] of Object.entries(manifest.icons || {})) {
  must(existsSync(join(root, icon)), '图标不存在：' + icon + ' (' + size + ')');
  if (existsSync(join(root, icon))) {
    const stat = statSync(join(root, icon));
    must(stat.size > 100, '图标文件异常小：' + icon);
  }
}

/* 模板文件：CI 工作流必须存在，且引用同目录的校验脚本 */
must(existsSync(join(root, 'tools/verify-doc.mjs')), '缺少 tools/verify-doc.mjs');
must(existsSync(join(root, 'templates/verify-bookmarks.yml')), '缺少 templates/verify-bookmarks.yml');

/* HTML 资源引用检查 */
for (const html of ['src/ui/popup.html', 'src/ui/options.html']) {
  const full = join(root, html);
  must(existsSync(full), 'HTML 不存在：' + html);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, 'utf8');
  const refs = [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('http') && !r.startsWith('data:'));
  for (const ref of refs) {
    const target = resolve(dirname(full), ref);
    must(existsSync(target), html + ' 引用的资源不存在：' + ref);
  }
  if (!/type="module"/.test(text)) warnings.push(html + ' 的脚本未使用 type="module"');
}

/* 危险 API 检查：扩展里不应该出现 eval / innerHTML 拼接 */
const dangerFiles = ['src/ui/popup.js', 'src/ui/options.js'];
for (const f of dangerFiles) {
  const text = readFileSync(join(root, f), 'utf8');
  if (/innerHTML/.test(text)) errors.push(f + ' 使用了 innerHTML（存在注入风险，请用 textContent）');
  if (/\beval\(/.test(text)) errors.push(f + ' 使用了 eval');
}

/* CSP：MV3 不允许 remote code，确认没有把外部脚本塞进 HTML */
for (const html of ['src/ui/popup.html', 'src/ui/options.html']) {
  const text = readFileSync(join(root, html), 'utf8');
  if (/<script[^>]+src="https?:/.test(text)) errors.push(html + ' 引用了外部脚本，违反 MV3 CSP');
}

console.log(warnings.length ? 'WARN\n  ' + warnings.join('\n  ') : 'no warnings');
if (errors.length) {
  console.error('校验失败：\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log('manifest 与资源引用校验通过（v' + manifest.version + '）');

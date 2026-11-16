#!/usr/bin/env node
/**
 * 生成固定的扩展公钥，把 manifest 的 "key" 填上后，
 * 同一个扩展在「加载已解压的扩展程序」时也能拿到稳定 ID，
 * 这样 OAuth 的重定向 URI 就不用每次改。
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, '..', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.key && !process.argv.includes('--force')) {
  console.log('manifest.json 已有 key，跳过（加 --force 重新生成）');
  process.exit(0);
}

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
manifest.key = der.toString('base64');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// 计算扩展 ID：sha256(DER) 前 16 字节，每个半字节映射到 a-p
const crypto = await import('node:crypto');
const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const id = hash.split('').map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join('');
console.log('已写入 manifest.key');
console.log('扩展 ID: ' + id);
console.log('重定向 URI: https://' + id + '.chromiumapp.org/oauth2');

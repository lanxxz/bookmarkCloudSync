#!/usr/bin/env node
/**
 * 生成扩展图标（16/32/48/128 PNG），不依赖任何图形库：
 * 手写 PNG 编码（zlib deflate + CRC32），画一个圆角方块 + 白色书签形状。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'icons');
mkdirSync(outDir, { recursive: true });

const SIZES = [16, 32, 48, 128];

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 画图 ---------- */

function mix(a, b, t) {
  return a + (b - a) * t;
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = size / 128;
  const radius = 26 * scale;
  const bookmarkW = 40 * scale;
  const bookmarkH = 58 * scale;
  const bx = (size - bookmarkW) / 2;
  const by = (size - bookmarkH) / 2 - 4 * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // 背景：垂直渐变蓝 + 圆角
      const t = y / Math.max(1, size - 1);
      let r = mix(26, 66, t);
      let g = mix(115, 165, t);
      let b = mix(232, 255, t);

      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      let alpha = 255;
      const rr = radius;
      if (dx < rr && dy < rr) {
        const cx = rr - dx;
        const cy = rr - dy;
        const dist = Math.sqrt(cx * cx + cy * cy);
        if (dist > rr) {
          const edge = dist - rr;
          alpha = Math.max(0, Math.round(255 * (1 - edge)));
        }
      }

      // 书签形状：矩形 + 底部 V 形缺口
      const inX = x >= bx && x < bx + bookmarkW;
      const inY = y >= by && y < by + bookmarkH;
      if (inX && inY) {
        const u = (x - bx) / bookmarkW;
        const v = (y - by) / bookmarkH;
        const notchTop = 0.72;
        let inside = true;
        if (v > notchTop) {
          const k = (v - notchTop) / (1 - notchTop);
          const halfGap = Math.abs(u - 0.5) * 2;
          inside = halfGap > k;
        }
        if (inside) {
          r = 255;
          g = 255;
          b = 255;
        }
      }

      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = alpha;
    }
  }
  return encodePng(size, size, px);
}

for (const size of SIZES) {
  const file = resolve(outDir, 'icon' + size + '.png');
  writeFileSync(file, drawIcon(size));
  console.log('wrote ' + file);
}
console.log('icons 生成完成');

#!/usr/bin/env node
/**
 * 生成 512x512 应用图标（RGBA PNG），零依赖。
 * 设计：深色圆角底 + 三条蓝色横杠 + 右下绿点，和 assets/icon.svg 一致。
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const S = 512;
const buf = Buffer.alloc(S * S * 4, 0);

function put(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // 简单 alpha 混合
  const sa = a / 255;
  buf[i] = Math.round(buf[i] * (1 - sa) + r * sa);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - sa) + g * sa);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - sa) + b * sa);
  buf[i + 3] = Math.max(buf[i + 3], a);
}

/** 圆角矩形，带 1px 抗锯齿 */
function roundRect(x0, y0, w, h, radius, color, alpha = 255) {
  const [r, g, b] = color;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.min(Math.max(x - (x0 + radius), 0), Math.max(w - radius * 2, 0)) + (x < x0 + radius ? x0 + radius - x : 0);
      const dy = Math.min(Math.max(y - (y0 + radius), 0), Math.max(h - radius * 2, 0)) + (y < y0 + radius ? y0 + radius - y : 0);
      const cx = Math.abs(x - (x0 + w / 2)) - (w / 2 - radius);
      const cy = Math.abs(y - (y0 + h / 2)) - (h / 2 - radius);
      const inside = cx <= 0 && cy <= 0;
      const dist = inside ? 0 : Math.hypot(Math.max(cx, 0), Math.max(cy, 0));
      if (dist <= radius - 1) put(x, y, r, g, b, alpha);
      else if (dist <= radius) put(x, y, r, g, b, Math.round(alpha * (radius - dist)));
    }
  }
}

function circle(cx, cy, radius, color, alpha = 255) {
  const [r, g, b] = color;
  for (let y = cy - radius - 2; y <= cy + radius + 2; y++) {
    for (let x = cx - radius - 2; x <= cx + radius + 2; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius - 1) put(x, y, r, g, b, alpha);
      else if (d <= radius) put(x, y, r, g, b, Math.round(alpha * (radius - d)));
    }
  }
}

// 底色
roundRect(0, 0, S, S, 112, [193, 95, 60]);
// 三条横杠
roundRect(104, 132, 304, 44, 22, [247, 244, 238]);
roundRect(104, 212, 212, 44, 22, [247, 244, 238], 170);
roundRect(104, 292, 264, 44, 22, [247, 244, 238], 112);
// 绿点
circle(392, 314, 34, [107, 138, 99]);

/* ---------- PNG 编码 ---------- */

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "assets", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log("已生成", out, (png.length / 1024).toFixed(1), "KB");

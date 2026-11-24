// アイコン（PNG）を作る。依存パッケージなしで、塗りつぶしの四角だけを描く。
//   node scripts/make-icons.mjs
// 図柄: 暗い背景に、Claude（橙）と Codex（青）の縦棒、待ちを表す黄色の線。
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [0x0d, 0x11, 0x17];
const RECTS = [
  // [x0, y0, x1, y1]（0〜1 の割合）, 色
  [[0.22, 0.30, 0.46, 0.78], [0xdb, 0x6d, 0x28]],
  [[0.54, 0.30, 0.78, 0.78], [0x44, 0x93, 0xf8]],
  [[0.22, 0.20, 0.78, 0.24], [0xd2, 0x99, 0x22]],
];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let col = BG;
      for (const [[x0, y0, x1, y1], c] of RECTS) {
        if (x >= x0 * size && x < x1 * size && y >= y0 * size && y < y1 * size) col = c;
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../public/', import.meta.url);
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(new URL(name, out), png(size));
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0d1117"/>${RECTS.map(
  ([[x0, y0, x1, y1], c]) => `<rect x="${x0 * 100}" y="${y0 * 100}" width="${(x1 - x0) * 100}" height="${(y1 - y0) * 100}" fill="rgb(${c.join(',')})"/>`,
).join('')}</svg>\n`;
fs.writeFileSync(new URL('icon.svg', out), svg);
console.log('icons written');

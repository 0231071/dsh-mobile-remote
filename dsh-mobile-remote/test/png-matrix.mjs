/**
 * 最小 PNG 读取 + QR 模块矩阵还原（仅用于验证）。
 *
 * 不从 lib/qr.js 拿任何信息：自己解析 PNG（IHDR/IDAT/IEND、反 filter），
 * 再用标准定位图形几何反推「模块边长 / 原点 / 模块数」，最后按模块中心采样。
 * 这样「二维码图上到底印了什么」是被真正读出来的，而不是相信编码器的自述。
 */

import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 解析 8 位灰度 PNG。
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, dark: (x: number, y: number) => boolean }}
 */
export function readGrayscalePng(buffer) {
  assert.ok(buffer.length > 8, 'PNG 太短');
  for (let i = 0; i < 8; i++) assert.equal(buffer[i], PNG_MAGIC[i], 'PNG magic 不符');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  assert.equal(bitDepth, 8, `只支持 8 位深，实际 ${bitDepth}`);
  assert.equal(colorType, 0, `只支持灰度，实际 colorType ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width + 1; // 每行 1 字节 filter
  assert.equal(raw.length, stride * height, '解压后的扫描线长度不符');

  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const line = raw.subarray(y * stride + 1, y * stride + 1 + width);
    const prev = y > 0 ? pixels.subarray((y - 1) * width, y * width) : null;
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? pixels[y * width + x - 1] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x > 0 ? prev[x - 1] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else {
        assert.equal(filter, 0, `未知 filter ${filter}`);
      }
      pixels[y * width + x] = value & 0xff;
    }
  }

  return { width, height, dark: (x, y) => pixels[y * width + x] < 128 };
}

/**
 * 从灰度 PNG 还原 QR 模块矩阵。
 *
 * 几何：定位图形恰好占 7×7 个模块，所以「最上面那条含黑像素的行」里从首个黑像素
 * 开始的连续黑像素数 = 7 × 模块边长；该点也就是模块 (0,0) 的左上角。于是
 * 模块数 = (边长像素 − 2 × 原点偏移) / 模块边长。
 *
 * @param {Buffer} buffer
 * @returns {{ version: number, size: number, modules: number[][], scale: number, margin: number }}
 */
export function matrixFromPng(buffer) {
  const image = readGrayscalePng(buffer);

  let top = -1;
  let left = -1;
  for (let y = 0; y < image.height && top < 0; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.dark(x, y)) { top = y; left = x; break; }
    }
  }
  assert.ok(top >= 0, '图里找不到任何黑像素');

  let run = 0;
  while (left + run < image.width && image.dark(left + run, top)) run++;
  assert.equal(run % 7, 0, `定位图形上边缘像素数 ${run} 不是 7 的倍数`);
  const scale = run / 7;

  const size = (image.width - 2 * left) / scale;
  assert.ok(Number.isInteger(size), `模块数不是整数：(${image.width} − 2×${left}) / ${scale}`);
  assert.equal((image.height - 2 * top), size * scale, '高度方向几何不自洽');

  const modules = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      row.push(image.dark(left + c * scale + (scale >> 1), top + r * scale + (scale >> 1)) ? 1 : 0);
    }
    modules.push(row);
  }

  return { version: (size - 17) / 4, size, modules, scale, margin: left / scale };
}

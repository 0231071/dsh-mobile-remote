/**
 * 独立编写的 QR 解码器（仅用于验证，不属于运行时）。
 *
 * 与 lib/qr.js 的编码器完全分开实现：按格式信息定位掩码 → 反掩码 → 之字形读位
 * → 反交织 → 逐块算 Reed-Solomon 伴随式（必须全零）→ 还原字节。伴随式为零同时
 * 证明了 RS 生成、分块切分、交织顺序、掩码与铺位全部正确。
 */

import assert from 'node:assert/strict';

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 伴随式：码字按降幂求值于 α^0..α^(ecLen-1)，全零 = 合法码字。 */
export function syndromes(codeword, ecLen) {
  const out = [];
  for (let i = 0; i < ecLen; i++) {
    let acc = 0;
    for (const c of codeword) acc = mul(acc, EXP[i]) ^ c;
    out.push(acc);
  }
  return out;
}

export const ECL_FROM_BITS = { 1: 'L', 0: 'M' };

export const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

export const EC_TABLE = {
  L: { 1: [7, 1], 2: [10, 1], 3: [15, 1], 4: [20, 1], 5: [26, 1], 6: [18, 2], 7: [20, 2], 8: [24, 2], 9: [30, 2], 10: [18, 2] },
  M: { 1: [10, 1], 2: [16, 1], 3: [26, 1], 4: [18, 2], 5: [24, 2], 6: [16, 4], 7: [18, 4], 8: [22, 4], 9: [22, 5], 10: [26, 5] },
};

/** 重建「功能模块」地图（解码端独立重画，不改用编码器内部状态）。 */
export function functionMap(version) {
  const size = version * 4 + 17;
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  const mark = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && r < size && c >= 0 && c < size) fn[r][c] = 1;
  };
  mark(0, 0, 8, 8);
  mark(0, size - 8, 8, 8);
  mark(size - 8, 0, 8, 8);
  for (let i = 0; i < size; i++) { fn[6][i] = 1; fn[i][6] = 1; }
  for (const r of ALIGNMENT[version]) {
    for (const c of ALIGNMENT[version]) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      mark(r - 2, c - 2, 5, 5);
    }
  }
  for (let i = 0; i < 9; i++) { fn[8][i] = 1; fn[i][8] = 1; }
  for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = 1; fn[size - 1 - i][8] = 1; }
  if (version >= 7) {
    // 版本信息两块各 18 位：左上角那块是 6 列 × 3 行（宽 6 高 3），右上角那块是 6 行 × 3 列。
    mark(0, size - 11, 6, 3);
    mark(size - 11, 0, 3, 6);
  }
  return fn;
}

export function maskBit(mask, i, j) {
  switch (mask) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
    default: throw new Error(`bad mask ${mask}`);
  }
}

/** 校验 15 位格式信息是否为合法 BCH(15,5) 码字（生成多项式 0x537）。 */
export function isFormatCodeword(bits) {
  let rem = bits;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return rem === 0;
}

function readFormatCopies(matrix) {
  const { size, modules } = matrix;
  let a = 0;
  for (let i = 0; i < 15; i++) {
    const bit = i < 6 ? modules[i][8] : i < 8 ? modules[i + 1][8] : modules[size - 15 + i][8];
    if (bit) a |= 1 << i;
  }
  let b = 0;
  for (let i = 0; i < 15; i++) {
    const bit = i < 8 ? modules[8][size - i - 1] : i < 9 ? modules[8][15 - i] : modules[8][14 - i];
    if (bit) b |= 1 << i;
  }
  return { a, b };
}

/**
 * 从模块矩阵解出文本。
 * @param {{ version: number, size: number, modules: (Int8Array|number[])[] }} matrix
 * @returns {{ text: string, version: number, ecLevel: string, mask: number, blockCount: number }}
 */
export function decodeMatrix(matrix) {
  const { version, size, modules } = matrix;
  const { a, b } = readFormatCopies(matrix);
  assert.equal(a, b, '两份格式信息副本必须一致');
  const unmasked = a ^ 0x5412;
  assert.ok(isFormatCodeword(unmasked), `格式信息 ${unmasked.toString(2)} 不是合法 BCH(15,5) 码字`);
  const data = unmasked >> 10;
  const ecLevel = ECL_FROM_BITS[(data >> 3) & 0b11];
  const mask = data & 0b111;
  assert.ok(ecLevel, `未知纠错等级指示位 ${(data >> 3) & 3}`);

  const fn = functionMap(version);
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (fn[row][cc]) continue;
        let value = modules[row][cc];
        if (maskBit(mask, row, cc)) value ^= 1;
        bits.push(value);
      }
    }
    upward = !upward;
  }

  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  const [ecPerBlock, blockCount] = EC_TABLE[ecLevel][version];
  const totalData = codewords.length - ecPerBlock * blockCount;
  const shortLen = Math.floor(totalData / blockCount);
  const longCount = totalData % blockCount;
  const shortCount = blockCount - longCount;
  const lengths = [];
  for (let i = 0; i < shortCount; i++) lengths.push(shortLen);
  for (let i = 0; i < longCount; i++) lengths.push(shortLen + 1);

  const blocks = lengths.map(() => []);
  const maxLen = shortLen + (longCount > 0 ? 1 : 0);
  let p = 0;
  for (let i = 0; i < maxLen; i++) {
    for (let bIdx = 0; bIdx < blockCount; bIdx++) {
      if (i < lengths[bIdx]) blocks[bIdx].push(codewords[p++]);
    }
  }
  const ecBlocks = lengths.map(() => []);
  for (let i = 0; i < ecPerBlock; i++) {
    for (let bIdx = 0; bIdx < blockCount; bIdx++) ecBlocks[bIdx].push(codewords[p++]);
  }

  for (let bIdx = 0; bIdx < blockCount; bIdx++) {
    const syn = syndromes([...blocks[bIdx], ...ecBlocks[bIdx]], ecPerBlock);
    assert.ok(
      syn.every((s) => s === 0),
      `块 ${bIdx} 的 Reed-Solomon 伴随式非零：${syn.join(',')}（RS 生成/分块/交织有误）`,
    );
  }

  const stream = [];
  for (const block of blocks) {
    for (const byte of block) for (let j = 7; j >= 0; j--) stream.push((byte >> j) & 1);
  }
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | stream.shift();
    return v;
  };
  const mode = take(4);
  assert.equal(mode, 0b0100, '必须为字节模式');
  const count = take(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(take(8));
  return { text: new TextDecoder().decode(Uint8Array.from(bytes)), version, ecLevel, mask, blockCount };
}

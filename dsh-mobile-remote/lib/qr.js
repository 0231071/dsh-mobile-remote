/**
 * 自含 QR 码编码器（字节模式，版本 1–10，纠错等级 L/M）+ 最小 PNG 写出。
 *
 * 为什么自己写：插件要能在完全离线、无 npm 依赖的宿主里出二维码；DSH 宿主不构建
 * 第三方资源，任何运行期 import 都可能解析失败。本文件只依赖 node:zlib。
 *
 * 实现范围与依据（ISO/IEC 18004）：
 *  - 模式：byte（0100）。URL 是 ASCII，且 trycloudflare 域名含 '-'，字节模式最稳。
 *  - 版本：1–10（v10-M 容量 214 字节，足够容纳 token URL）。
 *  - 纠错：每版本每等级「每块纠错码字数 + 块数」表；数据码字由总码字数反推，
 *    长短块切分用 spec 关系 group2 = totalData mod numBlocks（非查表，避免手抄错表）。
 *  - 掩码：8 种全试，按 4 条罚分规则选最优。
 */

import { deflateSync } from 'node:zlib';

// ── 版本表 ────────────────────────────────────────────────────────────────────

/** 每版本总码字数（数据 + 纠错），索引 v-1。 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** EC_TABLE[等级][版本] = [每块纠错码字数, 块数]。 */
const EC_TABLE = {
  L: {
    1: [7, 1], 2: [10, 1], 3: [15, 1], 4: [20, 1], 5: [26, 1],
    6: [18, 2], 7: [20, 2], 8: [24, 2], 9: [30, 2], 10: [18, 2],
  },
  M: {
    1: [10, 1], 2: [16, 1], 3: [26, 1], 4: [18, 2], 5: [24, 2],
    6: [16, 4], 7: [18, 4], 8: [22, 4], 9: [22, 5], 10: [26, 5],
  },
};

/** 校正图形中心坐标（版本 ≥ 2）。 */
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** 格式信息里的纠错等级指示位（L=01, M=00, Q=11, H=10）。 */
const ECL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const MAX_VERSION = 10;

// ── GF(256) 运算 ─────────────────────────────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // 本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 prod_{i<degree} (x - α^i)，系数按降幂排列，首项为 1。 */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 对一个数据块求 degree 个纠错码字。 */
function rsEncode(data, degree) {
  const gen = rsGeneratorPoly(degree);
  const buf = new Uint8Array(data.length + degree);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
  }
  return buf.slice(data.length);
}

// ── 容量、编码、分块交织 ─────────────────────────────────────────────────────

function ecInfo(version, ecl) {
  const row = EC_TABLE[ecl][version];
  if (row === undefined) throw new Error(`dsh-mobile-remote/qr: 不支持的纠错等级 ${ecl}`);
  return { ecPerBlock: row[0], blocks: row[1] };
}

/** 该版本该等级的数据码字数。 */
function dataCodewords(version, ecl) {
  const { ecPerBlock, blocks } = ecInfo(version, ecl);
  return TOTAL_CODEWORDS[version - 1] - ecPerBlock * blocks;
}

/** 字节模式在给定版本下的字符数指示位宽。 */
function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

/** 选能容纳该字节长度的最小版本；超容量返回 null。 */
function pickVersion(byteLength, ecl) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const capacityBits = dataCodewords(v, ecl) * 8;
    if (4 + charCountBits(v) + byteLength * 8 <= capacityBits) return v;
  }
  return null;
}

/** 位流：模式指示 + 字符计数 + 数据 + 终止符 + 补齐到码字边界 + 填充码字。 */
function buildDataCodewords(bytes, version, ecl) {
  const total = dataCodewords(version, ecl);
  const capacityBits = total * 8;
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);

  // 终止符最多 4 位，且不得越过容量
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  const PAD = [0xec, 0x11];
  let k = 0;
  while (out.length < total) out.push(PAD[k++ % 2]);
  return out;
}

/** 按 spec 切分长短块、逐块纠错、再交织成最终码字序列。 */
function interleave(codewords, version, ecl) {
  const { ecPerBlock, blocks: blockCount } = ecInfo(version, ecl);
  const totalData = codewords.length;
  const shortLen = Math.floor(totalData / blockCount);
  const longCount = totalData % blockCount;
  const shortCount = blockCount - longCount;

  const dataBlocks = [];
  let offset = 0;
  for (let i = 0; i < shortCount; i++) {
    dataBlocks.push(codewords.slice(offset, offset + shortLen));
    offset += shortLen;
  }
  for (let i = 0; i < longCount; i++) {
    dataBlocks.push(codewords.slice(offset, offset + shortLen + 1));
    offset += shortLen + 1;
  }

  const ecBlocks = dataBlocks.map((b) => rsEncode(Uint8Array.from(b), ecPerBlock));

  const out = [];
  const maxDataLen = shortLen + (longCount > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

// ── 矩阵构造 ─────────────────────────────────────────────────────────────────

/** 底层矩阵：modules 存 0/1（-1 = 尚未写入），isFunction 标记功能图形。 */
function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = [];
  const isFunction = [];
  for (let i = 0; i < size; i++) {
    modules.push(new Int8Array(size).fill(-1));
    isFunction.push(new Uint8Array(size));
  }
  return { version, size, modules, isFunction };
}

function setModule(m, row, col, dark, fn = true) {
  m.modules[row][col] = dark ? 1 : 0;
  if (fn) m.isFunction[row][col] = 1;
}

function drawFinder(m, row0, col0) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = row0 + dr;
      const c = col0 + dc;
      if (r < 0 || r >= m.size || c < 0 || c >= m.size) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      setModule(m, r, c, dark);
    }
  }
}

function drawAlignment(m, row0, col0) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      setModule(m, row0 + dr, col0 + dc, ring !== 1);
    }
  }
}

function formatInfoBits(ecl, mask) {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((version << 12) | rem) & 0x3ffff;
}

/** 画功能图形（定位/校正/定时/暗模块/格式与版本信息占位）。 */
function drawFunctionPatterns(m, ecl) {
  const { size } = m;

  drawFinder(m, 0, 0);
  drawFinder(m, 0, size - 7);
  drawFinder(m, size - 7, 0);

  // 定时图形（第 6 行 / 第 6 列），起点自 (6,8) 起交替，避免覆盖定位图形
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(m, 6, i, dark);
    setModule(m, i, 6, dark);
  }

  // 校正图形
  const positions = ALIGNMENT[m.version];
  for (const r of positions) {
    for (const c of positions) {
      const overlapsFinder =
        (r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6);
      if (overlapsFinder) continue;
      drawAlignment(m, r, c);
    }
  }

  // 暗模块
  setModule(m, size - 8, 8, true);

  // 预留格式信息位（先写 0，稍后按掩码重写）
  const reserveFormat = formatInfoBits(ecl, 0);
  for (let i = 0; i < 15; i++) {
    const bit = (reserveFormat >> i) & 1;
    if (i < 6) setModule(m, i, 8, bit);
    else if (i < 8) setModule(m, i + 1, 8, bit);
    else setModule(m, size - 15 + i, 8, bit);
    if (i < 8) setModule(m, 8, size - i - 1, bit);
    else if (i < 9) setModule(m, 8, 15 - i, bit);
    else setModule(m, 8, 14 - i, bit);
  }

  // 版本信息（版本 ≥ 7）
  if (m.version >= 7) {
    const bits = versionInfoBits(m.version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const a = Math.floor(i / 3);
      const b = i % 3;
      setModule(m, size - 11 + b, a, bit);
      setModule(m, a, size - 11 + b, bit);
    }
  }
}

/** 把交织后的码字按之字形铺进非功能模块（未掩码）。 */
function placeData(m, codewords) {
  const { size } = m;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // 跳过定时列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (m.isFunction[row][cc]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
        }
        m.modules[row][cc] = bit;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

// ── 掩码 ─────────────────────────────────────────────────────────────────────

function maskFn(mask, i, j) {
  switch (mask) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
    default: throw new Error(`dsh-mobile-remote/qr: 非法掩码 ${mask}`);
  }
}

/** 返回施加掩码后的模块副本（功能图形不动）。 */
function applyMask(m, mask) {
  const size = m.size;
  const out = [];
  for (let i = 0; i < size; i++) {
    const row = new Int8Array(size);
    for (let j = 0; j < size; j++) {
      const value = m.modules[i][j];
      row[j] = !m.isFunction[i][j] && maskFn(mask, i, j) ? (value ^ 1) : value;
    }
    out.push(row);
  }
  return out;
}

function writeFormatInfo(modules, size, ecl, mask) {
  const bits = formatInfoBits(ecl, mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    if (i < 6) modules[i][8] = bit;
    else if (i < 8) modules[i + 1][8] = bit;
    else modules[size - 15 + i][8] = bit;
    if (i < 8) modules[8][size - i - 1] = bit;
    else if (i < 9) modules[8][15 - i] = bit;
    else modules[8][14 - i] = bit;
  }
}

/** 罚分规则 1：行/列同色连续段。 */
function penaltyRuns(modules, size) {
  let score = 0;
  const scan = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let prev = get(a, 0);
      for (let b = 1; b < size; b++) {
        const cur = get(a, b);
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          prev = cur;
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  scan((a, b) => modules[a][b]); // 行
  scan((a, b) => modules[b][a]); // 列
  return score;
}

/** 罚分规则 2：2×2 同色块。 */
function penaltyBlocks(modules, size) {
  let score = 0;
  for (let i = 0; i < size - 1; i++) {
    for (let j = 0; j < size - 1; j++) {
      const v = modules[i][j];
      if (v === modules[i][j + 1] && v === modules[i + 1][j] && v === modules[i + 1][j + 1]) score += 3;
    }
  }
  return score;
}

/** 罚分规则 3：出现 1011101 且两侧各留 4 个空白的类定位图形。 */
function penaltyFinderLike(modules, size) {
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, a, b) => {
    let okA = true;
    let okB = true;
    for (let k = 0; k < 11; k++) {
      const v = get(a, b + k);
      if (v !== A[k]) okA = false;
      if (v !== B[k]) okB = false;
      if (!okA && !okB) return false;
    }
    return true;
  };
  let score = 0;
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      if (matches((x, y) => modules[x][y], a, b)) score += 40;
      if (matches((x, y) => modules[y][x], a, b)) score += 40;
    }
  }
  return score;
}

/** 罚分规则 4：暗模块占比偏离 50%。 */
function penaltyBalance(modules, size) {
  let dark = 0;
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) if (modules[i][j]) dark++;
  const total = size * size;
  const percent = (dark * 100) / total;
  const deviation = Math.abs(percent - 50);
  return Math.floor(deviation / 5) * 10;
}

// ── 公开入口 ─────────────────────────────────────────────────────────────────

/**
 * 把文本编码为 QR 模块矩阵。
 * @param {string} text 待编码文本（按 UTF-8 字节模式）。
 * @param {{ ecLevel?: 'L'|'M' }} [options] 纠错等级，默认 M。
 * @returns {{ version: number, size: number, ecLevel: string, modules: Int8Array[] }}
 */
export function encodeMatrix(text, options = {}) {
  const ecLevel = options.ecLevel ?? 'M';
  if (ecLevel !== 'L' && ecLevel !== 'M') {
    throw new Error(`dsh-mobile-remote/qr: 仅支持纠错等级 L/M，收到 ${ecLevel}`);
  }
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, ecLevel);
  if (version === null) {
    throw new Error(`dsh-mobile-remote/qr: 文本过长（${bytes.length} 字节，上限版本 ${MAX_VERSION}/${ecLevel}）`);
  }

  const codewords = interleave(buildDataCodewords(bytes, version, ecLevel), version, ecLevel);

  const base = createMatrix(version);
  drawFunctionPatterns(base, ecLevel);
  placeData(base, codewords);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const modules = applyMask(base, mask);
    writeFormatInfo(modules, base.size, ecLevel, mask);
    const score =
      penaltyRuns(modules, base.size) +
      penaltyBlocks(modules, base.size) +
      penaltyFinderLike(modules, base.size) +
      penaltyBalance(modules, base.size);
    if (score < bestScore) {
      bestScore = score;
      best = { modules, mask };
    }
  }

  return { version, size: base.size, ecLevel, mask: best.mask, modules: best.modules };
}

// ── PNG 写出（1 位灰度，无依赖） ─────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** 把 0/1 矩阵包成灰度 PNG（每个模块 scale 像素，四周 margin 模块静区）。 */
function matrixToPng(matrix, scale, margin) {
  const { size, modules } = matrix;
  const side = (size + margin * 2) * scale;
  const raw = Buffer.alloc(side * (side + 1));
  let p = 0;
  for (let y = 0; y < side; y++) {
    raw[p++] = 0; // filter: none
    const my = Math.floor(y / scale) - margin;
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - margin;
      const inGrid = my >= 0 && my < size && mx >= 0 && mx < size;
      const dark = inGrid && modules[my][mx] === 1;
      raw[p++] = dark ? 0x00 : 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 生成二维码 PNG 的 data URL（宿主半用；浏览器半不调用）。
 * @param {string} text
 * @param {{ scale?: number, margin?: number, ecLevel?: 'L'|'M' }} [options]
 * @returns {string} `data:image/png;base64,...`
 */
export function qrPngDataUrl(text, options = {}) {
  const scale = options.scale ?? 6;
  const margin = options.margin ?? 3;
  const matrix = encodeMatrix(text, { ecLevel: options.ecLevel ?? 'M' });
  return `data:image/png;base64,${matrixToPng(matrix, scale, margin).toString('base64')}`;
}

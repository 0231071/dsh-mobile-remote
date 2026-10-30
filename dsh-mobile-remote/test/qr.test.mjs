/**
 * QR 编码器验证。
 *
 * 验证策略（本机离线、宿主无 QR 库，故不依赖任何外部二维码实现）：
 *  1. 版本表断言：各版本各等级的「数据码字数」与公开标准值逐项比对（表抄错必炸）。
 *  2. 结构断言：定位/分隔/定时/校正/暗模块必须符合 ISO/IEC 18004 的几何定义。
 *  3. 往返解码：test/qr-decode.mjs 里**独立编写**的解码器读回文本，
 *     并逐块校验 Reed-Solomon 伴随式为零（同时证明 RS 生成、分块、交织、掩码、铺位）。
 *  4. 位图往返：把 PNG 渲染结果重新解析回模块矩阵再解码 —— 证明「真正印在图上」的
 *     内容与输入一致（等价于拿手机扫了一次）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMatrix, qrPngDataUrl } from '../lib/qr.js';
import { decodeMatrix, EC_TABLE, ALIGNMENT } from './qr-decode.mjs';
import { matrixFromPng } from './png-matrix.mjs';

const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

test('版本表：各版本各等级数据码字数与公开标准值一致', () => {
  const expected = {
    L: { 1: 19, 2: 34, 3: 55, 4: 80, 5: 108, 6: 136, 7: 156, 8: 194, 9: 232, 10: 310 },
    M: { 1: 16, 2: 28, 3: 44, 4: 64, 5: 86, 6: 108, 7: 124, 8: 154, 9: 182, 10: 216 },
  };
  for (const [ecl, rows] of Object.entries(expected)) {
    for (const [v, want] of Object.entries(rows)) {
      const [ec, blocks] = EC_TABLE[ecl][v];
      assert.equal(TOTAL_CODEWORDS[v - 1] - ec * blocks, want, `${ecl} 版本 ${v} 数据码字数不符`);
    }
  }
});

test('结构：定位、分隔、定时、校正、暗模块几何正确', () => {
  for (const ecLevel of ['L', 'M']) {
    for (let target = 1; target <= 10; target++) {
      const spread = ['A', 'B'.repeat(20), 'C'.repeat(60), 'D'.repeat(120), 'E'.repeat(200)];
      let m = null;
      for (const sample of spread) {
        const candidate = encodeMatrix(sample, { ecLevel });
        if (candidate.version === target) { m = candidate; break; }
      }
      if (!m) continue;

      const { size, modules } = m;
      const finder = (r0, c0, label) => {
        for (let dr = 0; dr < 7; dr++) {
          for (let dc = 0; dc < 7; dc++) {
            const dark = dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
            assert.equal(modules[r0 + dr][c0 + dc], dark ? 1 : 0, `${label} 定位图形 (${r0 + dr},${c0 + dc})`);
          }
        }
      };
      finder(0, 0, '左上');
      finder(0, size - 7, '右上');
      finder(size - 7, 0, '左下');

      for (let i = 0; i < 8; i++) {
        assert.equal(modules[7][i], 0, '左上分隔符');
        assert.equal(modules[i][7], 0, '左上分隔符');
      }
      for (let i = 8; i < size - 8; i++) {
        assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `水平定时图形 col=${i}`);
        assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `垂直定时图形 row=${i}`);
      }
      for (const r of ALIGNMENT[m.version]) {
        for (const c of ALIGNMENT[m.version]) {
          if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const want = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
              assert.equal(modules[r + dr][c + dc], want, `校正图形 (${r + dr},${c + dc})`);
            }
          }
        }
      }
      assert.equal(modules[size - 8][8], 1, '暗模块');
    }
  }
});

test('往返解码：文本可完整还原，且各块 RS 伴随式为零', () => {
  const cases = [
    'http://192.168.1.5:41234/?token=TESTONLYNOTAREALTOKEN0000000000000000000000',
    'https://quiet-river-4821.trycloudflare.com/?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    'A',
    'x'.repeat(120),
    'x'.repeat(200),
    '中文与 emoji 也要能编 😀',
  ];
  for (const text of cases) {
    for (const ecLevel of ['L', 'M']) {
      const m = encodeMatrix(text, { ecLevel });
      const decoded = decodeMatrix(m);
      assert.equal(decoded.text, text, `${ecLevel} 版本 ${m.version} 往返不一致`);
      assert.equal(decoded.version, m.version);
      assert.equal(decoded.ecLevel, ecLevel);
      assert.equal(decoded.mask, m.mask, '解码读出的掩码应与编码器选择一致');
    }
  }
});

test('位图往返：把 PNG 读回来当扫描结果解码（等价于手机扫一扫）', () => {
  const cases = [
    'http://192.168.1.5:41234/?token=TESTONLYNOTAREALTOKEN0000000000000000000000',
    'https://quiet-river-4821.trycloudflare.com/?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  ];
  for (const text of cases) {
    const dataUrl = qrPngDataUrl(text, { scale: 4, margin: 2 });
    const png = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    const recovered = matrixFromPng(png);
    assert.equal(recovered.scale, 4, '模块边长应能从定位图形反推出来');
    assert.equal(recovered.margin, 2, '静区宽度应能反推出来');
    const decoded = decodeMatrix(recovered);
    assert.equal(decoded.text, text, '从位图读回的文本应与输入一致');
  }
});

test('容量边界：超长文本与非 L/M 等级抛出可读错误', () => {
  assert.throws(() => encodeMatrix('x'.repeat(500), { ecLevel: 'M' }), /文本过长/);
  assert.throws(() => encodeMatrix('x', { ecLevel: 'H' }), /仅支持纠错等级 L\/M/);
});

test('PNG：输出为合法 PNG 且尺寸符合 scale/margin', () => {
  const url = qrPngDataUrl('https://example.com/?token=abc', { scale: 4, margin: 2 });
  assert.ok(url.startsWith('data:image/png;base64,'));
  const buf = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG magic');

  const matrix = encodeMatrix('https://example.com/?token=abc');
  const expectedSide = (matrix.size + 4) * 4;
  assert.equal(buf.readUInt32BE(16), expectedSide, 'IHDR 宽度');
  assert.equal(buf.readUInt32BE(20), expectedSide, 'IHDR 高度');
  assert.equal(buf[24], 8, '位深');
  assert.equal(buf[25], 0, '颜色类型 = 灰度');
  assert.ok(buf.includes(Buffer.from('IEND', 'latin1')), '含 IEND 块');
});

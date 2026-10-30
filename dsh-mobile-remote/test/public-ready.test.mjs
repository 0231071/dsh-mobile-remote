/**
 * 公网就绪判定的回归用例 —— 锁死那个让手机「无法打开页面」的真实事故。
 *
 * 事故现场：用户点开公网模式，二维码秒出，界面很快显示「公网已就绪，手机可在任意
 * 网络扫码」，于是立刻用微信扫码 —— 手机报「无法打开页面」。
 *
 * 成因有两层，本文件各锁一层：
 *  1. **探针提前收工**（lib/tunnel.js）：`waitForPublicReady` 原本在"边缘回源成功"
 *     时就 return。边缘回源只证明隧道通到 Cloudflare，**不证明临时子域的 DNS 记录
 *     已经存在**。实测新域名头 ~67 秒是 NXDOMAIN（tools/measure-dns-window.mjs），
 *     而边缘探针在隧道建好后几秒就成功。于是探针收工 → 后续再也无人发现域名已生效。
 *     ⇒ 现在的契约：只有 direct 成功才提前返回；edge 成功只记录，继续等 direct。
 *  2. **文案撒谎**（lib/host.js）：无论哪种成功都被翻成"已就绪、可以扫"，还额外写了
 *     "二维码现在就可以扫"。
 *     ⇒ 现在的契约：只有 `via:'direct'` 才允许出现"现在可以扫"；其余一律是"等一会儿
 *       再扫同一个二维码"，且任何文案都必须告诉用户**不必重新生成二维码**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { probeDirectFetch, waitForPublicReady } from '../lib/tunnel.js';
import { PUBLIC_DNS_PENDING_MESSAGE, publicReadinessMessage } from '../lib/host.js';

const URL_UNDER_TEST = 'https://pine-graduate-nhs-trip.trycloudflare.com';

/** 起一个只会回固定状态码的假源站，用来验"什么响应才算链路真的到了 DSH"。 */
async function withFakeOrigin(status, run) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(status));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('直连探针：DSH 的真实响应（401 未认证）才算链路通', async () => {
  const result = await withFakeOrigin(401, (baseUrl) => probeDirectFetch(baseUrl, () => {}));
  assert.equal(result.ok, true);
  assert.equal(result.status, 401);
});

test('直连探针：Cloudflare 的 5xx 错误页（530/502）不算就绪 —— 手机看到的正是它', async () => {
  // 实测：隧道刚建好的头几秒，边缘回源会吐 HTTP 530（源站未就绪）。旧代码把任何
  // HTTP 响应都当"可达"，于是界面会说"已就绪、可以扫"，而手机打开只有错误页。
  for (const status of [502, 530]) {
    const result = await withFakeOrigin(status, (baseUrl) => probeDirectFetch(baseUrl, () => {}));
    assert.equal(result.ok, false, `HTTP ${status} 必须判为未就绪`);
    assert.match(result.error, new RegExp(String(status)));
  }
});

test('探针：edge 先成功不得提前返回，必须继续等 direct（域名真正生效）', async () => {
  let directCalls = 0;
  let edgeCalls = 0;
  const result = await waitForPublicReady(URL_UNDER_TEST, {
    timeoutMs: 5000,
    intervalMs: 10,
    // 前 3 次直连都失败（等价于新域名还处于 NXDOMAIN），第 4 次成功（DNS 生效）。
    probeDirect: async () => {
      directCalls++;
      return directCalls < 4 ? { ok: false, error: 'ENOTFOUND（域名尚未生效）' } : { ok: true, status: 401 };
    },
    probeEdge: async () => {
      edgeCalls++;
      return { ok: true, status: 401 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.via, 'direct', `edge 成功时必须继续等 direct，实际 via=${result.via}`);
  assert.equal(directCalls, 4, `直连探针必须被反复重试，实际只调了 ${directCalls} 次`);
  assert.ok(edgeCalls >= 1, '边缘回源仍应作为兜底信号被采到');
});

test('探针：direct 始终失败但 edge 成功 → 超时后返回 edge，而不是谎报 ready', async () => {
  const result = await waitForPublicReady(URL_UNDER_TEST, {
    timeoutMs: 300,
    intervalMs: 10,
    probeDirect: async () => ({ ok: false, error: 'ENOTFOUND' }),
    probeEdge: async () => ({ ok: true, status: 401 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.via, 'edge', '只证明隧道通、不证明域名生效，必须如实标注 edge');
});

test('探针：两条路都不通 → ok:false 且带上两边的失败原因（便于现场排查）', async () => {
  const result = await waitForPublicReady(URL_UNDER_TEST, {
    timeoutMs: 200,
    intervalMs: 10,
    probeDirect: async () => ({ ok: false, error: 'ENOTFOUND' }),
    probeEdge: async () => ({ ok: false, error: 'ECONNRESET' }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /ENOTFOUND/);
  assert.match(result.error, /ECONNRESET/);
});

test('探针：插件卸载（signal 已 abort）时立刻收工，不把宿主退出拖住', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await waitForPublicReady(URL_UNDER_TEST, {
    timeoutMs: 60_000,
    intervalMs: 10,
    signal: controller.signal,
    probeDirect: async () => ({ ok: false, error: '不该被调用' }),
    probeEdge: async () => ({ ok: false, error: '不该被调用' }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /取消/);
  assert.ok(Date.now() - started < 1000, '已经 abort 时不得再等满超时');
});

test('文案：只有 direct 才允许说"现在可以扫"，edge/失败一律要求等一会儿再扫', () => {
  const direct = publicReadinessMessage({ ok: true, via: 'direct', status: 401 });
  assert.equal(direct.ready, true);
  assert.match(direct.message, /现在可以扫码/);
  assert.equal(direct.lastError, null);

  const edge = publicReadinessMessage({ ok: true, via: 'edge', status: 401 });
  assert.equal(edge.ready, false, '仅边缘回源可达时不得宣告就绪');
  assert.doesNotMatch(edge.message, /现在可以扫码|已就绪/);
  assert.match(edge.message, /等 1 分钟/);
  assert.match(edge.message, /不必重新生成/, '必须告诉用户二维码仍然有效，避免反复重开');
  assert.match(edge.lastError, /边缘回源/);

  const failed = publicReadinessMessage({ ok: false, error: 'ENOTFOUND' });
  assert.equal(failed.ready, false);
  assert.doesNotMatch(failed.message, /现在可以扫码|已就绪/);
  assert.match(failed.message, /ENOTFOUND|局域网/);
});

test('文案：二维码刚出时（域名还没生效）必须劝阻立即扫码', () => {
  assert.match(PUBLIC_DNS_PENDING_MESSAGE, /等约 1 分钟/);
  assert.match(PUBLIC_DNS_PENDING_MESSAGE, /无法打开页面/, '要点明扫码会看到什么，用户才不会以为插件坏了');
  assert.doesNotMatch(PUBLIC_DNS_PENDING_MESSAGE, /现在就可以扫/, '就是这句话把用户送进坑里');
  assert.match(PUBLIC_DNS_PENDING_MESSAGE, /不必重新生成/);
});
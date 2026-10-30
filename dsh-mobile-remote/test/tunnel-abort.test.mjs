/**
 * tunnel.js 的取消语义：插件卸载时，在飞的下载/探针必须立刻落地。
 *
 * 这是「桌面端拒绝安装更新」事故的直接回归测试：只要探针还把宿主进程钉在 3 秒 / 10 秒的
 * 等待上，宿主的停机窗口就会被顶穿，安装随即被拒。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startQuickTunnel, waitForPublicReady } from '../lib/tunnel.js';

test('探针：已取消的信号立即返回，不做任何网络等待', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await waitForPublicReady('http://127.0.0.1:9/', {
    signal: controller.signal,
    timeoutMs: 60_000,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /已取消/);
  assert.ok(Date.now() - started < 1_000, `取消后应立即返回，实际 ${Date.now() - started}ms`);
});

test('隧道启动：已取消的信号立即拒绝，不等 90 秒的地址等待', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(
    startQuickTunnel({ binPath: process.execPath, port: 9, log: () => {}, signal: controller.signal }),
    /已取消/,
  );
  assert.ok(Date.now() - started < 5_000, `取消后应立即拒绝，实际 ${Date.now() - started}ms`);
});

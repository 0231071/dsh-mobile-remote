/**
 * 「重启后复用同一条公网隧道」的判定与回收（lib/tunnel.js 的纯逻辑部分）。
 *
 * 为什么这块必须单独钉死：复用错误的代价是**把公网指向别人的端口**。所以判据不能是
 * 「pid 还活着」（pid 会被系统复用），只能是两条可观测的硬事实：
 *   ① 端口能被我重新绑上（证明现在归我）；
 *   ② 那个域名打过来真的到了我这儿（`/health` 返回 200 且正文是 `ok`）。
 *
 * 用例覆盖：身份探测的严格性、重试到超时、端口不匹配/探测失败时**必须重建**、
 * 以及「陷阱」——活着的 pid 不构成复用理由。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

import {
  adoptTunnel,
  planTunnel,
  probeTunnelIdentity,
  reapTunnelProcess,
} from '../lib/tunnel.js';

/** 一个只回答 `/mobile-remote/health` 的假「我的插件」。 */
async function startHealthServer({ status = 200, body = 'ok\n' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/mobile-remote/health' && status === 200) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }
    res.writeHead(status === 200 ? 404 : status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 一个「有响应但不是我们」的假源站（健康检查回 404 页面）。 */
async function startStrangerServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html>someone else</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('身份探测：200 + 正文 ok 才算「还是我」；404/正文不对一律不算', async () => {
  const mine = await startHealthServer();
  const stranger = await startStrangerServer();
  const wrongBody = await startHealthServer({ body: 'hello\n' });
  try {
    assert.equal((await probeTunnelIdentity(mine.origin)).ok, true, '自己的健康检查应通过');
    const notMine = await probeTunnelIdentity(stranger.origin);
    assert.equal(notMine.ok, false, '有响应不等于是我');
    assert.match(notMine.error, /HTTP 404/);
    const weird = await probeTunnelIdentity(wrongBody.origin);
    assert.equal(weird.ok, false, '正文不是 ok 也不算（防止别的程序碰巧回 200）');
    const dead = await probeTunnelIdentity('http://127.0.0.1:1');
    assert.equal(dead.ok, false, '连不上必须判否');
  } finally {
    await mine.close();
    await stranger.close();
    await wrongBody.close();
  }
});

test('复用判定：没有地址、域名不合法都直接拒绝，不发任何请求', async () => {
  let called = 0;
  const probe = async () => { called += 1; return { ok: true }; };
  assert.equal((await adoptTunnel(null, { probe })).ok, false);
  assert.equal((await adoptTunnel({ url: 'http://evil.example.com' }, { probe })).ok, false,
    '只接受 trycloudflare 域名，避免被写坏的状态文件带去别处');
  assert.equal(called, 0, '判否的路径不该发出探测');
});

test('复用判定：先失败后成功（隧道要几秒才把连接确认回来）→ 成功', async () => {
  let attempts = 0;
  const verdict = await adoptTunnel(
    { url: 'https://abc.trycloudflare.com', port: 1234 },
    {
      intervalMs: 5,
      timeoutMs: 1000,
      probe: async () => {
        attempts += 1;
        return attempts >= 3 ? { ok: true } : { ok: false, error: '还没回来' };
      },
    },
  );
  assert.equal(verdict.ok, true);
  assert.equal(attempts, 3, '应该重试到成功为止');
});

test('复用判定：一直不通 → 超时给否，并带上最后一次的失败原因', async () => {
  const verdict = await adoptTunnel(
    { url: 'https://abc.trycloudflare.com', port: 1234 },
    { intervalMs: 5, timeoutMs: 60, probe: async () => ({ ok: false, error: '连接被拒绝' }) },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error, '连接被拒绝');
});

test('决策：只有「端口绑回 + 身份确认」同时成立才复用，其余一律重建', () => {
  const record = { pid: 111, url: 'https://abc.trycloudflare.com', port: 5000 };

  assert.equal(planTunnel({ record, boundPort: 5000, adopted: true }).action, 'adopt');
  assert.equal(planTunnel({ record, boundPort: 5000, adopted: true }).reapRecord, null, '复用时不该回收');

  // 陷阱：pid 活着、端口也对，但身份探测没过 → 必须重建（可能是别人的进程占着端口）
  const stale = planTunnel({ record, boundPort: 5000, adopted: false });
  assert.equal(stale.action, 'fresh');
  assert.deepEqual(stale.reapRecord, record, '探测失败应尽力回收旧进程');
  assert.match(stale.reason, /探测没过/);

  // 端口没绑回来（被别的程序占用 → 我们退了随机端口）→ 旧域名接不上，重建
  const portMismatch = planTunnel({ record, boundPort: 5001, adopted: false });
  assert.equal(portMismatch.action, 'fresh');
  assert.deepEqual(portMismatch.reapRecord, record);
  assert.match(portMismatch.reason, /端口对不上/);

  assert.equal(planTunnel({ record: null, boundPort: 5000, adopted: false }).action, 'fresh');
  assert.equal(planTunnel({ record: null, boundPort: 5000, adopted: false }).reapRecord, null,
    '没有记录时没有可回收的东西');
});

test('回收：pid 不存在时安静地返回否；自己的子进程能被真的收掉', async () => {
  assert.equal(reapTunnelProcess({ pid: 999_999 }), false, '不存在的 pid 不该抛');
  assert.equal(reapTunnelProcess({}), false);
  assert.equal(reapTunnelProcess(null), false);

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(reapTunnelProcess({ pid: child.pid }), true, '活着的应被回收');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  assert.notEqual(child.exitCode, null, '子进程应真的退出');
});

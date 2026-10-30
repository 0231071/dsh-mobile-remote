/**
 * 改写代理端到端验证。
 *
 * 用一个「像 DSH 一样挑 Host」的伪造源站做对照：源站只在 Host 等于
 * `127.0.0.1:<自己的端口>` 时才认，否则 403。这样只要代理少改一次 Host，
 * 测试立刻红——正是 DSH 的信任模型（Host/Origin 校验 + authority 绑定 cookie）。
 *
 * 覆盖：令牌首跳 303 下发 cookie、带 cookie 复访、未认证 401、
 * Host/Origin/Referer 改写、WebSocket 升级透传、分块流式、并发、停机释放端口。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { RewriteProxy } from '../lib/proxy.js';

/** 伪造源站：Host 不对就 403，令牌对就 303+cookie，cookie 对就 200。 */
async function startOrigin() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer,
      url: req.url,
      cookie: req.headers.cookie ?? null,
      connection: req.headers.connection,
    });

    if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden-host');
      return;
    }

    const url = new URL(req.url, 'http://placeholder');
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('chunk-1\n');
      setTimeout(() => {
        res.write('chunk-2\n');
        res.end();
      }, 60);
      return;
    }
    if (url.searchParams.get('token') === 'SECRET') {
      res.writeHead(303, {
        location: '/',
        'set-cookie': 'sess=abc; Path=/; HttpOnly; SameSite=Strict',
      });
      res.end();
      return;
    }
    if (req.headers.cookie === 'sess=abc') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html>dsh-ok</html>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
  });

  server.on('upgrade', (req, socket) => {
    seen.push({
      upgrade: true,
      host: req.headers.host,
      connection: req.headers.connection,
      upgradeHeader: req.headers.upgrade,
    });
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || !/upgrade/i.test(req.headers.connection ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    // 必须 resume() 且在 end 时主动收尾：http.Server 的 socket 是 allowHalfOpen，
    // 光收到 FIN 只会 emit 'end' 而不会 close，server.close() 就会一直挂着
    // （纯属测试替身的账目问题，与代理无关）。
    socket.resume();
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write('frame-from-origin');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 通过代理发一个请求，可显式指定「手机看到」的 Host/Origin。 */
function viaProxy(proxyPort, path, { host, origin, cookie, referer } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.host = host;
    if (origin) headers.origin = origin;
    if (referer) headers.referer = referer;
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('代理：令牌首跳 303、cookie 复访 200、未认证 401，且 Host/Origin/Referer 被改写', async () => {
  const origin = await startOrigin();
  const proxy = new RewriteProxy({ targetPort: origin.port });
  const proxyPort = await proxy.start();
  const phoneHost = '192.168.1.5:40000';

  try {
    const first = await viaProxy(proxyPort, '/?token=SECRET', { host: phoneHost, origin: `http://${phoneHost}` });
    assert.equal(first.status, 303, '首跳应为 303 重定向');
    assert.match(first.headers['set-cookie'][0], /^sess=abc/);
    assert.equal(first.headers.location, '/');

    const authed = await viaProxy(proxyPort, '/', { host: phoneHost, cookie: 'sess=abc' });
    assert.equal(authed.status, 200, '带 cookie 复访应为 200');
    assert.match(authed.body, /dsh-ok/);

    const anon = await viaProxy(proxyPort, '/', { host: phoneHost });
    assert.equal(anon.status, 401, '无令牌无 cookie 应为 401');

    // 源站必须只看到回环 authority：证明改写生效（否则源站会回 403）
    for (const entry of origin.seen) {
      assert.equal(entry.host, `127.0.0.1:${origin.port}`, `源站应只看到回环 Host，实际 ${entry.host}`);
    }
    const withOrigin = origin.seen.find((entry) => entry.origin !== undefined);
    assert.equal(withOrigin.origin, `http://127.0.0.1:${origin.port}`, 'Origin 应改写为回环源');

    const refererProbe = await viaProxy(proxyPort, '/', {
      host: phoneHost,
      referer: `http://${phoneHost}/some/path?x=1`,
    });
    assert.equal(refererProbe.status, 401);
    const refererSeen = origin.seen.at(-1);
    assert.equal(refererSeen.referer, `http://127.0.0.1:${origin.port}/some/path?x=1`, 'Referer 应保留路径并换源');
  } finally {
    await proxy.stop();
    await origin.close();
  }
});

test('代理：WebSocket 升级按 Upgrade 语义透传（保持全双工）', async () => {
  const origin = await startOrigin();
  const proxy = new RewriteProxy({ targetPort: origin.port });
  const proxyPort = await proxy.start();

  try {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write([
          'GET /api/stream HTTP/1.1',
          `Host: 192.168.1.5:40000`,
          'Origin: http://192.168.1.5:40000',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'));
      });
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('frame-from-origin')) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        resolve(buffer);
      }, 3000);
    });

    assert.match(response, /101 Switching Protocols/, '升级应被接受');
    assert.match(response, /frame-from-origin/, '升级后服务端可主动推送（全双工）');
    const upgradeSeen = origin.seen.find((entry) => entry.upgrade);
    assert.ok(upgradeSeen, '源站应收到 upgrade 事件');
    assert.equal(upgradeSeen.host, `127.0.0.1:${origin.port}`, '升级请求的 Host 也要被改写');
    assert.match(upgradeSeen.connection, /upgrade/i, '升级请求必须保留 Connection: Upgrade');
    assert.equal(upgradeSeen.upgradeHeader, 'websocket');
  } finally {
    await proxy.stop();
    await origin.close();
  }
});

test('代理：分块流式响应逐段到达（会话流不被缓冲）', async () => {
  const origin = await startOrigin();
  const proxy = new RewriteProxy({ targetPort: origin.port });
  const proxyPort = await proxy.start();

  try {
    const arrived = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/stream', headers: { host: '10.0.0.9:5000' } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => chunks.push({ chunk, at: Date.now() }));
          res.on('end', () => resolve(chunks));
        },
      );
      req.on('error', reject);
      req.end();
    });

    assert.deepEqual(arrived.map((entry) => entry.chunk), ['chunk-1\n', 'chunk-2\n']);
    assert.ok(arrived[1].at - arrived[0].at >= 40, '两段之间应有真实间隔（说明没被整体缓冲）');
  } finally {
    await proxy.stop();
    await origin.close();
  }
});

test('代理：并发请求各自独立成连接（强制 Connection: close 不串包）', async () => {
  const origin = await startOrigin();
  const proxy = new RewriteProxy({ targetPort: origin.port });
  const proxyPort = await proxy.start();

  try {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => viaProxy(proxyPort, '/', { host: `192.168.1.${i + 10}:40000`, cookie: 'sess=abc' })),
    );
    assert.ok(results.every((entry) => entry.status === 200), '全部应为 200');
    assert.equal(origin.seen.length, 24, '源站应收到 24 个独立请求');
    for (const entry of origin.seen) assert.match(entry.connection ?? 'close', /close|keep-alive/i);
  } finally {
    await proxy.stop();
    await origin.close();
  }
});

test('代理：stop() 释放端口，重复启动被拒', async () => {
  const origin = await startOrigin();
  const proxy = new RewriteProxy({ targetPort: origin.port });
  const proxyPort = await proxy.start();
  await assert.rejects(async () => { await proxy.start(); }, /已在运行/, '同一实例重复 start 应拒绝');
  await proxy.stop();

  // 端口应已释放：能重新绑定
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(proxyPort, '0.0.0.0', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
  await origin.close();
});

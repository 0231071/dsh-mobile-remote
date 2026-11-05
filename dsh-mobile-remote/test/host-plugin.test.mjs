/**
 * 宿主半（lib/host.js）进程内验证。
 *
 * 这一层补的是「命令行能跑、桌面客户端里不生效」这类只在真实宿主形态下暴露的问题：
 *  - 路由前缀**不能带尾斜杠**（宿主匹配规则是 pathname === prefix || startsWith(prefix + '/')，
 *    带尾斜杠会拼成 `//`，任何请求都 404）；
 *  - 激活期**绝不能依赖 process.stderr / logger 这类可能缺席的东西**：Electron GUI 进程
 *    没有可用 stdio，一句 stderr 写入就会抛异常，把 apply() 掐在路由注册之前——
 *    表现就是「设置里有标签页，但接口全 404」；
 *  - 三条路由的行为、鉴权拒绝、开/关状态机、卸载时释放路由。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { decodeMatrix } from './qr-decode.mjs';
import { matrixFromPng } from './png-matrix.mjs';

// 激活轨迹指向临时目录：既验证了留痕，又不往开发者真实的 ~/.dsh 里写东西。
// 必须在 import host.js **之前**设好——模块加载时就会写第一条轨迹。
const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-trace-'));
process.env.DSH_MOBILE_REMOTE_TRACE_DIR = traceDir;
const TRACE_FILE = path.join(traceDir, 'activation.log');

const { apply, inject, name } = await import('../lib/host.js');

after(() => fs.rmSync(traceDir, { recursive: true, force: true }));

/** 造一个最小宿主 ctx：只提供 host.js 真正用到的面。 */
function makeCtx({ logger, webServerPort = 45678 } = {}) {
  const routes = [];
  const registered = [];
  const ctx = {
    logger: logger === undefined ? { info: () => {}, warn: () => {} } : logger,
    webServer: {
      port: webServerPort,
      register(route) {
        if (routes.some((r) => r.path === route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.push(route);
        registered.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    connection: {
      requestRejection: () => undefined,
      authenticatedUrl: (baseUrl) => `${baseUrl}?token=TESTTOKEN`,
    },
    effect(callback) {
      const dispose = callback();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
  };
  return { ctx, routes };
}

/** 用假的 req/res 打一次路由。 */
async function hit(routes, path, { method = 'GET', headers = {}, body, reject } = {}) {
  const route = routes.find((r) => path === r.path || path.startsWith(`${r.path}/`));
  assert.ok(route, `没有匹配 ${path} 的路由（已注册：${routes.map((r) => r.path).join(',')}）`);

  if (reject !== undefined) {
    const original = route.__rejection;
    route.__rejection = reject;
    void original;
  }

  const req = {
    method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const captured = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status, extra) { captured.status = status; Object.assign(captured.headers, extra ?? {}); },
    end(chunk) { if (chunk !== undefined) captured.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); },
  };
  await route.handler(req, res);
  return captured;
}

test('激活轨迹：import 与 apply 都留痕（宿主 GUI 里没有日志可看）', () => {
  // 这一步是事故现场的取证基础：Electron 无控制台时 stderr/logger 都可能不可读，
  // 只有文件能回答「模块被加载了吗 / apply 走到哪一步了」。
  assert.match(fs.readFileSync(TRACE_FILE, 'utf8'), /module imported/, 'import 时应留下痕迹');

  const { ctx } = makeCtx();
  apply(ctx);
  const text = fs.readFileSync(TRACE_FILE, 'utf8');
  assert.match(text, /apply\(\) entered/, 'apply 入口应留痕');
  assert.match(text, /route registered at \/mobile-remote/, '路由注册成功应留痕');
});

test('插件元信息：名字与硬依赖', () => {
  assert.equal(name, 'dsh-mobile-remote');
  assert.deepEqual([...inject].sort(), ['connection', 'webServer']);
});

test('激活：路由前缀不带尾斜杠（带尾斜杠会永远匹配不上）', () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  assert.equal(routes.length, 1, '应恰好注册一条路由');
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/mobile-remote', '前缀不能带尾斜杠');
  assert.ok(!routes[0].path.endsWith('/'));
});

test('激活：宿主没有可用 stderr（Electron GUI 进程）时也必须完成注册', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stderr');
  const { ctx, routes } = makeCtx();
  try {
    // 模拟 Electron GUI 进程：stdio 不可用，任何写入都会抛。
    Object.defineProperty(process, 'stderr', { value: undefined, configurable: true, writable: true });
    assert.equal(process.stderr, undefined, '测试前置条件：stderr 必须真的不可用，否则这条用例没有意义');
    apply(ctx);
  } finally {
    Object.defineProperty(process, 'stderr', descriptor);
  }
  assert.equal(routes.length, 1, 'stderr 缺席不得影响路由注册');
});

test('激活：logger 缺席或抛错都不得拖垮注册', () => {
  const boom = {
    info() { throw new Error('logger 炸了'); },
    warn() { throw new Error('logger 炸了'); },
  };
  const withThrowing = makeCtx({ logger: boom });
  apply(withThrowing.ctx);
  assert.equal(withThrowing.routes.length, 1, 'logger 抛错不得影响注册');

  const withoutLogger = makeCtx({ logger: null });
  apply(withoutLogger.ctx);
  assert.equal(withoutLogger.routes.length, 1, 'logger 缺席不得影响注册');
});

test('状态路由：GET /mobile-remote/status 返回 JSON，初始为 off', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const response = await hit(routes, '/mobile-remote/status');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  const state = JSON.parse(response.body);
  assert.equal(state.phase, 'off');
  assert.equal(state.enabled, false);
  assert.ok(Array.isArray(state.lanIps));
});

test('鉴权：connection 判定拒绝时不得继续处理（401/403 原样返回）', async () => {
  const { ctx, routes } = makeCtx();
  ctx.connection.requestRejection = () => 401;
  apply(ctx);
  const response = await hit(routes, '/mobile-remote/status');
  assert.equal(response.status, 401);
  assert.equal(response.body, 'unauthorized');
});

test('开关状态机：enable(lan) → on 且二维码编码的正是入口地址；disable → off', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);

  const enabled = await hit(routes, '/mobile-remote/enable', { method: 'POST', body: { mode: 'lan' } });
  assert.equal(enabled.status, 200);
  assert.equal(JSON.parse(enabled.body).phase, 'starting', 'enable 应立即返回 starting，不阻塞等隧道');

  // 等状态机跑到 on（局域网模式很快）
  let state = null;
  for (let i = 0; i < 40; i++) {
    const response = await hit(routes, '/mobile-remote/status');
    state = JSON.parse(response.body);
    if (state.phase === 'on' || state.phase === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(state?.phase, 'on', `局域网模式应进入 on，实际 ${state?.phase}（${state?.lastError ?? state?.message}）`);
  assert.match(state.authUrl, /^http:\/\/[\d.]+:\d+\/\?token=TESTTOKEN$/, `入口地址形态不对：${state.authUrl}`);
  assert.ok(state.proxyPort > 0, '应分配代理端口');
  assert.equal(state.targetPort, 45678, '应指向注入的 webServer 端口');

  // 二维码内容必须等于入口地址（等价于手机扫一次）
  const png = Buffer.from(state.qrPng.slice('data:image/png;base64,'.length), 'base64');
  const scanned = decodeMatrix(matrixFromPng(png));
  assert.equal(scanned.text, state.authUrl, '二维码里印的必须就是入口地址');

  // 代理真的在监听：拿入口地址的路径去打它，应能连上（上游是假的 webServer，会拒连，
  // 这里只验证端口已被占用，即代理确实起来了）
  const net = await import('node:net');
  const occupied = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(state.proxyPort, '0.0.0.0');
  });
  assert.ok(occupied, '启用后代理端口应处于监听状态');

  const disabled = await hit(routes, '/mobile-remote/disable', { method: 'POST' });
  assert.equal(disabled.status, 200);
  const off = JSON.parse(disabled.body);
  assert.equal(off.phase, 'off');
  assert.equal(off.qrPng, null, '关闭后二维码必须清空');

  // 关闭后端口应释放
  const stillOccupied = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(state.proxyPort, '0.0.0.0');
  });
  assert.equal(stillOccupied, false, '关闭后代理端口应已释放');
});

test('未知操作 → 404；卸载时路由被释放', async () => {
  const { ctx, routes } = makeCtx();
  const disposers = [];
  ctx.effect = (callback) => {
    const dispose = callback();
    disposers.push(dispose);
    return () => { if (typeof dispose === 'function') dispose(); };
  };
  apply(ctx);

  const unknown = await hit(routes, '/mobile-remote/nope');
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /未知操作/);

  for (const dispose of disposers) dispose();
  assert.equal(routes.length, 0, '卸载后不应残留路由');
});

test('卸载：清理必须交回 promise，且 await 之后端口已释放', async () => {
  const { ctx, routes } = makeCtx();
  const disposers = [];
  ctx.effect = (callback) => {
    const dispose = callback();
    disposers.push(dispose);
    return () => { if (typeof dispose === 'function') dispose(); };
  };
  apply(ctx);

  await hit(routes, '/mobile-remote/enable', { method: 'POST', body: { mode: 'lan' } });
  let state = null;
  for (let i = 0; i < 40; i++) {
    state = JSON.parse((await hit(routes, '/mobile-remote/status')).body);
    if (state.phase === 'on' || state.phase === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(state?.phase, 'on', `前置条件：局域网模式应已开启，实际 ${state?.phase}（${state?.lastError ?? state?.message}）`);

  const cleanup = disposers[disposers.length - 1];
  assert.equal(typeof cleanup, 'function', '停机清理必须注册为 effect');
  const pending = cleanup();
  assert.ok(pending instanceof Promise, '停机清理必须把 promise 交回宿主，否则宿主会在清理完成前退出');

  await pending;

  // await 之后端口必须已经释放：这正是「宿主退出前清理已结束」的判据。
  const net = await import('node:net');
  const occupied = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(state.proxyPort, '0.0.0.0');
  });
  assert.equal(occupied, false, 'await 清理之后代理端口应已释放');
});

//#region 自愈：中转页 + 恢复票换票

/** 像手机一样经代理发一个请求，返回状态、响应头与全部 Set-Cookie。 */
function requestVia(port, requestPath, { accept, host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (accept) headers.accept = accept;
    if (host) headers.host = host;
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        setCookie: res.headers['set-cookie'] ?? [],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 等状态机跑到 on（局域网模式很快）。 */
async function waitForOn(routes) {
  let state = null;
  for (let i = 0; i < 40; i++) {
    state = JSON.parse((await hit(routes, '/mobile-remote/status')).body);
    if (state.phase === 'on' || state.phase === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state;
}

test('自愈：中转页与换票入口在未认证时仍可达（否则就是「401 页要你先认证」）', async () => {
  const { ctx, routes } = makeCtx();
  // 手机没有 DSH cookie 时，宿主给的真实判定就是 401
  ctx.connection.requestRejection = () => 401;
  apply(ctx);

  const page = await hit(routes, '/mobile-remote/relay');
  assert.equal(page.status, 200, '中转页必须未认证可达');
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /重新认证/);
  assert.match(page.body, /\/mobile-remote\/redeem/, '按钮必须指向换票入口');
  assert.equal(page.headers['cache-control'], 'no-store');

  const denied = await hit(routes, '/mobile-remote/redeem');
  assert.equal(denied.status, 200, '没有恢复票时也要给人看的页面');
  assert.match(denied.body, /恢复票/, '要说清「恢复票也不在了」，而不是白屏或 401');
  assert.ok(!denied.body.includes('href="/mobile-remote/redeem"'),
    '已知换不出票时不能再摆一个「不用再扫码」的按钮（点了只会回到同一页）');

  // 自愈入口没有把鉴权撕开口子：真正的状态接口对未认证请求仍然 401
  const status = await hit(routes, '/mobile-remote/status');
  assert.equal(status.status, 401, '状态接口仍必须受 cookie 保护');
});

test('自愈：扫码换票时补发恢复票，redeem 凭票 302 回入口地址（不用二次扫码）', async () => {
  // 一个「行为与 DSH 一致」的假源站：token → 303 + dsh-auth-*；带票 → 200；否则官方 401 文本
  const origin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    if (url.searchParams.get('token') === 'TESTTOKEN') {
      res.writeHead(303, {
        location: './',
        'set-cookie': 'dsh-auth-ZZZ=1; Path=/; HttpOnly; SameSite=Strict',
      });
      res.end();
      return;
    }
    if ((req.headers.cookie ?? '').includes('dsh-auth-ZZZ')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html>ok</html>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));

  const { ctx, routes } = makeCtx({ webServerPort: origin.address().port });
  apply(ctx);

  try {
    await hit(routes, '/mobile-remote/enable', { method: 'POST', body: { mode: 'lan' } });
    const state = await waitForOn(routes);
    assert.equal(state?.phase, 'on', `前置条件：局域网模式应已开启，实际 ${state?.phase}（${state?.lastError ?? state?.message}）`);

    // ① 像手机一样经代理扫码：DSH 的票 + 插件的恢复票都要到手
    const first = await requestVia(state.proxyPort, '/?token=TESTTOKEN', { accept: 'text/html' });
    assert.equal(first.status, 303, '令牌首跳应为 303');
    const bootHeader = first.setCookie.find((c) => c.startsWith('dsh-mobile-boot='));
    assert.ok(bootHeader, `应补发一张恢复票，实际：${JSON.stringify(first.setCookie)}`);
    const bootValue = /^dsh-mobile-boot=([^;]+)/.exec(bootHeader)[1];

    // ② 带恢复票换票 → 302 到入口地址（含 token）
    const redeemed = await hit(routes, '/mobile-remote/redeem', { headers: { cookie: `dsh-mobile-boot=${bootValue}` } });
    assert.equal(redeemed.status, 302, `应 302 到入口地址，实际 ${redeemed.status}`);
    assert.equal(redeemed.headers.location, state.authUrl);
    assert.match(redeemed.headers.location, /token=TESTTOKEN/);
    assert.equal(redeemed.headers['cache-control'], 'no-store');
    assert.equal(redeemed.headers['referrer-policy'], 'no-referrer');

    // ③ 伪造的票：只给中转页，绝不泄露任何地址
    const forged = await hit(routes, '/mobile-remote/redeem', { headers: { cookie: 'dsh-mobile-boot=guess' } });
    assert.equal(forged.status, 200);
    assert.equal(forged.headers.location, undefined, '错票不得 302');
    assert.ok(!forged.body.includes('TESTTOKEN'), '错票不得换出地址');

    // ④ 关闭连接 → 恢复票立即作废
    await hit(routes, '/mobile-remote/disable', { method: 'POST' });
    const afterClose = await hit(routes, '/mobile-remote/redeem', { headers: { cookie: `dsh-mobile-boot=${bootValue}` } });
    assert.equal(afterClose.status, 200);
    assert.equal(afterClose.headers.location, undefined, '关掉之后旧票不得再换票');
    assert.ok(!afterClose.body.includes('TESTTOKEN'));
    assert.match(afterClose.body, /没在运行/);
  } finally {
    await new Promise((resolve) => origin.close(resolve));
  }
});

//#endregion
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

// 同理，插件现在会把偏好与两把长期钥匙写进 `$DSH_HOME/mobile-remote/state.json`。
// 测试必须把它指到临时目录，否则会**污染真实的状态文件**：那会让后续用例读到上一次的
// autoStart/mode，进而自己开启、留下监听中的代理，最后整个 `node --test` 卡在事件循环不空。
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-home-'));
process.env.DSH_HOME = homeDir;
const STATE_FILE = path.join(homeDir, 'mobile-remote', 'state.json');

const { apply, inject, name } = await import('../lib/host.js');

after(() => {
  fs.rmSync(traceDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

/** 每个用例都从「干净的开机状态」开始（清掉上次留下的偏好与钥匙）。 */
function resetState() {
  fs.rmSync(STATE_FILE, { force: true });
}

/**
 * 造一个最小宿主 ctx：只提供 host.js 真正用到的面。
 * @param {{ logger?: any, webServerPort?: number, token?: string, keepState?: boolean }} [options]
 */
function makeCtx({ logger, webServerPort = 45678, token = 'TESTTOKEN', keepState = false } = {}) {
  if (!keepState) resetState();
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
      authenticatedUrl: (baseUrl) => `${baseUrl}?token=${token}`,
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
  // 客户端的「已复用上次的公网隧道」那句话读的就是这个字段。它必须在 status 里下发，
  // 否则那句话永远是死代码 —— 界面就只能含糊地说「长期入口」，讲不出复用成功没有。
  assert.equal(state.tunnelAdopted, false, 'status 必须下发 tunnelAdopted');
});

test('鉴权：connection 判定拒绝时不得继续处理（401/403 原样返回）', async () => {
  const { ctx, routes } = makeCtx();
  ctx.connection.requestRejection = () => 401;
  apply(ctx);
  const response = await hit(routes, '/mobile-remote/status');
  assert.equal(response.status, 401);
  assert.equal(response.body, 'unauthorized');
});

test('开关状态机：enable(lan) → on 且二维码编码的是「长期入口」；disable → off', async () => {
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
  assert.ok(state.proxyPort > 0, '应分配代理端口');
  assert.equal(state.targetPort, 45678, '应指向注入的 webServer 端口');

  // 二维码里印的必须是**长期入口**（带插件自己的密钥），而不是 DSH 的令牌 URL：
  // 前者跨重启有效，后者一重启就作废 —— 这正是这次要解决的问题。
  assert.match(state.entryUrl, /^http:\/\/[\d.]+:\d+\/mobile-remote\/enter\?k=[A-Za-z0-9_-]{20,}$/,
    `长期入口形态不对：${state.entryUrl}`);
  assert.equal(state.entryStable, true, '局域网模式下入口应标记为跨重启稳定');
  assert.match(state.authUrl, /^http:\/\/[\d.]+:\d+\/\?token=TESTTOKEN$/, `令牌地址形态不对：${state.authUrl}`);

  const png = Buffer.from(state.qrPng.slice('data:image/png;base64,'.length), 'base64');
  const scanned = decodeMatrix(matrixFromPng(png));
  assert.equal(scanned.text, state.entryUrl, '二维码里印的必须就是长期入口');

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
  assert.equal(off.autoStart, false, '显式关闭后不应再自动开启');

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
function requestVia(port, requestPath, { accept, host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (accept) headers.accept = accept;
    if (host) headers.host = host;
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        setCookie: res.headers['set-cookie'] ?? [],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 等状态机跑到 on（局域网模式很快）。 */
async function waitForOn(routes, { attempts = 60 } = {}) {
  let state = null;
  for (let i = 0; i < attempts; i++) {
    state = JSON.parse((await hit(routes, '/mobile-remote/status')).body);
    if (state.phase === 'on' || state.phase === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state;
}

/** 从长期入口 URL 里取出密钥。 */
function entryKeyOf(entryUrl) {
  return new URL(entryUrl).searchParams.get('k');
}

test('自愈：中转页、换票入口、长期入口在未认证时仍可达（否则就是「401 页要你先认证」）', async () => {
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
  assert.match(denied.body, /恢复票/, '要说清恢复票不在，而不是白屏或 401');
  assert.ok(!denied.body.includes('href="/mobile-remote/redeem"'),
    '已知换不出票时不能再摆一个「不用再扫码」的按钮（点了只会回到同一页）');

  // 长期入口：密钥不对只回一行文本，绝不暗示「这里有东西可拿」
  const wrong = await hit(routes, '/mobile-remote/enter?k=nope');
  assert.equal(wrong.status, 403);
  assert.match(wrong.body, /密钥无效/);

  // 健康检查：给「域名 → 隧道 → 代理 → DSH」用，未认证可达且不含任何状态
  const health = await hit(routes, '/mobile-remote/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.trim(), 'ok');

  // 自愈入口没有把鉴权撕开口子：真正的状态接口对未认证请求仍然 401
  const status = await hit(routes, '/mobile-remote/status');
  assert.equal(status.status, 401, '状态接口仍必须受 cookie 保护');
});

test('手机首跳：长期入口 → 302 到令牌地址 → DSH 303 下发 cookie → 首页 200', async () => {
  const origin = await makeDshLikeOrigin();
  const { ctx, routes } = makeCtx({ webServerPort: origin.port });
  apply(ctx);
  origin.servePlugin(routes[0]); // 真实宿主里插件路由就挂在这个 webServer 上

  try {
    await hit(routes, '/mobile-remote/enable', { method: 'POST', body: { mode: 'lan' } });
    const state = await waitForOn(routes);
    assert.equal(state?.phase, 'on', `前置条件：局域网模式应已开启，实际 ${state?.phase}（${state?.lastError ?? state?.message}）`);

    const entryPath = new URL(state.entryUrl).pathname + new URL(state.entryUrl).search;

    // ① 扫码 = 打开长期入口：应 302 到当前令牌地址，并顺手给一张恢复票
    const entered = await requestVia(state.proxyPort, entryPath, { accept: 'text/html' });
    assert.equal(entered.status, 302, `长期入口应 302 到令牌地址，实际 ${entered.status}`);
    assert.match(entered.headers.location, /\/\?token=TESTTOKEN$/, `应指向当前令牌，实际 ${entered.headers.location}`);
    const bootHeader = entered.setCookie.find((c) => c.startsWith('dsh-mobile-boot='));
    assert.ok(bootHeader, `长期入口应补发恢复票，实际：${JSON.stringify(entered.setCookie)}`);
    const bootValue = /^dsh-mobile-boot=([^;]+)/.exec(bootHeader)[1];

    // ② 跟随到令牌地址：DSH 303 下发它自己的会话 cookie，代理再补一张恢复票
    const first = await requestVia(state.proxyPort, '/?token=TESTTOKEN', { accept: 'text/html' });
    assert.equal(first.status, 303, '令牌首跳应为 303');
    assert.ok(first.setCookie.some((c) => c.startsWith('dsh-auth-ZZZ=')), 'DSH 的会话票必须原样保留');
    assert.ok(first.setCookie.some((c) => c.startsWith('dsh-mobile-boot=')), '认证成功时也应补恢复票');

    // ③ 带会话票打开首页 → 200
    const home = await requestVia(state.proxyPort, '/', { accept: 'text/html', cookie: 'dsh-auth-ZZZ=1' });
    assert.equal(home.status, 200);

    // ④ 没票的文档请求：带有效恢复票 → 自动换票（302 到换票入口），不需要人点；没带 → 中转页。
    const auto = await requestVia(state.proxyPort, '/', { accept: 'text/html', cookie: `dsh-mobile-boot=${bootValue}` });
    assert.equal(auto.status, 302, '持恢复票时应自动换票而不是让人点按钮');
    assert.equal(auto.headers.location, '/mobile-remote/redeem');

    const anonymous = await requestVia(state.proxyPort, '/', { accept: 'text/html' });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.body, /重新认证/, '没有恢复票时给中转页');

    // ⑤ 换票入口凭恢复票 302 回当前令牌地址，并打一次「刚试过」标记（防无限重定向）
    const redeemed = await hit(routes, '/mobile-remote/redeem', { headers: { cookie: `dsh-mobile-boot=${bootValue}` } });
    assert.equal(redeemed.status, 302);
    assert.equal(redeemed.headers.location, state.authUrl);
    assert.match(redeemed.headers['set-cookie'], /dsh-mobile-trying=1/);

    // ⑥ 伪造的票：只给中转页，绝不泄露任何地址
    const forged = await hit(routes, '/mobile-remote/redeem', { headers: { cookie: 'dsh-mobile-boot=guess' } });
    assert.equal(forged.status, 200);
    assert.equal(forged.headers.location, undefined, '错票不得 302');
    assert.ok(!forged.body.includes('TESTTOKEN'), '错票不得换出地址');

    // ⑦ 关闭连接 → 换票与长期入口都立刻停用（钥匙还在，但服务已关）
    await hit(routes, '/mobile-remote/disable', { method: 'POST' });
    const afterClose = await hit(routes, '/mobile-remote/redeem', { headers: { cookie: `dsh-mobile-boot=${bootValue}` } });
    assert.equal(afterClose.status, 200);
    assert.equal(afterClose.headers.location, undefined, '关掉之后旧票不得再换票');
    assert.match(afterClose.body, /没在运行/);
    const entryAfterClose = await hit(routes, `/mobile-remote/enter?k=${entryKeyOf(state.entryUrl)}`);
    assert.equal(entryAfterClose.status, 503, '关掉之后长期入口也应如实拒绝');
  } finally {
    await origin.close();
  }
});

test('重启：自动按上次形态开启，且旧二维码（长期入口）逐字节不变、照样能进', async () => {
  const origin = await makeDshLikeOrigin();

  // ── 第一次「进程」：用户开启，并记住「重启后自动开」 ──
  const first = makeCtx({ webServerPort: origin.port, token: 'TOKEN1' });
  const firstDisposers = [];
  first.ctx.effect = (callback) => {
    const dispose = callback();
    firstDisposers.push(dispose);
    return () => { if (typeof dispose === 'function') dispose(); };
  };
  apply(first.ctx);
  origin.servePlugin(first.routes[0]);

  let before = null;
  try {
    await hit(first.routes, '/mobile-remote/enable', { method: 'POST', body: { mode: 'lan', autoStart: true } });
    before = await waitForOn(first.routes);
    assert.equal(before?.phase, 'on', `前置条件：应开启，实际 ${before?.phase}（${before?.lastError ?? before?.message}）`);
    // 状态文件必须记住这次形态（模拟重启就靠它）
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.equal(saved.autoStart, true, '开启后应记住「重启后自动开」');
    assert.equal(saved.mode, 'lan');
    assert.ok(saved.lan.port > 0, '应记住代理端口，否则重启后入口地址就变了');
    assert.ok(saved.entryKey, '应持久化长期入口密钥');
  } finally {
    // 模拟 DSH 退出：宿主会调用停机清理
    for (const dispose of firstDisposers) await dispose();
  }

  // ── 第二次「进程」：DSH 换了端口、换了令牌，只剩磁盘状态 ──
  const second = makeCtx({ webServerPort: origin.port, token: 'TOKEN2', keepState: true });
  const secondDisposers = [];
  second.ctx.effect = (callback) => {
    const dispose = callback();
    secondDisposers.push(dispose);
    return () => { if (typeof dispose === 'function') dispose(); };
  };
  apply(second.ctx);
  origin.servePlugin(second.routes[0]);

  try {
    // 没有任何人调用 /enable：全靠重启后的自动开启
    const after = await waitForOn(second.routes, { attempts: 80 });
    assert.equal(after?.phase, 'on', `重启后应自动开启，实际 ${after?.phase}（${after?.lastError ?? after?.message}）`);
    assert.equal(after.entryUrl, before.entryUrl, '长期入口必须与重启前逐字节一致（这就是「旧二维码仍然有效」）');
    assert.equal(after.proxyPort, before.proxyPort, '代理端口应复用，否则地址就变了');
    assert.match(after.authUrl, /token=TOKEN2/, '令牌换了是正常的：入口会换出新令牌');

    // 拿**重启前那条**入口地址去打：应当 302 到**新**令牌地址
    const entryPath = new URL(before.entryUrl).pathname + new URL(before.entryUrl).search;
    const entered = await requestVia(after.proxyPort, entryPath, { accept: 'text/html' });
    assert.equal(entered.status, 302, '重启后旧二维码必须仍然能进');
    assert.match(entered.headers.location, /token=TOKEN2/, '应换出重启后这个进程的令牌');
  } finally {
    for (const dispose of secondDisposers) await dispose();
    await origin.close();
  }
});

test('重置长期入口：旧密钥立刻失效，新密钥可用', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);

  await hit(routes, '/mobile-remote/enable', { method: 'POST', body: { mode: 'lan' } });
  const state = await waitForOn(routes);
  const oldKey = entryKeyOf(state.entryUrl);

  // 未认证不能重置（否则谁都能把你手机踢下线）
  ctx.connection.requestRejection = () => 401;
  const denied = await hit(routes, '/mobile-remote/rotate-entry', { method: 'POST' });
  assert.equal(denied.status, 401);
  ctx.connection.requestRejection = () => undefined;

  const rotated = await hit(routes, '/mobile-remote/rotate-entry', { method: 'POST' });
  assert.equal(rotated.status, 200);
  const next = JSON.parse(rotated.body);
  const newKey = entryKeyOf(next.entryUrl);
  assert.notEqual(newKey, oldKey, '重置后密钥必须换');

  const oldEntry = await hit(routes, `/mobile-remote/enter?k=${oldKey}`);
  assert.equal(oldEntry.status, 403, '旧二维码在重置后必须失效');
  const newEntry = await hit(routes, `/mobile-remote/enter?k=${newKey}`);
  assert.equal(newEntry.status, 302);

  await hit(routes, '/mobile-remote/disable', { method: 'POST' });
});

test('自有域名模式缺配置：明确报错且不留下监听中的端口', async () => {  const { ctx, routes } = makeCtx();
  apply(ctx);

  await hit(routes, '/mobile-remote/enable', {
    method: 'POST',
    body: { mode: 'public', publicProvider: 'stable', autoStart: false },
  });
  const state = await waitForOn(routes);
  assert.equal(state?.phase, 'error', `缺域名/端口时应报错，实际 ${state?.phase}`);
  assert.match(state.lastError, /必须填写域名与本地端口/, `错误文案应可照做：${state.lastError}`);
  assert.equal(state.proxyPort, null, '失败时不该留下监听端口');
});

//#endregion

test('模式来回切：公网模式不得覆盖局域网端口（否则局域网入口跨重启就不稳了）', async () => {
  const { ctx, routes } = makeCtx();
  const disposers = [];
  ctx.effect = (callback) => {
    const dispose = callback();
    disposers.push(dispose);
    return () => { if (typeof dispose === 'function') dispose(); };
  };
  apply(ctx);

  try {
    await hit(routes, '/mobile-remote/enable', { method: 'POST', body: { mode: 'lan', autoStart: true } });
    const lan = await waitForOn(routes);
    assert.equal(lan?.phase, 'on', `前置：局域网应开启，实际 ${lan?.phase}（${lan?.lastError ?? lan?.message}）`);
    const lanPort = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lan.port;
    assert.equal(lanPort, lan.proxyPort, '局域网端口应被记住，重启后入口才逐字节一致');

    // 切到「自有域名」模式：用一个刚释放掉的固定端口
    const net = await import('node:net');
    const freePort = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '0.0.0.0', () => {
        const assigned = probe.address().port;
        probe.close(() => resolve(assigned));
      });
    });
    await hit(routes, '/mobile-remote/enable', {
      method: 'POST',
      body: {
        mode: 'public',
        publicProvider: 'stable',
        publicHost: 'dsh.example.com',
        publicPort: freePort,
        autoStart: true,
      },
    });
    const pub = await waitForOn(routes);
    assert.equal(pub?.phase, 'on', `切公网应成功（固定端口 ${freePort}），实际 ${pub?.phase}（${pub?.lastError ?? pub?.message}）`);
    assert.equal(pub.proxyPort, freePort, '自有域名模式必须用指定的固定端口');

    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.equal(saved.public.port, freePort, '公网端口应该记在 public.port');
    assert.equal(saved.lan.port, lanPort, '公网模式绝不能把它的端口写进 lan.port');
  } finally {
    for (const dispose of disposers) await dispose();
  }
});

/**
 * 一个「行为与 DSH 一致」的假源站。
 *
 * 关键点：**它同时扮演 DSH 的 webServer**。真实部署里插件的 `/mobile-remote/*` 路由就挂在
 * DSH 自己的 HTTP 服务器上，所以手机经代理访问 `/mobile-remote/enter` 时，请求是被
 * **同一个进程**接住的。第一版测试忘了这点，让假源站对 `/mobile-remote/*` 回了 401，
 * 于是「长期入口」那条链根本没被走到 —— 这类源站替身的失真必须靠 e2e 断言暴露出来。
 *
 * 令牌 URL → 303 + dsh-auth-*；带会话票 → 200；其余 → 官方那句 401 原文。
 */
async function makeDshLikeOrigin() {
  /** @type {{ handler?: (req: any, res: any) => Promise<void> } | null} */
  let pluginRoute = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    if (url.pathname.startsWith('/mobile-remote/') && pluginRoute !== null) {
      void pluginRoute.handler(req, res);
      return;
    }
    if (url.searchParams.get('token') !== null) {
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
    /** 把插件注册到假 webServer 上的那条路由接进来（等价于真实宿主的挂载）。 */
    servePlugin(route) {
      pluginRoute = route;
    },
  };
}
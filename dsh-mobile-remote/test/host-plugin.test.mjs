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
function makeCtx({ logger } = {}) {
  const routes = [];
  const registered = [];
  const ctx = {
    logger: logger === undefined ? { info: () => {}, warn: () => {} } : logger,
    webServer: {
      port: 45678,
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
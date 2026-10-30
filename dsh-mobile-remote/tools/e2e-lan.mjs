/**
 * 真机端到端验收（局域网模式）。
 *
 * 目标：证明「手机扫码 → 代理 → 真实 dsh web」整条链路成立，用的是官方
 * 真实实例与真实一次性 token，不是伪造源站。
 *
 * 真 token 从 ~/.dsh/web-host.log 取（官方 `dsh web` 自己就会把带 token 的
 * 启动 URL 写在那）；逐个候选端口试探，找到仍在服务且 token 未轮换的那个。
 * 也可用环境变量直接指定：DSH_E2E_PORT=3080 DSH_E2E_TOKEN=xxx
 *
 * 跑法：node test/e2e-lan.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { RewriteProxy } from '../lib/proxy.js';

const log = (...args) => console.log('[e2e]', ...args);

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.end();
  });
}

/** 找到一台「活着且 token 有效」的真实 dsh web。 */
async function findLiveTarget() {
  if (process.env.DSH_E2E_PORT && process.env.DSH_E2E_TOKEN) {
    return { port: Number(process.env.DSH_E2E_PORT), token: process.env.DSH_E2E_TOKEN };
  }
  const logFile = path.join(os.homedir(), '.dsh', 'web-host.log');
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const rows = [...text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/g)]
    .map((m) => ({ port: Number(m[1]), token: m[2] }))
    .reverse();

  for (const row of rows) {
    try {
      const probe = await request(row.port, `/?token=${row.token}`, { host: `127.0.0.1:${row.port}` });
      if (probe.status === 303) return row;
      log(`端口 ${row.port} 的 token 已失效（HTTP ${probe.status}），继续找`);
    } catch (error) {
      log(`端口 ${row.port} 无响应（${error.code ?? error.message}），继续找`);
    }
  }
  throw new Error('找不到可用的真实 dsh web（token 随进程轮换）。可在启动一个 `dsh web` 后用 DSH_E2E_PORT/DSH_E2E_TOKEN 指定。');
}

async function main() {
  const { port: dshPort, token } = await findLiveTarget();
  log(`目标：真实 dsh web @ 127.0.0.1:${dshPort}，token ${token.length} 位`);

  const proxy = new RewriteProxy({ targetPort: dshPort, log: (m) => log(`proxy: ${m}`) });
  const proxyPort = await proxy.start();
  const phoneHost = `192.168.1.5:${proxyPort}`;
  log(`代理监听 0.0.0.0:${proxyPort}；手机视角 authority=${phoneHost}`);

  const failures = [];
  const check = (name, condition, detail) => {
    if (condition) log(`✅ ${name}`);
    else { failures.push(name); log(`❌ ${name} — ${detail}`); }
  };

  try {
    // ① 未认证访问被拒
    const anon = await request(proxyPort, '/', { host: phoneHost });
    check('未认证访问根路径被拒（401）', anon.status === 401, `实际 ${anon.status}`);

    // ② 扫码首跳：带真 token 的根路径 → 303 + 下发 cookie
    const first = await request(proxyPort, `/?token=${token}`, { host: phoneHost, origin: `http://${phoneHost}` });
    const setCookie = first.headers['set-cookie'] ?? [];
    check('带 token 首跳 → 303 重定向', first.status === 303, `实际 ${first.status}：${first.body.slice(0, 160)}`);
    check('首跳下发会话 cookie', setCookie.length > 0, '没有 Set-Cookie');
    if (setCookie.length > 0) {
      check('cookie 不带 Secure（http 局域网可用）', !/;\s*Secure/i.test(setCookie[0]), setCookie[0]);
      log(`   cookie：${setCookie[0].split(';')[0].split('=')[0]}=… ; 属性 ${setCookie[0].split(';').slice(1).join(';').trim()}`);
    }

    // ③ 带 cookie 复访：拿到真正的 SPA 首页
    const cookie = setCookie[0]?.split(';')[0];
    const authed = await request(proxyPort, '/', { host: phoneHost, cookie });
    check('带 cookie 复访 → 200', authed.status === 200, `实际 ${authed.status}`);
    check('返回的是 DSH 前端首页', /<html/i.test(authed.body), authed.body.slice(0, 120));
    check('首页带启动清单 __DSH_BOOT__', authed.body.includes('__DSH_BOOT__'), '缺少启动清单');
    const bootHasPlugin = authed.body.includes('dsh-mobile-remote');
    log(`   ${bootHasPlugin ? '✅' : 'ℹ️ '} 启动清单${bootHasPlugin ? '已' : '尚未'}包含 dsh-mobile-remote（安装插件后应变为已包含）`);

    // ④ 真实静态资源经代理（从首页里挑一个 script/css 路径，不猜文件名）
    const assetPath = authed.body.match(/(?:src|href)="(\/[^"]+\.(?:js|css))"/)?.[1];
    if (assetPath) {
      const asset = await request(proxyPort, assetPath, { host: phoneHost, cookie });
      check(`静态资源 ${assetPath} 经代理可取`, asset.status === 200, `实际 ${asset.status}`);
    } else {
      log('ℹ️  首页里没找到静态资源引用，跳过该项');
    }

    // ⑤ 官方 /api 路由（未认证应 401，证明代理没有绕过鉴权）
    const api = await request(proxyPort, '/api', { host: phoneHost });
    check('/api 未认证仍被拒（代理未绕过鉴权）', api.status === 401 || api.status === 403 || api.status === 404, `实际 ${api.status}`);

    // ⑥ 插件路由（装了插件才有；未装时应落到静态 404/401）
    const pluginStatus = await request(proxyPort, '/mobile-remote/status', { host: phoneHost, cookie });
    log(`ℹ️  /mobile-remote/status（带 cookie）→ HTTP ${pluginStatus.status}`
      + (pluginStatus.status === 200 ? '，插件路由已生效 ✅' : '，插件尚未安装'));

    if (pluginStatus.status === 200) {
      const state = JSON.parse(pluginStatus.body);
      const missing = ['phase', 'mode', 'lanIps', 'qrPng', 'message'].filter((k) => !(k in state));
      check('插件状态结构完整', missing.length === 0, `缺字段 ${missing.join(',')}`);
    }
  } finally {
    await proxy.stop();
  }

  if (failures.length > 0) {
    console.error(`[e2e] 失败 ${failures.length} 项：${failures.join('；')}`);
    process.exit(1);
  }
  log('全部通过：手机扫码 → 本机改写代理 → 真实 dsh web 的令牌登录链路成立');
  process.exit(0);
}

await main();

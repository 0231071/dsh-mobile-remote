/**
 * 插件安装后的完整验收（自动跑通，不需要人手点界面）。
 *
 * 自己拉起一个**独立的 dsh web 实例**（desktop profile，含本插件），然后：
 *  ① 启动清单里能看到 dsh-mobile-remote，且它的 client bundle（combo URL）可服务；
 *  ② /mobile-remote/status 未认证 → 401（与官方 /api 同一套信任判定）；
 *  ③ 开启局域网模式 → 状态里出现 qrPng 与 authUrl，且局域网 IP 非空；
 *  ④ 把 qrPng 当图片解析回文本并解码 —— 二维码里印的必须就是 authUrl；
 *  ⑤ 拿 authUrl 当手机一样去访问插件的代理 → 303 + cookie → 200 真首页；
 *  ⑥ 关闭后代理端口释放、状态回到 off；
 *  ⑦ 开启公网模式 → 等 cloudflared 起来，用公网域名跑一次真实令牌登录。
 *
 * 跑法：node tools/verify-plugin.mjs                     （跳过公网模式）
 *      WITH_PUBLIC=1 node tools/verify-plugin.mjs        （含公网模式，首次会下载 cloudflared）
 *      PowerShell：$env:WITH_PUBLIC="1"; node tools/verify-plugin.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { decodeMatrix } from '../test/qr-decode.mjs';
import { matrixFromPng } from '../test/png-matrix.mjs';

/**
 * 找到全局安装的 dsh 可执行入口。可用 `DSH_BIN` 显式指定；否则按常见位置找一圈。
 * （刻意不写死某个人的家目录 —— 这是要发出去的仓库。）
 */
function findDshBin() {
  if (process.env.DSH_BIN !== undefined && process.env.DSH_BIN !== '') return process.env.DSH_BIN;
  const roots = [
    process.env.APPDATA === undefined ? undefined : path.join(process.env.APPDATA, 'npm', 'node_modules'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    path.join(os.homedir(), '.nvm', 'versions'), // 兜底：nvm 下自己挑（找不到就让用户显式给 DSH_BIN）
  ].filter((root) => root !== undefined);
  const suffix = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');
  for (const root of roots) {
    const candidate = path.join(root, suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(roots[0] ?? os.homedir(), suffix);
}

const DSH_BIN = findDshBin();
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const WITH_PUBLIC = process.env.WITH_PUBLIC === '1';

const log = (...args) => console.log('[verify]', ...args);
const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) log(`✅ ${name}`);
  else { failures.push(name); log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

function request(port, requestPath, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (host) finalHeaders.host = host;
    let payload;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      finalHeaders['content-type'] = 'application/json';
      finalHeaders['content-length'] = payload.byteLength;
    }
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers: finalHeaders, timeout: 30_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

function requestAbsolute(url, options = {}) {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host: parsed.hostname,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      timeout: options.timeout ?? 30_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

/** 反复请求一个绝对 URL 直到成功或超时：quick tunnel 的 DNS 记录要时间生效。 */
async function waitUntilReachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '未知原因';
  while (Date.now() < deadline) {
    try {
      const response = await requestAbsolute(url, { timeout: 15_000 });
      return { ok: true, response };
    } catch (error) {
      lastError = error.code ?? error.message;
      log(`   还不通（${lastError}），5s 后重试…`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, error: lastError };
}

async function waitForTokenUrl(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/);
    if (match) return { port: Number(match[1]), token: match[2] };
    if (/EPERM|EACCES/.test(text)) throw new Error(`dsh web 被沙箱拦下：\n${text.slice(-600)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`等待 token URL 超时；日志尾部：\n${(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').slice(-800)}`);
}

/** 轮询 /mobile-remote/status 直到 phase 离开 starting。 */
async function waitForPhase(port, cookie, host, { timeoutMs = 60_000, want = ['on', 'error', 'off'] } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request(port, '/mobile-remote/status', { headers: { cookie }, host });
    if (res.status === 200) {
      last = JSON.parse(res.body);
      if (want.includes(last.phase)) return last;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function main() {
  const scratch = path.join(os.tmpdir(), `dsh-mobile-verify-${Date.now()}`);
  fs.mkdirSync(scratch, { recursive: true });
  const logFile = path.join(scratch, 'dsh-web.log');
  fs.writeFileSync(logFile, '');
  const out = fs.openSync(logFile, 'a');

  log(`拉起独立 dsh web：DSH_HOME=${DSH_HOME} profile=desktop`);
  // 注意：`dsh web` 是 `--profile web` 的硬编码别名，会跑到 web profile 上去；
  // 桌面客户端用的是 desktop profile，所以这里必须显式 --profile desktop，
  // 其后的 --no-open/--host/--port 才是 web app 自己的参数。
  const child = spawn(process.execPath, [DSH_BIN, '--profile', 'desktop', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, DSH_HOME, DSH_PROFILE: 'desktop' },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });

  try {
    const { port, token } = await waitForTokenUrl(logFile, 120_000);
    const host = `127.0.0.1:${port}`;
    log(`实例就绪：127.0.0.1:${port}`);

    // ① 登录拿 cookie
    const login = await request(port, `/?token=${token}`, { host });
    const cookie = (login.headers['set-cookie'] ?? [])[0]?.split(';')[0];
    check('实例登录成功（303 + cookie）', login.status === 303 && Boolean(cookie), `HTTP ${login.status}`);
    if (!cookie) throw new Error('拿不到会话 cookie，后续无法继续');

    // ② 启动清单 & client bundle
    const index = await request(port, '/', { headers: { cookie }, host });
    check('启动清单包含 dsh-mobile-remote', index.body.includes('dsh-mobile-remote'), '插件 bundle 未进入 boot graph');
    // 宿主把各插件 bundle 以 combo URL 服务（/plugins/??<id>/client.js&rev=…），
    // 并不存在 /plugins/<id>/client.js 这种直连路径。首页里的 URL 还带 HTML 转义
    // （& → &amp;），必须先还原再请求；同一插件既有单行 combo（预载）也会出现在
    // 应用级大 combo 里，取最短的那条就是它自己的。
    const comboCandidates = [...index.body.matchAll(/\/plugins\/\?\?[^"'\s\\]*dsh-mobile-remote[^"'\s\\]*/g)]
      .map((match) => match[0].replace(/&amp;/gi, '&').replace(/\\u0026/gi, '&').replace(/\\\//g, '/'))
      .sort((a, b) => a.length - b.length);
    check('启动清单里有插件 bundle 的 combo URL', comboCandidates.length > 0, '未在首页里找到 /plugins/??…dsh-mobile-remote…');
    if (comboCandidates.length > 0) {
      const comboPath = comboCandidates[0];
      const bundle = await request(port, comboPath, { headers: { cookie }, host });
      check('插件 client bundle 可服务', bundle.status === 200, `HTTP ${bundle.status} → ${comboPath.slice(0, 160)}`);
      check('client bundle 注册了设置页',
        bundle.body.includes('mobile-remote') && bundle.body.includes('手机连接'),
        `bundle 里找不到本插件的设置页注册（${bundle.body.length} 字节）`);
      log(`   bundle：${comboPath.split('&rev=')[0].slice(0, 120)}，${bundle.body.length} 字节`);
    }

    // ③ 未认证访问插件路由必须被拒
    const anon = await request(port, '/mobile-remote/status', { host });
    check('插件路由未认证 → 401', anon.status === 401, `HTTP ${anon.status}`);

    // ④ 初始状态
    const initial = await request(port, '/mobile-remote/status', { headers: { cookie }, host });
    check('插件路由带 cookie → 200', initial.status === 200, `HTTP ${initial.status}：${initial.body.slice(0, 160)}`);
    const initialState = JSON.parse(initial.body);
    check('初始 phase = off', initialState.phase === 'off', `实际 ${initialState.phase}`);
    check('探测到局域网 IP', Array.isArray(initialState.lanIps) && initialState.lanIps.length > 0,
      `lanIps=${JSON.stringify(initialState.lanIps)}`);
    log(`   局域网候选：${initialState.lanIps.join(', ')}`);

    // ⑤ 开启局域网模式
    const enable = await request(port, '/mobile-remote/enable', { method: 'POST', headers: { cookie }, host, body: { mode: 'lan' } });
    check('enable(lan) 立即返回', enable.status === 200, `HTTP ${enable.status}`);
    const lanState = await waitForPhase(port, cookie, host, { timeoutMs: 30_000 });
    check('局域网模式进入 on', lanState?.phase === 'on', `phase=${lanState?.phase} msg=${lanState?.message}`);
    if (lanState?.phase !== 'on') throw new Error(`局域网模式未就绪：${lanState?.lastError ?? lanState?.message}`);
    check('状态里有二维码 PNG', typeof lanState.qrPng === 'string' && lanState.qrPng.startsWith('data:image/png;base64,'), '缺 qrPng');
    check('状态里有带 token 的入口地址', typeof lanState.authUrl === 'string' && lanState.authUrl.includes('token='), `authUrl=${lanState.authUrl}`);
    log(`   入口地址：${lanState.authUrl}`);
    log(`   代理端口：${lanState.proxyPort} → 127.0.0.1:${lanState.targetPort}`);

    // ⑥ 二维码内容必须等于 authUrl（等价于手机扫码）
    const png = Buffer.from(lanState.qrPng.slice('data:image/png;base64,'.length), 'base64');
    const recovered = matrixFromPng(png);
    const scanned = decodeMatrix(recovered);
    check('二维码解码结果 === authUrl', scanned.text === lanState.authUrl,
      `扫码得到 ${scanned.text}`);
    log(`   二维码：${recovered.size}×${recovered.size} 模块、纠错 ${scanned.ecLevel}、掩码 ${scanned.mask}`);

    // ⑦ 像手机一样走代理完成令牌登录
    const phoneAuthority = `${lanState.selectedIp}:${lanState.proxyPort}`;
    const phonePath = new URL(lanState.authUrl).pathname + new URL(lanState.authUrl).search;
    const phoneFirst = await request(Number(lanState.proxyPort), phonePath, {
      host: phoneAuthority,
      headers: { origin: `http://${phoneAuthority}` },
    });
    check('手机首跳（经代理）→ 303', phoneFirst.status === 303, `HTTP ${phoneFirst.status}`);
    const phoneCookie = (phoneFirst.headers['set-cookie'] ?? [])[0]?.split(';')[0];
    check('手机首跳拿到 cookie', Boolean(phoneCookie), '没有 Set-Cookie');
    const phoneHome = await request(Number(lanState.proxyPort), '/', { headers: { cookie: phoneCookie }, host: phoneAuthority });
    check('手机带 cookie 打开首页 → 200', phoneHome.status === 200, `HTTP ${phoneHome.status}`);
    check('手机首页是 DSH 前端', phoneHome.body.includes('__DSH_BOOT__'), '首页不含启动清单');

    // ⑦b 自愈链路（对**真实 DSH** 验，不能只靠假源站）
    //     ① 认证成功那一刻，代理必须补发恢复票；
    //     ② 带恢复票换票 → 302 回入口地址（手机不用第二次扫码）；
    //     ③ 没票只能拿到中转页，且不泄露入口地址；
    //     ④ 未认证的**文档**经代理 → 401 已换成中转页（真实那句原文必须被替换掉）。
    const cookies = phoneFirst.headers['set-cookie'] ?? [];
    const bootHeader = cookies.find((c) => c.startsWith('dsh-mobile-boot='));
    check('手机首跳同时拿到恢复票（dsh-mobile-boot）', Boolean(bootHeader), `Set-Cookie=${JSON.stringify(cookies)}`);
    if (bootHeader) {
      const bootCookie = bootHeader.split(';')[0];
      const redeem = await request(port, '/mobile-remote/redeem', { headers: { cookie: bootCookie }, host });
      check('恢复票换票 → 302 回入口地址',
        redeem.status === 302 && redeem.headers.location === lanState.authUrl,
        `HTTP ${redeem.status} location=${redeem.headers.location}`);
    }
    const noTicket = await request(port, '/mobile-remote/redeem', { host });
    check('无恢复票 → 只给中转页且不泄露入口地址',
      noTicket.status === 200 && noTicket.body.includes('/mobile-remote/redeem') && !noTicket.body.includes('token='),
      `HTTP ${noTicket.status}`);
    const relayDoc = await request(Number(lanState.proxyPort), '/', {
      host: phoneAuthority,
      headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
    });
    check('未认证文档经代理 → 401 但已是中转页',
      relayDoc.status === 401
        && relayDoc.body.includes('/mobile-remote/redeem')
        && !relayDoc.body.includes('dsh web authentication required'),
      `HTTP ${relayDoc.status}，正文前 80 字：${JSON.stringify(relayDoc.body.slice(0, 80))}`);

    // ⑧ 关闭：端口释放
    const disable = await request(port, '/mobile-remote/disable', { method: 'POST', headers: { cookie }, host });
    check('disable 返回 200', disable.status === 200, `HTTP ${disable.status}`);
    const offState = await waitForPhase(port, cookie, host, { timeoutMs: 15_000, want: ['off'] });
    check('关闭后 phase = off', offState?.phase === 'off', `phase=${offState?.phase}`);
    check('关闭后二维码被清空', !offState?.qrPng, '仍残留 qrPng');
    const rebind = await request(port, '/mobile-remote/status', { headers: { cookie }, host });
    log(`   关闭后状态：${JSON.parse(rebind.body).message}`);

    // ⑨ 公网模式
    if (WITH_PUBLIC) {
      log('开启公网模式（首次需下载 cloudflared，可能要几分钟）…');
      await request(port, '/mobile-remote/enable', { method: 'POST', headers: { cookie }, host, body: { mode: 'public' } });
      let lastLogged = '';
      const deadline = Date.now() + 8 * 60_000;
      let publicState = null;
      while (Date.now() < deadline) {
        const res = await request(port, '/mobile-remote/status', { headers: { cookie }, host });
        const state = JSON.parse(res.body);
        if (state.message && state.message !== lastLogged) { lastLogged = state.message; log(`   …${state.message}`); }
        if (state.phase === 'on' || state.phase === 'error') { publicState = state; break; }
        await new Promise((r) => setTimeout(r, 3000));
      }
      check('公网模式进入 on', publicState?.phase === 'on', `phase=${publicState?.phase} err=${publicState?.lastError}`);
      if (publicState?.phase === 'on') {
        check('公网地址是 trycloudflare 域名', /trycloudflare\.com/.test(publicState.publicUrl ?? ''), publicState.publicUrl);
        log(`   公网地址：${publicState.publicUrl}`);

        // quick tunnel 的临时子域 DNS 记录要几十秒才生效，这里耐心等而不是立刻判死。
        log('   等待公网域名生效（最长 3 分钟）…');
        const reach = await waitUntilReachable(`${publicState.publicUrl}/`, 180_000);
        check('公网未认证访问 → 401（链路真的通到本机 DSH）',
          reach.ok && reach.response.status === 401,
          reach.ok ? `HTTP ${reach.response.status}` : `始终不可达：${reach.error}`);
        if (reach.ok) {
          const publicLogin = await requestAbsolute(`${publicState.publicUrl}/?token=${new URL(publicState.authUrl).searchParams.get('token')}`, { timeout: 30_000 });
          check('公网带 token 首跳 → 303', publicLogin.status === 303, `HTTP ${publicLogin.status}`);
          const publicCookie = (publicLogin.headers['set-cookie'] ?? [])[0]?.split(';')[0];
          const publicHome = await requestAbsolute(`${publicState.publicUrl}/`, { headers: { cookie: publicCookie }, timeout: 30_000 });
          check('公网带 cookie 打开首页 → 200', publicHome.status === 200, `HTTP ${publicHome.status}`);
          check('公网首页是 DSH 前端', publicHome.body.includes('__DSH_BOOT__'), '首页不含启动清单');
        }

        const pubPng = Buffer.from(publicState.qrPng.slice('data:image/png;base64,'.length), 'base64');
        const pubScanned = decodeMatrix(matrixFromPng(pubPng));
        check('公网二维码内容 === 公网 authUrl', pubScanned.text === publicState.authUrl, `扫码得到 ${pubScanned.text}`);
      }
      await request(port, '/mobile-remote/disable', { method: 'POST', headers: { cookie }, host });
    } else {
      log('（跳过公网模式；用 WITH_PUBLIC=1 开启）');
    }
  } catch (error) {
    failures.push('harness 异常');
    console.error('[verify] 异常：', error instanceof Error ? error.message : error);
    if (fs.existsSync(logFile)) console.error('[verify] dsh web 日志尾部：\n', fs.readFileSync(logFile, 'utf8').slice(-1500));
  } finally {
    child.kill();
    fs.closeSync(out);
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`[verify] 失败 ${failures.length} 项：${failures.join('；')}`);
    process.exit(1);
  }
  log('全部通过 ✅');
  process.exit(0);
}

await main();

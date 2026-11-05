/**
 * dsh-mobile-remote —— 宿主半。
 *
 * 给 DSH 桌面客户端加「手机扫码远程控制」：桌面端出一个二维码，手机（浏览器或
 * 微信扫码）打开后进入**同一个** DSH Web UI，会话、任务、模型全部共享，因为
 * 手机连的就是本机那个 dsh web 进程。
 *
 * 两种接入模式：
 *  - lan    ：手机与电脑同一 Wi-Fi。代理监听 0.0.0.0，二维码指向
 *             `http://<局域网IP>:<代理端口>/?token=…`。
 *  - public ：手机在任意网络（4G/5G/异地）。cloudflared quick tunnel 把
 *             `https://<随机>.trycloudflare.com` 反代到本机代理，二维码指向它。
 *
 * 与官方安全模型的配合（这是整件事能成立的关键）：
 *  - 官方 `dsh web` **拒绝** `--host 0.0.0.0`，所以绝不改绑定地址，而是本机自建
 *    改写代理（见 proxy.js），DSH 自身永远只听 127.0.0.1。
 *  - 手机拿到的链接带官方一次性 token，首次访问由 DSH 自己 303 + 下发会话
 *    cookie，之后走 cookie；代理只做 Host/Origin 改写，不碰鉴权。
 *  - 本插件自己的 HTTP 路由同样挂在 `connection.requestRejection` 后面，
 *    与官方 /api 路由同一套 Host/Origin + cookie 校验，未认证请求一律 401。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { listLanIPv4 } from './net.js';
import { RewriteProxy } from './proxy.js';
import { qrPngDataUrl } from './qr.js';
import {
  RELAY_PATH,
  mintBootSecret,
  relayPageHtml,
  requestHasBootTicket,
} from './recover.js';
import { ensureCloudflared, startQuickTunnel, waitForPublicReady } from './tunnel.js';

/**
 * 激活轨迹：往 `$DSH_HOME/mobile-remote/activation.log` 追加一行。
 *
 * 为什么值得专门做这件事：宿主 GUI 进程里 `process.stderr` 和 `ctx.logger` 都可能
 * 缺席或不可读（Electron 无控制台时写 stderr 会直接抛），于是「插件到底有没有被加载、
 * apply() 走到哪一步」在事故现场**没有任何证据**——只能靠猜。写文件是唯一可靠的落地
 * 证据，而且整体包在 try/catch 里：跟踪失败绝不影响功能。
 */
function trace(line) {
  try {
    const dir = process.env.DSH_MOBILE_REMOTE_TRACE_DIR
      ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mobile-remote');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'activation.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 跟踪失败不影响功能 */
  }
}

// 模块级：只要这个模块被 import 过，日志里就会留下痕迹（能区分「没被加载」与「加载了但激活失败」）。
trace('module imported');

/**
 * 公网二维码刚出、域名还没生效时的界面文案。
 *
 * 必须说"先别扫、等约 1 分钟"：quick tunnel 的临时子域是**动态建**的 DNS 记录，
 * 实测新域名在头 ~67 秒里是 NXDOMAIN（见 tools/measure-dns-window.mjs）。这段时间里
 * 手机扫码会在解析阶段失败，微信直接显示「无法打开页面」—— 而旧文案写的是
 * 「二维码现在就可以扫」，等于主动把用户送进这个坑里。
 */
export const PUBLIC_DNS_PENDING_MESSAGE =
  '公网隧道已建立。临时域名刚创建，DNS 记录通常要 30–90 秒才生效 —— 请等约 1 分钟再扫；'
  + '刚出码就扫会提示「无法打开页面」，那不是坏了。二维码一直有效，不必重新生成。';

/**
 * 把探针结论翻成给用户看的文案。
 *
 * 这里唯一的硬规则：**只有 `via === 'direct'` 才允许说"现在可以扫"**。
 * `via === 'edge'`（边缘 IP + SNI 回源）只证明隧道通到 Cloudflare 边缘，不证明临时
 * 子域的 DNS 记录已经存在 —— 拿着它说"已就绪、可以扫"，用户一扫就是「无法打开页面」。
 *
 * @param {{ ok?: boolean, via?: 'direct'|'edge', error?: string }} [ready] 探针结论
 * @returns {{ ready: boolean, message: string, lastError: string | null }}
 */
export function publicReadinessMessage(ready) {
  if (ready?.ok === true && ready.via === 'direct') {
    return {
      ready: true,
      message: '公网已就绪，现在可以扫码 —— 手机在 4G/5G 或任意网络都能打开。请勿把链接分享给他人。',
      lastError: null,
    };
  }
  if (ready?.ok === true) {
    return {
      ready: false,
      message: '公网隧道是通的，但本机没能确认域名已经生效（部分网络的解析器不解析 Cloudflare 临时子域，'
        + '这不代表手机也不行）。若扫码提示「无法打开页面」，请等 1 分钟后扫同一个二维码 —— 不必重新生成。',
      lastError: `公网探针未能确认域名生效（仅边缘回源可达）：${ready.error ?? '未给出原因'}`,
    };
  }
  return {
    ready: false,
    message: '公网隧道未能确认可达。请等 1 分钟后扫同一个二维码再试；仍旧不行的话，改用局域网模式更稳妥。',
    lastError: `公网探针未通过：${ready?.error ?? '未知原因'}`,
  };
}

/** Cordis 函数插件名。 */
export const name = 'dsh-mobile-remote';

/** 硬依赖：要挂 HTTP 路由，还要借 Connection 的信任判定与 token URL。 */
export const inject = ['webServer', 'connection'];

/**
 * 本插件的路由前缀。
 *
 * ⚠️ 这里**不能带尾斜杠**：宿主 WebServer 的 prefix 匹配规则是
 * `pathname === prefix || pathname.startsWith(prefix + '/')`，
 * 若 prefix 写成 `/mobile-remote/`，则拼出来是 `/mobile-remote//`，
 * 任何真实请求都匹配不上（当年就是这么 404 的）。
 */
const ROUTE_PREFIX = '/mobile-remote';

/** 请求体上限（enable 请求只有几个字段）。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 网卡探测的安全外壳。
 *
 * 它出现在**激活路径**上（构造初始状态时就要填 lanIps），所以绝不能抛：
 * 拿不到地址只是没法用局域网模式，不该把整个插件带崩。
 */
function safeLanIps() {
  try {
    return listLanIPv4();
  } catch {
    return [];
  }
}

/** 读出有界 UTF-8 请求体。 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.byteLength,
  });
  response.end(payload);
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 */
export function apply(ctx) {
  trace(`apply() entered; webServer=${typeof ctx.webServer} connection=${typeof ctx.connection}`);
  const log = (message) => {
    // 宿主 logger 可能缺席；绝不能让它把激活流程带崩。
    try {
      ctx.logger?.info?.(`[mobile-remote] ${message}`);
    } catch {
      /* 记日志失败不影响功能 */
    }
  };
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[mobile-remote] ${message}`);
    } catch {
      /* 同上 */
    }
  };
  // 注意顺序：这一行**故意放在路由注册之后**。激活期只允许做「不可能抛异常」的
  // 声明式准备，任何副作用（记日志、探测网卡、读环境）都不该挡在路由注册前面——
  // 一旦前面抛了，表现就是「界面有标签页、接口全 404」，而且宿主日志里什么都看不到。
  const announce = () => log(
    `已挂载：设置 → 手机连接；依赖就绪 webServer=${typeof ctx.webServer} connection=${typeof ctx.connection}`,
  );

  /** 对外可见的完整状态。 */
  const state = {
    phase: 'off',
    enabled: false,
    mode: 'lan',
    lanIps: safeLanIps(),
    selectedIp: null,
    proxyPort: null,
    targetPort: null,
    /** 不含 token 的基地址（用于展示） */
    baseUrl: null,
    /** 含一次性 token 的完整地址（二维码内容） */
    authUrl: null,
    publicUrl: null,
    provider: null,
    /** PNG data URL */
    qrPng: null,
    /** 登录票失效时的重新认证入口（手机端 401 中转页的按钮也指向它） */
    recoverPath: RELAY_PATH,
    message: '未开启',
    lastError: null,
    updatedAt: Date.now(),
  };

  let proxy = null;
  let tunnel = null;
  /**
   * 引导票（详见 lib/recover.js）：
   * - **每次开启连接重新生成**，关闭/切换/卸载即作废 —— 与二维码同寿命；
   * - 只往 `state` 里放「有没有」，密钥本身绝不进 JSON、不进日志、不出现在任何响应体里，
   *   它只以 HttpOnly cookie 的形式回到那台手机的浏览器里。
   * @type {{ secret: string } | null}
   */
  let bootTicket = null;
  /** 串行化 enable/disable，避免并发点按把代理和隧道搅乱。 */
  let queue = Promise.resolve();
  /**
   * 插件生命周期取消信号。
   *
   * 卸载时必须先中止在飞的下载与探针：公网模式的二进制下载最长 5 分钟、可达性探针最长
   * 180 秒，让它们自然结束会把宿主退出拖过 shell 的停机窗口，桌面端随即判定「任务未优雅
   * 收尾」并拒绝安装更新（取消支持见 lib/tunnel.js）。
   */
  const lifecycle = new AbortController();

  const serialize = (task) => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  function touch() {
    state.updatedAt = Date.now();
  }

  async function stop(reason) {
    if (tunnel) {
      const active = tunnel;
      tunnel = null;
      await active.stop();
    }
    if (proxy) {
      await proxy.stop();
      proxy = null;
    }
    // 恢复票随连接一起作废：不留任何「关掉还能换票」的窗口。
    bootTicket = null;
    state.phase = 'off';
    state.enabled = false;
    state.qrPng = null;
    state.baseUrl = null;
    state.authUrl = null;
    state.publicUrl = null;
    state.provider = null;
    state.proxyPort = null;
    state.selectedIp = null;
    state.lastError = null;
    state.message = reason ?? '已关闭手机连接';
    touch();
  }

  async function start({ mode, ip, port }) {
    const targetPort = ctx.webServer.port;
    if (!targetPort) throw new Error('DSH Web 端口尚未就绪');

    await stop('正在重新建立连接');

    state.mode = mode;
    state.phase = 'starting';
    state.targetPort = targetPort;
    state.message = mode === 'public' ? '正在建立公网隧道…' : '正在启动局域网代理…';
    touch();

    // 每次开启连接都换一张新的恢复票：它与二维码同寿命，关闭/切换即作废。
    bootTicket = { secret: mintBootSecret() };
    trace('boot ticket minted for this session');
    const instance = new RewriteProxy({ targetPort, log, boot: bootTicket });
    try {
      await instance.start({ port: Number.isInteger(port) && port > 0 ? port : 0 });
    } catch (error) {
      state.phase = 'error';
      state.lastError = `代理端口监听失败：${error.message}`;
      state.message = '无法监听代理端口';
      touch();
      throw error;
    }
    proxy = instance;
    state.proxyPort = instance.port;

    let base;
    try {
      if (mode === 'public') {
        const binPath = await ensureCloudflared(log, lifecycle.signal);
        const active = await startQuickTunnel({ binPath, port: instance.port, log, signal: lifecycle.signal });
        tunnel = active;
        state.provider = 'cloudflared';
        state.publicUrl = active.publicUrl;
        base = active.publicUrl;

        // 隧道是外部进程，断网/被墙/被回收都可能让它悄悄退出。没有看门狗的话，
        // 界面会一直显示「已连接」，而手机其实已经连不上了。
        void active.exited.then((code) => {
          if (tunnel !== active) return; // 已被正常关闭
          warn(`cloudflared 意外退出（code=${code}）`);
          trace(`cloudflared exited unexpectedly code=${code}`);
          void serialize(() => {
            if (tunnel !== active) return undefined;
            return stop('公网隧道已断开，请重新开启');
          }).then(() => {
            state.phase = 'error';
            state.lastError = `cloudflared 已退出（code=${code}）`;
            state.message = '公网隧道已断开，请重新开启或改用局域网模式';
            touch();
          });
        });

        // 探针**不要**在这里 await：quick tunnel 的临时子域 DNS 记录要几十秒才生效
        // （实测约 67 秒，见 tools/measure-dns-window.mjs）。若阻塞等待，二维码会迟迟
        // 不出，用户以为坏了。所以先把二维码交给用户，探针丢到后台慢慢轮询。
        // 但文案必须如实：这段时间**扫码一定失败**，要说清楚"等约 1 分钟"。
        state.message = PUBLIC_DNS_PENDING_MESSAGE;
        void (async () => {
          const ready = await waitForPublicReady(base, { log, timeoutMs: 180_000, signal: lifecycle.signal });
          if (tunnel !== active || lifecycle.signal.aborted) return; // 期间已被关闭 / 插件正在卸载
          const verdict = publicReadinessMessage(ready);
          state.message = verdict.message;
          state.lastError = verdict.lastError;
          if (verdict.ready) {
            log(`公网探针通过（HTTP ${ready.status}，直连，域名已生效）`);
          } else {
            // 措辞很重要：探针没通过 ≠ 手机一定连不上。这台机器解析不到临时子域是常态，
            // 手机用的是它自己的 DNS。所以给"未能确认"+ 可照做的动作，不喊"失效"。
            warn(`公网探针未确认域名生效：${ready.error ?? '仅边缘回源可达'}`);
            trace(`public probe not confirmed: ${ready.error ?? 'edge-only'}`);
          }
          touch();
        })();
      } else {
        const ips = safeLanIps();
        state.lanIps = ips;
        if (ips.length === 0) throw new Error('未找到可用的局域网 IPv4，请改用公网连接');
        const selected = ip && ips.includes(ip) ? ip : ips[0];
        state.selectedIp = selected;
        base = `http://${selected}:${instance.port}`;
        state.message = '手机需与电脑在同一 Wi-Fi 下扫码；链接含登录令牌，请勿分享。';
      }

      // 用官方 Connection 生成带 token 的入口地址：token 由 DSH 自己校验并下发
      // 会话 cookie，业务鉴权始终在 DSH 里。插件唯一持有的秘密是**自己签发的恢复票**
      // （上面 mintBootSecret()，仅用于在 DSH cookie 失效后重新换一次票），
      // 它不参与 DSH 的鉴权判断，也无法伪造 DSH 的会话 cookie。
      const authUrl = ctx.connection.authenticatedUrl(`${base}/`);
      state.baseUrl = base;
      state.authUrl = authUrl;
      state.qrPng = qrPngDataUrl(authUrl, { scale: 6, margin: 3 });
      state.enabled = true;
      state.phase = 'on';
    } catch (error) {
      await stop('建立连接失败');
      state.phase = 'error';
      state.lastError = error instanceof Error ? error.message : String(error);
      state.message = '连接建立失败，可改用另一种模式重试';
      touch();
      throw error;
    }

    touch();
    log(`已开启（${mode}）：${state.baseUrl}`);
  }

  /** 与官方 /api 路由完全同一套信任判定。 */
  function rejected(request, response) {
    const rejection = ctx.connection.requestRejection(request);
    if (rejection === undefined) return false;
    response.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(rejection === 401 ? 'unauthorized' : 'forbidden');
    return true;
  }

  /**
   * 发「重新认证」中转页。
   *
   * 这页**必须未认证可达**：它出现的时刻，正是手机没有（或没带）DSH cookie 的时刻；
   * 若也走 `requestRejection`，就变成「401 页要求你先认证」，死循环。
   * 页面本身是纯静态文案 + 一个同源链接，不含 token、不含内部状态，外泄无害。
   *
   * @param {import('node:http').ServerResponse} response
   * @param {{ note?: string, redeemable?: boolean }} [options] 传了 `note` 就说明
   *   「换票已知不可能」（没票 / 连接没在运行），此时页面不再给按钮 ——
   *   一个点了必然回到原页的按钮比没有按钮更糟。
   */
  function sendRelayPage(response, options = {}) {
    const body = Buffer.from(relayPageHtml(options), 'utf8');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.byteLength,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    response.end(body);
  }

  /**
   * 换票：拿着有效的恢复票，换回一条带 token 的入口地址。
   *
   * 为什么能省掉第二次扫码：DSH 的 token 是**进程级常量**（不是一次性的），
   * 所以 `ctx.connection.authenticatedUrl()` 随时可以再拼一次，由 DSH 自己 303 + 下发 cookie。
   * 前提是「这台手机确实曾经过认证」——这就是恢复票的作用。
   *
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  function redeem(request, response) {
    if (state.phase !== 'on' || typeof state.authUrl !== 'string' || bootTicket === null) {
      sendRelayPage(response, {
        note: `手机连接现在没在运行（${state.message}）。请到桌面端「设置 → 手机连接」重新开启并扫码。`,
        redeemable: false,
      });
      return;
    }
    if (!requestHasBootTicket(request.headers.cookie, bootTicket.secret)) {
      sendRelayPage(response, {
        note: '这台手机上的「恢复票」也不在了（微信清过缓存、换过浏览器，或连接重开过），只能重新扫一次桌面端的二维码。',
        redeemable: false,
      });
      return;
    }
    // 只把带 token 的地址交给持票者；不写日志、不回显，避免 token 进日志/截屏。
    response.writeHead(302, {
      location: state.authUrl,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    response.end();
    log('恢复票校验通过：已重新下发入口地址（手机端无需扫码）');
  }

  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://dsh.invalid');
      const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '');

      // ⚠️ 顺序是有意的：自愈入口排在 cookie 校验之前。
      // 它们派上用场的时刻，恰恰是「手机没有 DSH cookie」的时刻。
      if (request.method === 'GET' && action === 'relay') {
        sendRelayPage(response);
        return;
      }
      if (request.method === 'GET' && action === 'redeem') {
        redeem(request, response);
        return;
      }

      if (rejected(request, response)) return;

      try {
        if (request.method === 'GET' && action === 'status') {
          sendJson(response, 200, { ...state, lanIps: safeLanIps() });
          return;
        }
        if (request.method === 'POST' && action === 'enable') {
          const body = await readJsonBody(request);
          const mode = body.mode === 'public' ? 'public' : 'lan';
          // 公网模式要下载 cloudflared（可能数分钟），绝不能把 HTTP 请求挂在那里：
          // 立刻置「启动中」并返回，前端改为轮询 /status。
          state.mode = mode;
          state.phase = 'starting';
          state.message = mode === 'public' ? '正在建立公网隧道…' : '正在启动局域网代理…';
          state.lastError = null;
          touch();
          void serialize(() =>
            start({
              mode,
              ip: typeof body.ip === 'string' ? body.ip : undefined,
              port: Number(body.port),
            }),
          ).catch((error) => {
            warn(`开启失败：${error instanceof Error ? error.message : String(error)}`);
          });
          sendJson(response, 200, { ...state });
          return;
        }
        if (request.method === 'POST' && action === 'disable') {
          await serialize(() => stop('已关闭手机连接'));
          sendJson(response, 200, { ...state });
          return;
        }
        sendJson(response, 404, { error: `未知操作 ${action}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(`请求处理失败：${message}`);
        sendJson(response, 500, { ...state, error: message });
      }
    },
  };

  ctx.effect(() => ctx.webServer.register(route), 'dsh-mobile-remote: /mobile-remote 路由');
  trace('route registered at /mobile-remote (prefix, no trailing slash)');
  announce();

  ctx.effect(
    () => () => {
      // 插件卸载 / DSH 退出：先中止在飞的下载与探针，再收回监听端口与 cloudflared 子进程。
      //
      // 这里**必须把清理 promise 交回宿主**（不能 `void`）：宿主只有在插件树真正清理完成
      // 之后才会退出；若清理还在后台跑，宿主的停机窗口会被顶穿，桌面端会判成「任务未优雅
      // 收尾」并拒绝安装更新。上面的中止信号保证这个 promise 很快落地。
      lifecycle.abort();
      trace('teardown: ctx.effect disposer called');
      return serialize(() => stop('插件已卸载')).then((value) => {
        trace('teardown: cleanup resolved');
        return value;
      });
    },
    'dsh-mobile-remote: 停机清理',
  );
}

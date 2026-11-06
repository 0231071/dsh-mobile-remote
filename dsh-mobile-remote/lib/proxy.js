/**
 * 头部改写反向代理（TCP 层，零依赖）。
 *
 * 为什么必须有它：官方 `dsh web` 出于安全**刻意拒绝** `--host 0.0.0.0`
 * （见 dsh web 的启动报错文案），所以「手机访问」不能靠改绑定地址实现，
 * 只能在本机再开一个监听在 0.0.0.0 的代理，把流量转给 127.0.0.1 上的 DSH。
 *
 * 代理做三件关键的事（缺一不可）：
 *  1. `Host` 改写为回环地址 —— DSH 的 Connection 会按 Host 判定「是否可信来源」，
 *     并把浏览器 cookie **绑定到该 authority**；代理每次都以同一个回环 authority
 *     转发，手机侧的 cookie 才能稳定命中（见 dsh-client-connection 的
 *     `requestAuthority` / `cookieName`）。
 *  2. `Origin` / `Referer` 改写为回环源 —— 否则 Host/Origin 校验会拒。
 *  3. 双向全双工转发 —— 会话流式输出与 WebSocket 升级都需要（会话流是长连接，
 *     一旦被改成「一问一答」就会卡死）。
 *
 * 非升级请求会强制 `Connection: close`：这样一条连接只承载一个请求，
 * 避免 keep-alive 复用连接时第二个请求的 Host 没被改写。
 *
 * 除请求头改写，代理还负责两件**响应侧**的事（见 lib/recover.js 里的取舍说明）：
 *  - DSH 刚认证成功（302/303 + 它自己的 `dsh-auth-*` cookie）时，顺手给这台手机补一张
 *    插件的「引导票」`dsh-mobile-boot`；只对 DSH 已认证的响应注入，未认证访客永远拿不到。
 *  - **文档**请求被 401 掉时，把这个响应换成会解释、带按钮的重新认证中转页，而不是让
 *    手机上只剩一行 `dsh web authentication required; reopen the URL printed by dsh web.`。
 *    只换文档（`sec-fetch-dest: document` / `Accept: text/html`），接口和静态资源的 401
 *    原样透传 —— 客户端自己会处理它们，塞一份 HTML 进去只会更难排查。
 */

import net from 'node:net';

import {
  REDEEM_PATH,
  bootCookieSetCookie,
  relayPageHtml,
  requestHasBootTicket,
  requestIsRetrying,
} from './recover.js';

const MAX_HEAD_BYTES = 64 * 1024;

/**
 * 判断 DSH 刚下发了自己的会话 cookie（auth 成功的那一刻）。
 *
 * 只认 `dsh-auth-` 前缀：那是 `BrowserAuth` 里 `COOKIE_PREFIX` 的固定拼法。若 DSH 以后换名，
 * 这里会静默不再注入引导票 —— 后果是「中转页的按钮点了也救不回来，仍然要扫码」，
 * 属于优雅降级，不会误伤正常使用。
 */
const DSH_AUTH_SET_COOKIE = /(?:^|\r\n)set-cookie:\s*dsh-auth-/i;

/** 该请求是不是一次「文档导航」（只有文档才值得换上中转页）。 */
function isDocumentNavigation(requestText) {
  if (!/^(?:GET|POST)\s/.test(requestText)) return false;
  if (/(?:^|\r\n)sec-fetch-dest:\s*document\b/i.test(requestText)) return true;
  return /(?:^|\r\n)accept:[^\r\n]*text\/html/i.test(requestText);
}

/** 从**请求**头文本里取某个头的值（只用于 Cookie，够用即可）。 */
function requestHeaderValue(requestText, name) {
  const pattern = new RegExp(`(?:^|\\r\\n)${name}:\\s*([^\\r\\n]*)`, 'i');
  const match = pattern.exec(requestText);
  return match === null ? undefined : match[1].trim();
}

/** 组装「自动换票」的重定向响应（同源跳到换票入口）。 */
function redeemRedirect() {
  return Buffer.from([
    'HTTP/1.1 302 Found',
    `location: ${REDEEM_PATH}`,
    'cache-control: no-store',
    'referrer-policy: no-referrer',
    'content-length: 0',
    'connection: close',
    '',
    '',
  ].join('\r\n'), 'latin1');
}

/** 从响应头文本里取状态码（取不到就给 0，调用方一律按「不处理」对待）。 */
function responseStatus(headText) {
  const line = headText.slice(0, headText.indexOf('\r\n') === -1 ? headText.length : headText.indexOf('\r\n'));
  const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(line);
  return match === null ? 0 : Number(match[1]);
}

/** 组装「重新认证」响应（状态仍是 401：语义没变，只是把话说清楚了）。 */
function relayResponse() {
  const body = Buffer.from(relayPageHtml(), 'utf8');
  const head = [
    'HTTP/1.1 401 Unauthorized',
    'content-type: text/html; charset=utf-8',
    `content-length: ${body.byteLength}`,
    'cache-control: no-store',
    'referrer-policy: no-referrer',
    "content-security-policy: default-src 'none'; style-src 'unsafe-inline'",
    'connection: close',
    '',
    '',
  ].join('\r\n');
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}

/** 把 Referer 的 scheme+authority 换成回环，路径与查询串保留。 */
function rewriteReferer(value, authority) {
  try {
    const url = new URL(value);
    return `http://${authority}${url.pathname}${url.search}`;
  } catch {
    return `http://${authority}/`;
  }
}

/**
 * 改写一个请求头块。
 * @param {Buffer} head 含结尾 CRLFCRLF 的原始头块。
 * @param {string} authority 回环 authority，如 `127.0.0.1:3080`。
 * @returns {Buffer} 改写后的头块（含结尾 CRLFCRLF）。
 */
function rewriteHead(head, authority) {
  const lines = head.toString('latin1').split('\r\n');
  const out = [];
  let sawHost = false;
  let upgrade = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    if (i === 0) {
      out.push(line); // 请求行原样保留
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      out.push(line);
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (name === 'host') {
      out.push(`Host: ${authority}`);
      sawHost = true;
      continue;
    }
    if (name === 'origin') {
      out.push(`Origin: http://${authority}`);
      continue;
    }
    if (name === 'referer') {
      out.push(`Referer: ${rewriteReferer(value, authority)}`);
      continue;
    }
    if (name === 'proxy-connection') continue;
    if (name === 'connection') {
      if (/upgrade/i.test(value)) upgrade = true;
      continue; // 连接语义由下面统一重建
    }
    if (name === 'upgrade') {
      if (/websocket/i.test(value)) upgrade = true;
      out.push(line);
      continue;
    }
    out.push(line);
  }

  if (!sawHost) out.push(`Host: ${authority}`);
  // 升级请求必须保留 Upgrade 语义；其余强制单请求一连接。
  out.push(upgrade ? 'Connection: Upgrade' : 'Connection: close');

  return Buffer.from(`${out.join('\r\n')}\r\n\r\n`, 'latin1');
}

/**
 * 头部改写反向代理实例。
 */
export class RewriteProxy {
  /**
   * @param {{
   *   targetHost?: string,
   *   targetPort: number,
   *   log?: (msg: string) => void,
   *   boot?: { secret: string, maxAgeSeconds?: number } | null,
   * }} options `boot` 缺省表示「不签发引导票」（此时 401 文档仍会被换成中转页，
   *   只是按钮换不出票来 —— 用来对齐「连接没开」的边界情况）。
   */
  constructor(options) {
    this.targetHost = options.targetHost ?? '127.0.0.1';
    this.targetPort = options.targetPort;
    this.authority = `${this.targetHost}:${this.targetPort}`;
    this.log = options.log ?? (() => {});
    this.boot = options.boot ?? null;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.closed = false;
  }

  /**
   * 开始监听。
   * @param {{ host?: string, port?: number }} [options] 默认监听全网卡、随机端口。
   * @returns {Promise<number>} 实际监听端口。
   */
  async start(options = {}) {
    if (this.server) throw new Error('dsh-mobile-remote: 代理已在运行');
    const host = options.host ?? '0.0.0.0';
    const port = options.port ?? 0;

    const server = net.createServer((client) => this.#handle(client));
    this.server = server;

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

    server.on('error', (error) => this.log(`代理错误：${error.message}`));
    this.port = server.address().port;
    this.log(`代理监听 ${host}:${this.port} → ${this.authority}`);
    return this.port;
  }

  /** 关闭代理并断开所有活动连接。 */
  async stop() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  #handle(client) {
    this.sockets.add(client);
    client.on('error', () => client.destroy());

    let pending = Buffer.alloc(0);
    let headDone = false;
    /** @type {import('node:net').Socket | null} */
    let upstream = null;
    /** 本次请求是不是文档导航（决定 401 要不要换成中转页）。 */
    let documentRequest = false;
    /** 本次请求是 HEAD 吗（HEAD 不许带响应体，换页面会让浏览器困惑）。 */
    let headRequest = false;
    /** 响应头是否已经解析并转发。 */
    let responseHeadDone = false;
    /** 已接管本次响应：此后上游字节一律丢弃，不再转发。 */
    let intercepted = false;
    /** 还没凑齐 CRLFCRLF 的响应头。 */
    let responseBuffer = Buffer.alloc(0);

    /** 往手机侧写；背压时暂停上游（与请求方向同一套纪律）。 */
    const writeOut = (data) => {
      if (intercepted) return;
      if (!client.write(data)) {
        upstream?.pause();
        client.once('drain', () => upstream?.resume());
      }
    };

    // 任一端断开都必须把另一端一起收掉：手机侧切网/息屏会直接掉连接，
    // 若只关客户端，上游到 DSH 的 socket 会永远挂着（长连接泄漏）。
    client.on('close', () => {
      this.sockets.delete(client);
      upstream?.destroy();
    });

    client.on('data', (chunk) => {
      if (headDone) {
        if (upstream && !upstream.write(chunk)) {
          client.pause();
          upstream.once('drain', () => client.resume());
        }
        return;
      }

      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) {
        if (pending.length > MAX_HEAD_BYTES) {
          this.log('请求头过大，已断开');
          client.destroy();
        }
        return;
      }

      const requestText = pending.subarray(0, end + 4).toString('latin1');
      documentRequest = isDocumentNavigation(requestText);
      headRequest = /^HEAD\s/.test(requestText);

      const head = rewriteHead(pending.subarray(0, end + 4), this.authority);
      const rest = pending.subarray(end + 4);
      pending = Buffer.alloc(0);
      headDone = true;

      upstream = net.connect(this.targetPort, this.targetHost);
      upstream.on('error', (error) => {
        this.log(`上游连接失败：${error.message}`);
        client.destroy();
        upstream?.destroy();
      });
      // 上游收尾时用 end() 而不是 destroy()：把已入队的响应字节刷完再发 FIN，
      // destroy() 会直接丢包（长响应/SSE 尾段会截断）。
      upstream.on('close', () => {
        if (!intercepted) client.end();
      });
      upstream.on('data', (data) => {
        if (intercepted) return;

        if (!responseHeadDone) {
          responseBuffer = responseBuffer.length === 0 ? data : Buffer.concat([responseBuffer, data]);
          const headEnd = responseBuffer.indexOf('\r\n\r\n');
          if (headEnd < 0) {
            if (responseBuffer.length <= MAX_HEAD_BYTES) return; // 继续等
            // 响应头异常大：放弃解析、原样透传。宁可少一个功能，也不能吞掉字节。
            responseHeadDone = true;
            const raw = responseBuffer;
            responseBuffer = Buffer.alloc(0);
            writeOut(raw);
            return;
          }

          const headText = responseBuffer.subarray(0, headEnd).toString('latin1');
          const tail = responseBuffer.subarray(headEnd + 4);
          responseBuffer = Buffer.alloc(0);
          responseHeadDone = true;
          const status = responseStatus(headText);

          // ① DSH 刚刚认证成功：顺手补一张本插件的「恢复票」，让这台手机以后能自己换票。
          if (this.boot !== null && status >= 300 && status < 400 && DSH_AUTH_SET_COOKIE.test(headText)) {
            // 注意这行是**原始头行**：`bootCookieSetCookie()` 只给 cookie 本身（`名=值; 属性…`），
            // 头名 `Set-Cookie:` 必须自己拼上——少了它 llhttp 会直接判 HPE_INVALID_HEADER_TOKEN。
            const cookie = `Set-Cookie: ${bootCookieSetCookie(this.boot.secret, this.boot)}`;
            writeOut(Buffer.from(`${headText}\r\n${cookie}\r\n\r\n`, 'latin1'));
            if (tail.length > 0) writeOut(tail);
            return;
          }

          // ② 文档被 401 掉：
          //    · 手机上还有本插件的恢复票、且不是「刚试过一次」→ 直接自动换票，
          //      用户连按钮都不用点（这是「DSH 重启后手机端零操作恢复」的关键一环）；
          //    · 否则给中转页（状态码仍是 401，语义不变）。
          if (documentRequest && !headRequest && status === 401) {
            const cookieHeader = requestHeaderValue(requestText, 'cookie');
            const canAutoRecover = this.boot !== null
              && !requestIsRetrying(cookieHeader)
              && requestHasBootTicket(cookieHeader, this.boot.secret);
            intercepted = true;
            upstream?.destroy();
            if (canAutoRecover) {
              client.end(redeemRedirect());
              this.log('文档请求未认证：持恢复票，已自动换票');
            } else {
              client.end(relayResponse());
              this.log('文档请求未认证：已换成「重新认证」中转页');
            }
            return;
          }

          writeOut(Buffer.from(`${headText}\r\n\r\n`, 'latin1'));
          if (tail.length > 0) writeOut(tail);
          return;
        }

        writeOut(data);
      });

      upstream.write(head);
      if (rest.length > 0) upstream.write(rest);
    });
  }
}

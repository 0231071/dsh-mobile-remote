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
 */

import net from 'node:net';

const MAX_HEAD_BYTES = 64 * 1024;

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
   * @param {{ targetHost?: string, targetPort: number, log?: (msg: string) => void }} options
   */
  constructor(options) {
    this.targetHost = options.targetHost ?? '127.0.0.1';
    this.targetPort = options.targetPort;
    this.authority = `${this.targetHost}:${this.targetPort}`;
    this.log = options.log ?? (() => {});
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
      upstream.on('close', () => client.end());
      upstream.on('data', (data) => {
        if (!client.write(data)) {
          upstream.pause();
          client.once('drain', () => upstream.resume());
        }
      });

      upstream.write(head);
      if (rest.length > 0) upstream.write(rest);
    });
  }
}

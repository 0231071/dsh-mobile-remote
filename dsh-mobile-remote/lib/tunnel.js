/**
 * cloudflared 公网快速隧道管理（互联网访问模式）。
 *
 * 为什么选 cloudflared quick tunnel：trycloudflare.com 是免登录临时域名，
 * 原生支持 WebSocket / SSE，能把手机流量直通到本机代理，无需公网 IP、无需
 * 路由器端口映射、无需备案。loca.lt 之类有反滥用拦截页且长连接不稳，故只留
 * cloudflared 一条路（失败时明确报错，而不是静默降级到体验很差的通道）。
 *
 * 二进制获取顺序：PATH → 受管目录（已下载过）→ 官方 GitHub Release 下载。
 */

import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const URL_TIMEOUT_MS = 90 * 1000;
const TRYCLOUDFLARE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

/** 停止隧道时等待子进程退出的上限：超过就放弃等待，绝不把宿主退出无限期拖住。 */
const TUNNEL_STOP_GRACE_MS = 3_000;

/**
 * 把插件生命周期的取消信号转发到一个内部 controller 上。
 *
 * 这里显式转发而不是用 `AbortSignal.any`：本包 engines 是 `>=20`，而它要 Node 20.3 才有。
 *
 * @param {AbortController} controller 内部 controller
 * @param {AbortSignal} [signal] 外部取消信号
 * @returns {() => void} 解除转发
 */
function linkAbort(controller, signal) {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * 可取消的等待：取消时立即返回，而不是等满时长。
 *
 * @param {number} milliseconds 等待时长
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<void>}
 */
function sleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 受管二进制目录：`$DSH_HOME/mobile-remote/bin`。 */
export function managedBinDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'mobile-remote', 'bin');
}

function binaryName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** 在 PATH 里找一个可执行文件（不额外起进程，避免沙箱下的 spawn 限制）。 */
function findOnPath(name) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/** 按平台/架构选官方 Release 资源。 */
function releaseAsset() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    return arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  }
  throw new Error(`dsh-mobile-remote: 暂不支持的平台 ${platform}/${arch}`);
}

async function download(asset, destination, log, signal) {
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  log(`正在下载 cloudflared（${asset}）…`);
  const controller = new AbortController();
  const unlink = linkAbort(controller, signal);
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`下载 cloudflared 失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1_000_000) throw new Error(`下载的 cloudflared 体积异常（${bytes.length} 字节）`);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, bytes);
    log(`cloudflared 已就位（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`);
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/** 从 .tgz 里解出 cloudflared（仅 macOS 需要）。 */
async function extractTgz(archive, destination, log) {
  const dir = path.dirname(destination);
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', dir], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 解包失败（退出码 ${code}）`))));
  });
  const extracted = path.join(dir, 'cloudflared');
  await fsp.rename(extracted, destination);
  await fsp.chmod(destination, 0o755);
  await fsp.rm(archive, { force: true });
  log('cloudflared 已从 tgz 解出');
}

/**
 * 保证有一个可用的 cloudflared 可执行文件。
 * @param {(message: string) => void} log
 * @param {AbortSignal} [signal] 插件生命周期取消信号；取消时中止下载
 * @returns {Promise<string>} 可执行文件路径
 */
export async function ensureCloudflared(log = () => {}, signal) {
  const name = binaryName();
  const onPath = findOnPath(name);
  if (onPath) {
    log(`使用 PATH 中的 cloudflared：${onPath}`);
    return onPath;
  }

  const destination = path.join(managedBinDir(), name);
  try {
    const stat = await fsp.stat(destination);
    if (stat.size > 1_000_000) {
      log(`使用受管 cloudflared：${destination}`);
      return destination;
    }
  } catch {
    /* 需要下载 */
  }

  const asset = releaseAsset();
  const target = asset.endsWith('.tgz') ? path.join(managedBinDir(), 'cloudflared.tgz') : destination;
  await download(asset, target, log, signal);
  if (asset.endsWith('.tgz')) {
    await extractTgz(target, destination, log);
  } else if (process.platform !== 'win32') {
    await fsp.chmod(destination, 0o755);
  }
  return destination;
}

/**
 * 起一条 quick tunnel 指向本机代理端口。
 *
 * @param {{ binPath: string, port: number, log?: (message: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ publicUrl: string, stop: () => Promise<void>, exited: Promise<number|null> }>}
 */
export async function startQuickTunnel(options) {
  const log = options.log ?? (() => {});
  const signal = options.signal;
  const args = [
    'tunnel',
    '--url',
    `http://127.0.0.1:${options.port}`,
    '--no-autoupdate',
  ];

  const child = spawn(options.binPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderrTail = '';
  let settled = false;

  const publicUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error(`cloudflared 在 ${URL_TIMEOUT_MS / 1000}s 内未返回公网地址`));
    }, URL_TIMEOUT_MS);

    const exited = (code, signal) => {
      finish(new Error(`cloudflared 提前退出（code=${code} signal=${signal}）：${stderrTail.trim().split('\n').slice(-3).join(' | ')}`));
    };
    // 插件卸载时必须立刻放弃等待：否则这个 90s 的地址等待会顶穿宿主停机窗口。
    const onAbort = () => finish(new Error('已取消：插件正在卸载'));
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', exited);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        // 取消与失败都不能把 cloudflared 留在系统里：子进程的 stdio 管道会钉住宿主进程。
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        reject(error);
      } else resolve(url);
    };

    const scan = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      if (isErr) stderrTail = (stderrTail + text).slice(-4000);
      const match = TRYCLOUDFLARE.exec(text);
      if (match) {
        log(`公网隧道就绪：${match[0]}`);
        finish(null, match[0]);
      }
    };

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => scan(chunk, false));
    child.stderr.on('data', (chunk) => scan(chunk, true));
    child.on('error', (error) => finish(new Error(`无法启动 cloudflared：${error.message}`)));
    child.on('exit', exited);
  });

  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
  });

  return {
    publicUrl,
    exited,
    /**
     * 停掉隧道并等子进程真正退出。
     *
     * 必须等到退出：cloudflared 的 stdout/stderr 管道是宿主进程持有的句柄，子进程还在跑
     * （或管道尚未关闭）时宿主事件循环不会排空，桌面端就会把停机判成「未优雅收尾」并
     * 拒绝安装更新。
     *
     * @returns {Promise<void>} 子进程退出，或等待超过 TUNNEL_STOP_GRACE_MS
     */
    stop: async () => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      await Promise.race([exited, sleep(TUNNEL_STOP_GRACE_MS)]);
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

/**
 * 把 fetch 的报错还原成人能看懂的原因码。
 *
 * undici 只会抛一句 `TypeError: fetch failed`，真正的原因藏在 `error.cause`
 * （ENOTFOUND / ECONNREFUSED / 证书错误…）。不把它挖出来，"fetch failed" 就是
 * 一句没法排查的废话 —— 用户第一次报的就是这个。
 */
function describeFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code ?? cause?.errno;
  const detail = cause?.message ?? error?.message ?? String(error);
  return code ? `${code}（${detail}）` : detail;
}

/**
 * 绕开本机 DNS 的兜底探针：解析 Cloudflare 边缘 IP，再用 SNI/Host 指定隧道域名直连。
 *
 * 为什么需要它：「隧道对公网是否可用」取决于 Cloudflare 边缘有没有把该域名的请求
 * 回源到本机 —— 这与**本机解析器能不能解析这个临时子域**是两件事。实测这台机器的
 * DNS 连公共解析器都不可达，用本机 DNS 当判据会把"隧道其实是好的"误判成失败。
 */
async function probeViaEdge(baseUrl, log, signal) {
  if (signal?.aborted) return { ok: false, error: '已取消（插件正在卸载）' };
  const host = new URL(baseUrl).hostname;
  let edgeIp = null;
  try {
    // apex 域在本机是可解析的（动态子域才不一定），用它拿 Cloudflare 边缘 IP。
    edgeIp = (await dns.lookup('trycloudflare.com')).address;
  } catch (error) {
    return { ok: false, error: `无法解析 Cloudflare 边缘 IP：${describeFetchError(error)}` };
  }

  return new Promise((resolve) => {
    const settle = (value) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      request.destroy();
      settle({ ok: false, error: '已取消（插件正在卸载）' });
    };
    const request = https.request({
      host: edgeIp,
      port: 443,
      servername: host, // SNI 必须是隧道域名，证书才匹配
      path: '/',
      method: 'GET',
      headers: { host },
      timeout: 15_000,
    }, (response) => {
      response.resume();
      log(`公网探针（边缘回源 ${edgeIp}）HTTP ${response.statusCode}`);
      // 5xx 是 Cloudflare 自己吐的错误页（530 = 边缘连不上源站 / 隧道还没接上），
      // 它同样"有 HTTP 响应"，但手机打开只会看到 Cloudflare 的错误页。
      // 只有 <500 才说明请求真的走到了本机 DSH。
      settle(response.statusCode < 500
        ? { ok: true, status: response.statusCode }
        : { ok: false, error: `边缘回源得到 HTTP ${response.statusCode}（Cloudflare 错误页，源站未就绪）` });
    });
    request.on('error', (error) => settle({ ok: false, error: describeFetchError(error) }));
    request.on('timeout', () => { request.destroy(); settle({ ok: false, error: '边缘回源超时' }); });
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end();
  });
}

/**
 * 轮询公网地址，直到**手机真的能打开**：临时子域已进入 DNS（direct 成功），
 * 且响应不是 Cloudflare 自己的错误页（status < 500）。
 *
 * 两条路，但它们的证据强度完全不同，绝不能一视同仁：
 *  1. `direct`：直接按域名访问 —— 成功即证明临时子域的 DNS 记录已经生效，
 *     **这正是手机扫码所需要的那件事**；
 *  2. `edge`：解析 Cloudflare 边缘 IP，再用 SNI/Host 指定隧道域名直连 —— 只证明
 *     「边缘能把该 Host 回源到本机」，**不证明 DNS 记录存在**。
 *
 * ⚠️ 因此这里**只在 direct 成功时提前返回**，edge 成功只记录、继续等 direct。
 * 早期版本在 edge 成功时就立刻返回 `via:'edge'`，于是：
 *   隧道刚建好（约 5 秒）→ edge 探针成功 → 界面宣告「公网已就绪，手机可以扫」，
 * 而此刻新域名还处于 NXDOMAIN 状态（实测约 67 秒才进入 DNS）。用户一看"已就绪"
 * 就扫码，手机在解析阶段直接失败 —— 微信/浏览器显示的就是「无法打开页面」。
 * 探针提前收工还导致界面**永久**停在"已就绪"，用户无从知道该再等一会儿。
 *
 * 未带 token 的根路径会被 DSH 回 401，这恰好是最合适的探针：它证明
 * 「公网 → cloudflared → 本机代理 → DSH」整条链路已经打通。
 *
 * @param {string} baseUrl
 * @param {{
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   log?: (message: string) => void,
 *   signal?: AbortSignal,
 *   probeDirect?: (baseUrl: string) => Promise<{ ok: boolean, status?: number, error?: string }>,
 *   probeEdge?: (baseUrl: string) => Promise<{ ok: boolean, status?: number, error?: string }>,
 * }} [options] 两个探针可注入：单元测试用它把"边缘先成功、DNS 后生效"这个时序
 *   确定性地摆出来（这条时序就是线上真实事故的成因）。
 * @returns {Promise<{ ok: boolean, status?: number, via?: 'direct'|'edge', error?: string }>}
 *   `via:'edge'` 表示"隧道通、但本机没能确认域名已生效"，调用方必须如实转述，
 *   不能当成"可以扫了"。
 */
export async function waitForPublicReady(baseUrl, options = {}) {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 3000;
  const signal = options.signal;
  const probeDirect = options.probeDirect ?? ((url) => probeDirectFetch(url, log, signal));
  const probeEdge = options.probeEdge ?? ((url) => probeViaEdge(url, log, signal));
  const deadline = Date.now() + timeoutMs;
  let directError = '尚未尝试';
  let edgeError = '尚未尝试';
  /** @type {{ status?: number } | null} */
  let edgeHit = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, error: '已取消（插件正在卸载）' };

    const direct = await probeDirect(baseUrl);
    if (signal?.aborted) return { ok: false, error: '已取消（插件正在卸载）' };
    if (direct.ok) return { ok: true, status: direct.status, via: 'direct' };
    directError = direct.error ?? '未知原因';

    // 边缘回源只当兜底信号，约每 12 秒复核一次，绝不据此提前返回。
    if (edgeHit === null && attempt % 4 === 0) {
      const edge = await probeEdge(baseUrl);
      if (signal?.aborted) return { ok: false, error: '已取消（插件正在卸载）' };
      if (edge.ok) edgeHit = { status: edge.status };
      else edgeError = edge.error ?? '未知原因';
    }

    attempt++;
    await sleep(intervalMs, signal);
  }

  if (edgeHit !== null) return { ok: true, status: edgeHit.status, via: 'edge' };
  return { ok: false, error: `直连失败：${directError}；边缘回源失败：${edgeError}` };
}

/**
 * 直连探针：按域名访问隧道（成功即证明 DNS 记录已生效 **且** 请求真的走到了 DSH）。
 *
 * 导出只是为了能被单元测试用本地假源站直接验（5xx 必须判为"未就绪"这条规则，
 * 用真隧道很难稳定复现，而它正是"手机看到 Cloudflare 错误页"的成因）。
 *
 * @param {string} baseUrl
 * @param {(message: string) => void} log
 * @param {AbortSignal} [signal] 插件生命周期取消信号
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function probeDirectFetch(baseUrl, log = () => {}, signal) {
  // 单次探针的 10s 上限与插件生命周期取先到者：卸载时立刻放弃这次请求。
  const probe = new AbortController();
  const unlink = linkAbort(probe, signal);
  const probeTimer = setTimeout(() => probe.abort(), 10_000);
  try {
    const response = await fetch(baseUrl, { redirect: 'manual', signal: probe.signal });
    if (response.status >= 500) {
      // 域名解析已经开始生效，但边缘还连不上源站（典型 530/502）：手机此刻打开
      // 只会看到 Cloudflare 的错误页，所以**还不能**说"可以扫"。
      log(`公网探针 HTTP ${response.status}（直连已通，但源站/隧道尚未就绪）`);
      return { ok: false, error: `直连得到 HTTP ${response.status}（Cloudflare 错误页，源站未就绪）` };
    }
    log(`公网探针 HTTP ${response.status}（直连，域名已生效）`);
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: describeFetchError(error) };
  } finally {
    clearTimeout(probeTimer);
    unlink();
  }
}

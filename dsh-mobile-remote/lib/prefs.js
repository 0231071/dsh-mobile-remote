/**
 * 跨重启的偏好与长期入口密钥：`$DSH_HOME/mobile-remote/state.json`。
 *
 * 为什么需要持久化（这是用户提的实际问题）：
 *  - DSH 一重启，宿主的监听端口、登录令牌、以及我们自己的代理端口/隧道域名全都换新，
 *    于是「刚才那个二维码」必然作废，手机得重扫；而且功能默认是关的，还得回桌面点开。
 *  - 用户的诉求是「重启后自动开启，且原来的二维码仍然有效」。
 *
 * 要做到这一点，必须在磁盘上留下三样东西：
 *  1. **上次的状态**（模式 / 网卡地址 / 代理端口），用来重启后原样拉起；
 *  2. **长期入口密钥** `entryKey` —— 二维码里放的不再是 DSH 的进程令牌，而是这个；
 *     真到用时由 `/mobile-remote/enter?k=…` 在**请求那一刻**换出当时的令牌。
 *     这样二维码字符串就与「DSH 重启」这件事彻底解耦。
 *  3. **恢复票密钥** `bootSecret` —— 让手机端那次 cookie 失效后的自愈在重启后依然有效。
 *
 * 安全取舍（必须写清楚，别让后来的人以为是疏忽）：
 *  - `entryKey` 等价于这台机器的钥匙，且**不再随重启轮换**。这是「重启后不用重扫」的
 *    必然代价：任何拿到旧二维码/旧链接的人，在用户主动「重置长期入口」之前一直能用。
 *    因此设置页给了显式的重置入口，且文件权限尽力收紧（见 savePrefs）。
 *  - 本文件里**只有**这两把随机钥匙和偏好，不含 DSH 的令牌、不含隧道凭据。
 *    公网固定域名走的是「自带隧道」（cloudflared 由用户以服务方式运行），插件不持有任何
 *    Cloudflare 凭据 —— 这是刻意的：插件不该成为另一个能控制你账号的东西。
 *  - 解析一律「宽进严出」：文件损坏/被改坏时回落到默认值并继续可用，绝不因为一个坏字段
 *    让插件起不来（上次那类事故的教训是「激活失败＝整个界面空白且没有日志」）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 状态文件版本号：将来加字段时用它做迁移判断。 */
export const PREFS_VERSION = 1;

/** 插件自己的数据目录（与 activation.log 同一个）。 */
export function mobileRemoteDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'mobile-remote');
}

/** 状态文件绝对路径（设置页会把它显示给用户，便于排查）。 */
export function prefsPath() {
  return join(mobileRemoteDir(), 'state.json');
}

/** 生成一把 32 字节随机钥匙（base64url，可直接放进 URL / cookie）。 */
export function randomKey() {
  return randomBytes(32).toString('base64url');
}

/** 默认值：一切关闭，公网用快速隧道（不需要任何外部配置）。 */
export function defaultPrefs() {
  return {
    version: PREFS_VERSION,
    autoStart: false,
    mode: 'lan',
    lan: { ip: null, port: null },
    public: { provider: 'quick', host: null, port: null },
    /**
     * 上次那条 quick 隧道（pid / 域名 / 端口）。DSH 退出时**不杀** cloudflared，
     * 把它记在这里；下次启动先试「能不能还绑回这个端口 + 这个域名是否还转回到我们」，
     * 能就沿用同一个域名 —— 这是「重启后旧二维码仍然有效」在快速隧道下唯一的实现方式。
     */
    tunnel: null,
    entryKey: null,
    bootSecret: null,
  };
}

function asPort(value) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 钥匙只接受宽松的 base64url，且不能太短（太短等于没有）。 */
function asKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(value) ? value : null;
}

/**
 * 归一化公网主机名：允许用户贴 `https://x.y/z` 这种，但存下来的必须是纯主机名。
 * 端口不在这里收（https 由隧道终结，公网 URL 不带端口）。
 */
function asHost(value) {
  const text = asString(value);
  if (text === null) return null;
  const stripped = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(stripped) ? stripped : null;
}

/**
 * 归一化隧道记录。只认「pid 是正整数 + url 是 trycloudflare 域名 + port 是端口」这三样
 * 同时成立的记录 —— 缺任何一样都没有复用价值，直接丢掉（丢掉的后果只是下次重新建隧道）。
 */
function asTunnelRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = /** @type {Record<string, any>} */ (value);
  const pid = Number.isInteger(input.pid) && input.pid > 0 ? input.pid : null;
  const port = asPort(input.port);
  const url = typeof input.url === 'string' && /^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/.test(input.url)
    ? input.url
    : null;
  if (pid === null || port === null || url === null) return null;
  const startedAt = Number.isFinite(input.startedAt) ? input.startedAt : null;
  return { pid, url, port, startedAt };
}

/**
 * 把任意 JSON 归一化成合法偏好。**绝不抛异常**：坏字段一律回落到默认。
 * @param {unknown} raw
 * @returns {ReturnType<typeof defaultPrefs>}
 */
export function normalizePrefs(raw) {
  const prefs = defaultPrefs();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return prefs;
  const input = /** @type {Record<string, any>} */ (raw);

  if (typeof input.autoStart === 'boolean') prefs.autoStart = input.autoStart;
  if (input.mode === 'lan' || input.mode === 'public') prefs.mode = input.mode;

  if (typeof input.lan === 'object' && input.lan !== null) {
    prefs.lan.ip = asString(input.lan.ip);
    prefs.lan.port = asPort(input.lan.port);
  }
  if (typeof input.public === 'object' && input.public !== null) {
    if (input.public.provider === 'stable' || input.public.provider === 'quick') {
      prefs.public.provider = input.public.provider;
    }
    prefs.public.host = asHost(input.public.host);
    prefs.public.port = asPort(input.public.port);
  }

  prefs.tunnel = asTunnelRecord(input.tunnel);
  prefs.entryKey = asKey(input.entryKey);
  prefs.bootSecret = asKey(input.bootSecret);
  return prefs;
}

/**
 * 读状态文件。文件不存在、损坏、权限不够… 一律返回默认值（并保持插件可用）。
 * @returns {ReturnType<typeof defaultPrefs>}
 */
export function loadPrefs() {
  try {
    return normalizePrefs(JSON.parse(readFileSync(prefsPath(), 'utf8')));
  } catch {
    return defaultPrefs();
  }
}

/**
 * 原子写状态文件：先写临时文件再 rename，避免进程在写到一半被杀时留下半截 JSON
 * （半截 JSON 的后果是「重启后偏好全丢」，正好砸在这次要修的问题上）。
 *
 * @param {ReturnType<typeof defaultPrefs>} prefs
 * @returns {boolean} 是否写成功（失败不抛：偏好存不下不该让开启流程失败）
 */
export function savePrefs(prefs) {
  const target = prefsPath();
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(mobileRemoteDir(), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ ...prefs, version: PREFS_VERSION }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
    return false;
  }
}

/**
 * 保证两把钥匙存在（首次运行时生成并落盘）。
 *
 * 只负责「补齐」：已有的钥匙**绝不覆盖** —— 覆盖 entryKey 等于把用户手机上那条长期入口
 * 直接作废，正是我们要避免的事。要换钥匙请走设置页的「重置长期入口」。
 *
 * @param {ReturnType<typeof defaultPrefs>} prefs
 * @returns {{ prefs: ReturnType<typeof defaultPrefs>, changed: boolean }}
 */
export function ensureSecrets(prefs) {
  let changed = false;
  if (prefs.entryKey === null) {
    prefs.entryKey = randomKey();
    changed = true;
  }
  if (prefs.bootSecret === null) {
    prefs.bootSecret = randomKey();
    changed = true;
  }
  return { prefs, changed };
}

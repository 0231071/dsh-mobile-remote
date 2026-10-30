/**
 * 量化「刚出二维码时域名能不能解析」——即手机扫码立刻打不开的窗口有多长。
 *
 * 做法：起一条全新 quick tunnel，从拿到地址的那一刻起，每 2 秒向两个解析器问一次：
 *   · Cloudflare DoH（公共视角，等价于"别人的手机"）
 *   · 本机解析器
 * 同时用浏览器语义 fetch 一次。记录各自首次成功的时间。
 *
 * 跑法：node tools/measure-dns-window.mjs
 */

import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(here, '_dns-window-cloudflared.log');
const PORT = 19503;

const t0 = Date.now();
const elapsed = () => Math.round((Date.now() - t0) / 1000);
const log = (...args) => console.log(`[t+${String(elapsed()).padStart(3)}s]`, ...args);

const upstream = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('DSH-MOBILE-DNS-WINDOW-OK');
});
await new Promise((resolve) => upstream.listen(PORT, '127.0.0.1', resolve));

fs.writeFileSync(LOG, '');
const out = fs.openSync(LOG, 'a');
const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
  stdio: ['ignore', out, out],
  windowsHide: true,
});

const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const deadline = Date.now() + 90_000;
let url = null;
while (Date.now() < deadline && !url) {
  url = readLog().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
  if (!url) await new Promise((r) => setTimeout(r, 250));
}
if (!url) {
  console.error('没拿到公网地址', readLog().slice(-500));
  child.kill();
  upstream.close();
  process.exit(1);
}

// 以「cloudflared 打印出地址」为 t0 重锚，这正是用户界面上二维码出现的时刻。
const created = Date.now();
const since = () => Math.round((Date.now() - created) / 1000);
const host = new URL(url).hostname;
log(`地址已生成：${url}`);
log('（以下 t 均以"二维码出现"为 0 点，等价于用户刚点完开启）');

async function dohResolve() {
  try {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(6000),
    });
    const body = await response.json();
    const answers = (body.Answer ?? []).filter((row) => row.type === 1).map((row) => row.data);
    return { ok: answers.length > 0, detail: answers.length > 0 ? answers.join(',') : `Status=${body.Status}` };
  } catch (error) {
    return { ok: false, detail: `查询失败 ${error.cause?.code ?? error.message}` };
  }
}

async function localResolve() {
  try {
    return { ok: true, detail: (await dns.lookup(host)).address };
  } catch (error) {
    return { ok: false, detail: error.code ?? String(error) };
  }
}

async function browserLike() {
  try {
    const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(15_000) });
    const body = await response.text();
    return { ok: response.ok && body.includes('DSH-MOBILE-DNS-WINDOW-OK'), detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error.cause?.code ?? error.message };
  }
}

let publicFirst = null;
let localFirst = null;
let webFirst = null;
for (let round = 1; round <= 90; round++) {
  const [pub, loc, web] = await Promise.all([dohResolve(), localResolve(), browserLike()]);
  if (pub.ok && publicFirst === null) publicFirst = since();
  if (loc.ok && localFirst === null) localFirst = since();
  if (web.ok && webFirst === null) webFirst = since();
  console.log(`    t+${String(since()).padStart(3)}s 公共DNS=${pub.ok ? pub.detail : `未生效(${pub.detail})`} 本机DNS=${loc.ok ? loc.detail : loc.detail} 打开页面=${web.ok ? '✅ OK' : web.detail}`);
  if (webFirst !== null && publicFirst !== null && localFirst !== null) break;
  await new Promise((r) => setTimeout(r, 2000));
}

console.log('');
log('==================== 结论 ====================');
log(`公共 DNS（手机视角）首次解析成功：${publicFirst === null ? '始终未生效' : `t+${publicFirst}s`}`);
log(`本机 DNS 首次解析成功：        ${localFirst === null ? '始终未生效' : `t+${localFirst}s`}`);
log(`浏览器语义首次打开成功：        ${webFirst === null ? '始终未成功' : `t+${webFirst}s`}`);
if (publicFirst !== null && publicFirst > 5) {
  log(`⇒ 二维码出现后的前 ~${publicFirst} 秒内，任何用"刚生成的新域名"去扫码的手机都会得到 DNS 解析失败（微信表现为"无法打开页面"）。`);
}

child.kill();
upstream.close();
process.exit(0);
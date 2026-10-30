/**
 * 公网隧道端到端探针（绕开本机 DNS）。
 *
 * 背景：有些网络里 git/隧道都通，但本机解析器拿不到 trycloudflare 的临时子域
 * （公共 DNS 也不可达），于是「本机 fetch 隧道域名」必然 ENOTFOUND。这并不代表
 * 隧道不通——真正要证明的是：Cloudflare 边缘能按 Host 把请求送回本机上游。
 *
 * 做法：解析 trycloudflare.com 的 A 记录拿到 Cloudflare 边缘 IP，然后
 * HTTPS 直连该 IP，用 servername/Host 指定隧道域名（等价于浏览器做完 DNS 之后
 * 的那一段）。手机侧用的是手机自己的 DNS，不受本机解析器影响。
 *
 * 跑法：node tools/probe-public-tunnel.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(here, '_cloudflared.log');
const PORT = 19501;

const log = (...args) => console.log('[tunnel]', ...args);
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) log(`✅ ${name}`);
  else { failures.push(name); log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`hello-from-local-upstream host=${req.headers.host ?? ''}`);
});
await new Promise((resolve) => upstream.listen(PORT, '127.0.0.1', resolve));
log(`本地上游 127.0.0.1:${PORT}`);

fs.writeFileSync(LOG, '');
const out = fs.openSync(LOG, 'a');
const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
  stdio: ['ignore', out, out],
  windowsHide: true,
});

const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const deadline = Date.now() + 60_000;
let url = null;
while (Date.now() < deadline && !url) {
  const text = readLog();
  url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
  if (!url) await new Promise((r) => setTimeout(r, 500));
}
check('cloudflared 返回公网地址', Boolean(url), readLog().slice(-500));
if (!url) {
  child.kill();
  upstream.close();
  process.exit(1);
}
log(`公网地址：${url}`);

check('隧道已注册到 Cloudflare 边缘', /Registered tunnel connection/.test(readLog()),
  readLog().split('\n').filter((l) => l.includes('ERR')).slice(-3).join(' | '));

const tunnelHost = new URL(url).hostname;

// 本机解析器能不能解析它（能解析当然更好，解析不了也不影响手机）
try {
  const local = await dns.lookup(tunnelHost);
  log(`本机 DNS 可解析 ${tunnelHost} → ${local.address}`);
} catch (error) {
  log(`ℹ️  本机 DNS 解析不了 ${tunnelHost}（${error.code}）：这是本机解析器/出口 DNS 的限制，手机用自身上网 DNS 不受影响`);
}

// 拿 Cloudflare 边缘 IP（apex 域在本机是可解析的）
let edgeIp = null;
try {
  edgeIp = (await dns.lookup('trycloudflare.com')).address;
  log(`Cloudflare 边缘 IP（trycloudflare.com）→ ${edgeIp}`);
} catch (error) {
  check('能解析 Cloudflare 边缘 IP', false, error.code);
}

/** 直连边缘 IP，用 SNI/Host 指定隧道域名，等价于浏览器解析之后那一段。 */
function httpsViaEdge(host, ip, requestPath = '/') {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip,
      port: 443,
      servername: host,
      path: requestPath,
      method: 'GET',
      headers: { host },
      timeout: 25_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.end();
  });
}

if (edgeIp) {
  let ok = false;
  for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
    try {
      const response = await httpsViaEdge(tunnelHost, edgeIp);
      ok = response.status === 200 && response.body.includes('hello-from-local-upstream');
      check(`公网链路可达（第 ${attempt} 次尝试）`, ok,
        ok ? '' : `HTTP ${response.status} body=${response.body.slice(0, 120)}`);
      if (ok) log(`   上游回显：${response.body}`);
    } catch (error) {
      log(`   第 ${attempt} 次失败：${error.message}`);
    }
    if (!ok) await new Promise((r) => setTimeout(r, 3000));
  }
}

log('cloudflared 日志尾部：');
console.log(readLog().split('\n').filter(Boolean).slice(-8).join('\n'));

child.kill();
upstream.close();
if (failures.length > 0) {
  log(`失败 ${failures.length} 项：${failures.join('；')}`);
  process.exit(1);
}
log('公网隧道链路验证通过 ✅');
process.exit(0);

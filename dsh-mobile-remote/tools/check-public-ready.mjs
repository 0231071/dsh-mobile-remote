/**
 * 修复验证：把 lib/tunnel.js 的 `waitForPublicReady` 对准**真隧道**跑一遍。
 *
 * 要证明两件事：
 *  1. 边缘回源（edge）确实在隧道建好后几秒就成功 —— 旧代码的提前返回就发生在这里；
 *  2. 修复后的探针**不再**据此收工，而是等到 direct 真正成功才返回 `via:'direct'`，
 *     这个时刻与"域名进入 DNS"一致（实测约 60–70 秒）。
 *
 * 跑法：node tools/check-public-ready.mjs [超时秒数]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { waitForPublicReady } from '../lib/tunnel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(here, '_public-ready-cloudflared.log');
const PORT = 19504;
const TIMEOUT_MS = Number(process.argv[2] ?? 180) * 1000;

const t0 = Date.now();
const since = () => `t+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`;
const log = (message) => console.log(`[${since()}] ${message}`);

const upstream = http.createServer((_req, res) => {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('unauthorized'); // 与 DSH 未认证时的响应一致
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
log(`隧道已建：${url}（这就是界面上二维码出现的时刻）`);

const result = await waitForPublicReady(url, { timeoutMs: TIMEOUT_MS, log: (m) => log(`   探针：${m}`) });
log(`探针返回：ok=${result.ok} via=${result.via} status=${result.status ?? '-'} ${result.error ?? ''}`);

child.kill();
upstream.close();

if (result.ok && result.via === 'direct') {
  log('✅ 修复生效：探针一直等到 direct 成功（域名真正进入 DNS）才宣告就绪。');
  log('   ⇒ 用户在拿到二维码后的前 ~1 分钟内不会再看到"已就绪、可以扫"的误导提示。');
  process.exit(0);
}
log('❌ 未按预期返回 direct（若长期只能拿到 edge，说明本机解析器确实解析不了临时子域）。');
process.exit(1);
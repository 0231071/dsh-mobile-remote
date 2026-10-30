/**
 * 把一条 quick tunnel 挂住一段时间，并把公网地址写到文件，供外部验证使用。
 *
 * 用途：本机 DNS 解析不了临时子域、也连不了公共 DNS 时，「隧道是否真的对公网可用」
 * 只能从**外部**验。挂住隧道后，用任意外部抓取服务去访问这个地址：
 *   https://r.jina.ai/https://<隧道域名>/
 * 外部服务从它自己的网络解析 DNS 并回源，等价于「别人的手机能不能打开」。
 *
 * 跑法：node tools/hold-tunnel.mjs [保持秒数]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const URL_FILE = path.join(here, '_tunnel-url.txt');
const LOG = path.join(here, '_cloudflared.log');
const PORT = 19502;
const holdSeconds = Number(process.argv[2] ?? 300);

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`DSH-MOBILE-TUNNEL-OK path=${req.url} host=${req.headers.host ?? ''}`);
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
  if (!url) await new Promise((r) => setTimeout(r, 500));
}

if (!url) {
  console.error('[hold] 没拿到公网地址');
  console.error(readLog().slice(-800));
  child.kill();
  upstream.close();
  process.exit(1);
}

fs.writeFileSync(URL_FILE, `${url}\n`);
console.log(`[hold] 公网地址：${url}`);
console.log(`[hold] 已写入 ${URL_FILE}，保持 ${holdSeconds}s`);

// 打印注册状态，便于判断隧道是否真的挂上了边缘
for (let i = 0; i < 20; i++) {
  if (/Registered tunnel connection/.test(readLog())) {
    console.log('[hold] 隧道已注册到 Cloudflare 边缘 ✅');
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}

await new Promise((r) => setTimeout(r, holdSeconds * 1000));
fs.rmSync(URL_FILE, { force: true });
child.kill();
upstream.close();
console.log('[hold] 已结束');
process.exit(0);

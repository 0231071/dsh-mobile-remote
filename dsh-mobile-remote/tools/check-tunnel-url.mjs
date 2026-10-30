/**
 * 对一条**已存在**的隧道地址做外部可达性轮询（绕开本机 DNS）。
 *
 * 用法：node tools/check-tunnel-url.mjs https://xxx.trycloudflare.com [轮询秒数]
 * 原理：解析 trycloudflare.com 的 A 记录拿边缘 IP，再用 servername/Host 指定隧道域名直连。
 */

import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';

const target = process.argv[2];
const seconds = Number(process.argv[3] ?? 90);
if (!target) {
  console.error('用法：node tools/check-tunnel-url.mjs https://xxx.trycloudflare.com [秒数]');
  process.exit(2);
}
const host = new URL(target).hostname;

// 先看看本机 DNS 现在能不能解析（有些网络过一会儿就好了）
try {
  const local = await dns.lookup(host);
  console.log(`[check] 本机 DNS 可解析 ${host} → ${local.address}`);
} catch (error) {
  console.log(`[check] 本机 DNS 仍解析不了 ${host}（${error.code}）`);
}

const edgeIps = new Set();
for (const apex of ['trycloudflare.com', 'www.cloudflare.com']) {
  try {
    for (const row of await dns.lookup(apex, { all: true })) edgeIps.add(row.address);
  } catch { /* 忽略 */ }
}
console.log(`[check] 候选边缘 IP：${[...edgeIps].join(', ')}`);

function viaEdge(ip, requestPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip, port: 443, servername: host, path: requestPath, method: 'GET',
      headers: { host }, timeout: 15_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.end();
  });
}

const deadline = Date.now() + seconds * 1000;
let attempt = 0;
while (Date.now() < deadline) {
  attempt++;
  for (const ip of edgeIps) {
    try {
      const res = await viaEdge(ip, '/');
      const hit = res.body.includes('DSH-MOBILE-TUNNEL-OK');
      console.log(`[check] #${attempt} ${ip} → HTTP ${res.status} ${hit ? '✅ 隧道回源成功' : `body=${res.body.replace(/\s+/g, ' ').slice(0, 90)}`}`);
      if (hit) {
        console.log('[check] 结论：该隧道对公网可达 ✅（手机用自己的 DNS 就能打开）');
        process.exit(0);
      }
    } catch (error) {
      console.log(`[check] #${attempt} ${ip} → 失败：${error.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log('[check] 结论：轮询期间始终未回源成功 ❌');
process.exit(1);

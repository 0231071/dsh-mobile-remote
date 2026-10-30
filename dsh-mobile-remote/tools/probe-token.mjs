/**
 * 找一台「有真 token 可用的」真实 dsh web：读 ~/.dsh/web-host.log 里最后一条
 * token URL，逐个候选端口试探，看是否仍有进程在服务且 token 未随进程轮换。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const logFile = path.join(os.homedir(), '.dsh', 'web-host.log');
const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
const found = [...text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/g)];
const candidates = [...new Map(found.map((m) => [m[1], { port: Number(m[1]), token: m[2] }])).values()].reverse();
console.log('[token] 日志候选：', candidates.map((c) => `${c.port}(token ${c.token.length} 位)`).join(', ') || '无');

function probe(port, requestPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code ?? e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

for (const port of [19387, 3080, ...candidates.map((c) => c.port)]) {
  const base = await probe(port, '/', { host: `127.0.0.1:${port}` });
  console.log(`[token] 端口 ${port} 根路径 → ${base.status || base.error}`);
  if (base.status !== 401 && base.status !== 200) continue;

  for (const candidate of candidates.filter((c) => c.port === port || true)) {
    const withToken = await probe(port, `/?token=${candidate.token}`, { host: `127.0.0.1:${port}` });
    const marker = withToken.status === 303 ? '✅ token 有效' : `${withToken.status || withToken.error}`;
    console.log(`[token]   端口 ${port} + 日志 token(${candidate.token.length}) → ${marker}`);
    if (withToken.status === 303) {
      const cookie = (withToken.headers['set-cookie'] ?? [])[0]?.split(';')[0];
      const authed = await probe(port, '/', { host: `127.0.0.1:${port}`, cookie });
      console.log(`[token]   带 cookie 复访 → ${authed.status}，HTML ${authed.body.length} 字节`);
      console.log(`[token] 结论：端口 ${port} 可用真 token 做端到端验收`);
      process.exit(0);
    }
  }
}
console.log('[token] 结论：没有可用的真 token 实例（token 随进程轮换，属预期）');
process.exit(1);

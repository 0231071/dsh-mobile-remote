/**
 * 现场体检：判断「插件到底加载到哪一步了」。
 *
 * 三种典型现场，一眼分清：
 *   A. 浏览器半装了、宿主半没进加载树  → /api 有响应，但 /mobile-remote/* 是 404
 *      （界面表现：设置里有「手机连接」标签页，点进去报 HTTP 404）
 *   B. 都装好了、只是没登录            → /mobile-remote/* 回 401
 *   C. 没有活着的实例                  → 连接被拒
 *
 * 跑法：node tools/doctor.mjs             （自动找实例）
 *      node tools/doctor.mjs 19387         （指定端口）
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const log = (...args) => console.log('[doctor]', ...args);

function probe(port, requestPath, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: { host: `127.0.0.1:${port}` },
      timeout: timeoutMs,
    }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes }));
    });
    req.on('error', (error) => resolve({ status: 0, error: error.code ?? error.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

/** 候选端口及其来源（来源决定 404 该不该报警）。 */
function candidatePorts() {
  // 先收 web-host.log 里的端口：那是 `dsh web`（= --profile web）写的，本来就没有本插件，
  // 无论它是被哪条规则发现的，都要按「web profile 实例」来解读。
  const logPorts = new Set();
  const logFile = path.join(os.homedir(), '.dsh', 'web-host.log');
  if (fs.existsSync(logFile)) {
    for (const match of fs.readFileSync(logFile, 'utf8').matchAll(/127\.0\.0\.1:(\d+)\//g)) {
      logPorts.add(Number(match[1]));
    }
  }

  const list = [];
  const add = (port, source) => {
    if (!Number.isInteger(port) || port <= 0) return;
    if (list.some((entry) => entry.port === port)) return;
    list.push({ port, source: logPorts.has(port) ? 'dsh web（web profile）' : source });
  };
  const fromEnv = process.env.DSH_WEB_URL?.match(/:(\d+)/)?.[1];
  if (fromEnv) add(Number(fromEnv), '当前会话指向的实例');
  if (process.argv[2]) add(Number(process.argv[2]), '命令行指定');
  for (const port of [19387, 3080]) add(port, '常见端口');
  for (const port of logPorts) add(port, 'dsh web（web profile）');
  return list;
}

let found = false;
for (const { port, source } of candidatePorts()) {
  const root = await probe(port, '/');
  if (root.status === 0) continue; // 没实例
  found = true;
  log(`端口 ${port}（${source}）：/ → HTTP ${root.status}`);

  const api = await probe(port, '/api');
  const plugin = await probe(port, '/mobile-remote/status');
  log(`  /api                → HTTP ${api.status || api.error}`);
  log(`  /mobile-remote/status → HTTP ${plugin.status || plugin.error}${plugin.bytes ? `（${plugin.bytes} 字节）` : ''}`);

  if (plugin.status === 401 || plugin.status === 403) {
    log('  ✅ 结论：宿主半已加载，接口在（401 只是未登录，从 DSH 界面里打开即可）');
  } else if (plugin.status === 404 && source.includes('web profile')) {
    log('  ℹ️ 结论：这是 `dsh web`（web profile）实例，本插件只装在 desktop profile，404 属正常');
  } else if (plugin.status === 404 && api.status === 401) {
    log('  ❌ 结论：宿主半**没有**进入加载树 —— 浏览器半热更了，宿主半不会。');
    log('     处理：彻底退出 DSH 桌面客户端（托盘右键退出 / 任务管理器结束进程）后重新启动；');
    log('           仅关闭窗口、刷新页面、重启 web 服务都无效。');
  } else if (api.status === 0) {
    log('  ⚠️ 结论：该端口不是 DSH 实例');
  } else {
    log('  ⚠️ 结论：状态不符合预期，请把上面几行贴出来进一步排查');
  }
}

if (!found) {
  log('没有找到活着的 DSH 实例。请先启动 DSH 桌面客户端，或用 DSH_WEB_URL 指定地址。');
  process.exit(2);
}

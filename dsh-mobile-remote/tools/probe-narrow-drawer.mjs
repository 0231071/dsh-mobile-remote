/**
 * 真机验证「窄屏抽屉样式」的生效范围 —— 用 headless Chromium 量真实布局，不靠推断。
 *
 * 为什么需要它：`test/client-bundle.test.mjs` 只能对 CSS **文本**做断言（有没有 `:not(`、
 * 有没有写成固定 px……），但「这条样式到底命中了哪些状态」是浏览器算出来的。这个脚本
 * 用一个复刻 `dsh-client-ui-layout` AppFrame 的夹具，把两侧轨道宽度**量出来**：
 *
 *   · 手机竖屏 + 展开  → 侧栏占满整屏、中间列归零（缺陷本身）；
 *   · 手机竖屏 + 折叠  → 仍是 56px 图标轨道（**必须不变** —— 上一版就是错在这里）；
 *   · 窄屏中段 + 鼠标  → 仍是 280px（**必须不变** —— 用户要的只是手机，窄桌面窗口别动）；
 *   · 窄屏中段 + 触屏  → 占满整屏（手机横屏）；
 *   · 宽屏 + 展开      → 仍是 280px（**必须不变**）。
 *
 * 夹具注入的 CSS **直接取 `lib/client.js` 导出的 `DRAWER_CSS`**，所以"被验证的字节"与
 * "发出去的字节"是同一份；触屏那一档用 `--blink-settings` 让 Chromium 报 `hover:none`
 * （桌面 Chromium 默认 `hover:hover`，正好用来验证"桌面不受影响"）。
 *
 * 跑法：node tools/probe-narrow-drawer.mjs
 *      CHROME_PATH=/path/to/chrome node tools/probe-narrow-drawer.mjs
 *      退出码 0 = 全部符合预期；1 = 有不符（会逐行打印实际数值）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, '..', 'lib', 'client.js');
const OUT_DIR = path.join(os.tmpdir(), 'dsh-mobile-drawer-probe');

const log = (...args) => console.log('[drawer-probe]', ...args);
const failures = [];
const check = (name, condition, detail = '') => {
  log(condition ? `✅ ${name}` : `❌ ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
};

// ── 1. 找到 Chromium ─────────────────────────────────────────────────────────

function findChrome() {
  const fromEnv = process.env.CHROME_PATH ?? process.env.REA_BROWSER_EXECUTABLE;
  if (fromEnv !== undefined && fromEnv !== '' && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return undefined;
}

const CHROME = findChrome();
if (CHROME === undefined) {
  log('找不到 Chromium。设 CHROME_PATH=<可执行文件> 后重跑；本项验证跳过。');
  process.exit(0);
}
// 注意：Windows 上**不能**用 `chrome --version` 探版本 —— 它不打印，而是照着命令行
// 启动一个真实浏览器窗口并挂住（实测）。版本不进判定，这里只报路径。
log('Chromium:', CHROME);

// ── 2. 从真实 bundle 里取 DRAWER_CSS 字节 ────────────────────────────────────

const source = fs.readFileSync(BUNDLE, 'utf8');
const loaded = [];
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => loaded.push(definition) } },
  document: { head: { appendChild: () => {} }, getElementById: () => null, createElement: () => ({ id: '', textContent: '' }) },
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => ({}), text: () => '' }),
};
vm.createContext(sandbox);
new vm.Script(source, { filename: BUNDLE }).runInContext(sandbox);
const bundleExports = loaded[0].factory((name) => {
  if (name !== 'react') throw new Error(`未声明的外部依赖：${name}`);
  return {
    createElement: () => ({}),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  };
});
const DRAWER_CSS = bundleExports.DRAWER_CSS;
if (typeof DRAWER_CSS !== 'string' || DRAWER_CSS.length === 0) {
  log('从 lib/client.js 取不到 DRAWER_CSS —— 浏览器半改过导出名？');
  process.exit(1);
}
log('DRAWER_CSS', Buffer.byteLength(DRAWER_CSS), '字节');

// ── 3. 夹具：复刻 AppFrame 的网格 / 内联轨道 / 三个 data 钩子 ────────────────

/** 夹具里只抄与本次判定相关的壳样式，其余与尺寸无关。 */
const FRAME_CSS = `
html,body{margin:0;height:100%}
.frame{display:grid;grid-template-rows:minmax(0,1fr) auto;height:100%;position:relative;overflow:hidden}
.sidebarCol{background:#cfd8e6;border-right:.5px solid #999;min-width:0;overflow:hidden}
.centerCol{display:flex;flex-direction:column;min-width:0;overflow:hidden;background:#fff}
.rightbarCol{min-width:0;position:relative;overflow:visible}
.rightPanel{position:absolute;top:0;bottom:0;right:0;width:300px;background:#ffeeaa}
.bottomRow{grid-column:1/-1;min-height:0}
.overlayLayer{position:absolute;inset:0;pointer-events:none;z-index:20}
.handle{cursor:col-resize;z-index:11;touch-action:none;grid-area:1/1/2/-1;width:8px;margin-left:-4px;position:absolute;top:0;bottom:0}
`;

const PROBE_SCRIPT = `
const out = [];
const frame = document.getElementById('frame');
const w = (el) => Math.round(el.getBoundingClientRect().width * 100) / 100;
const disp = (el) => getComputedStyle(el).display;
function scenario(name, { collapsed, sidebarPx }) {
  if (collapsed) frame.setAttribute('data-sidebar-collapsed', 'true');
  else frame.removeAttribute('data-sidebar-collapsed');
  frame.style.gridTemplateColumns = sidebarPx + 'px minmax(0px, 1fr) minmax(0px, 0px)';
  void frame.offsetWidth;
  out.push([
    name,
    'viewport=' + document.documentElement.clientWidth,
    'frame=' + w(frame),
    'sidebar=' + w(document.getElementById('sidebarCol')),
    'center=' + w(document.getElementById('centerCol')),
    'handle=' + disp(document.getElementById('handle')),
    'rightPanel=' + disp(document.getElementById('rightPanel')),
  ].join(' | '));
}
const vw = document.documentElement.clientWidth;
out.push('env | viewport=' + vw + ' | hover-none=' + matchMedia('(hover: none)').matches);
if (vw < 600) {
  scenario('手机竖屏+展开', { collapsed: false, sidebarPx: 280 });
  scenario('手机竖屏+折叠', { collapsed: true, sidebarPx: 56 });
} else if (vw < 1024) {
  scenario('窄屏中段+展开', { collapsed: false, sidebarPx: 280 });
  scenario('窄屏中段+折叠', { collapsed: true, sidebarPx: 56 });
} else {
  scenario('宽屏+展开', { collapsed: false, sidebarPx: 280 });
}
document.getElementById('out').textContent = out.join('\\n');
`;

function buildFixture({ withProbeCss }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>drawer probe</title>
<style>${FRAME_CSS}</style>
<style id="probe">${withProbeCss ? DRAWER_CSS : ''}</style>
</head><body>
<div class="frame" id="frame" style="grid-template-columns: 280px minmax(0px, 1fr) minmax(0px, 0px)">
  <div class="sidebarCol" id="sidebarCol">会话列表</div>
  <div class="centerCol" id="centerCol">对话</div>
  <div class="rightbarCol" id="rightbarCol">
    <div class="rightPanel" id="rightPanel" data-sidebar-right-session="s1" data-sidebar-right-panel="push" data-sidebar-right-open="true">右侧面板</div>
  </div>
  <div class="bottomRow" data-shell-bottom="true"></div>
  <div class="overlayLayer" data-shell-overlay="true"></div>
  <div class="handle" id="handle" data-side="sidebar" style="left:280px"></div>
</div>
<pre id="out"></pre>
<script>${PROBE_SCRIPT}</script>
</body></html>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const FIXTURE_AFTER = path.join(OUT_DIR, 'after.html');
const FIXTURE_BEFORE = path.join(OUT_DIR, 'before.html');
fs.writeFileSync(FIXTURE_AFTER, buildFixture({ withProbeCss: true }));
fs.writeFileSync(FIXTURE_BEFORE, buildFixture({ withProbeCss: false }));

// ── 4. 跑 headless Chromium 并读回量到的数字 ─────────────────────────────────

/** 触屏模拟：让 Chromium 报 `hover:none`（桌面 Chromium 默认报 `hover:hover`）。 */
const TOUCH_FLAGS = ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=1,availableHoverTypes=1'];

function runProbe({ file, windowSize, touch }) {
  // 每次跑用一个独立的一次性 profile：**绝不碰用户自己的浏览器 profile**，
  // 也避免复用同一个 dir 时撞上 Chromium 的单例锁（会静默挂住）。
  const profileDir = path.join(OUT_DIR, `chrome-profile-${windowSize}-${touch ? 'touch' : 'mouse'}`);
  fs.rmSync(profileDir, { recursive: true, force: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize},844`,
    '--virtual-time-budget=1500',
    ...(touch ? TOUCH_FLAGS : []),
    '--dump-dom',
    `file:///${file.replace(/\\/g, '/')}`,
  ];
  const result = spawnSync(CHROME, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error !== undefined) {
    log(`Chromium 未能正常结束（windowSize=${windowSize} touch=${touch}）：${result.error.message}`);
    return undefined;
  }
  const dom = result.stdout ?? '';
  const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if (match === null) {
    log(`取不到探针输出（dom ${dom.length} 字节；stderr: ${(result.stderr ?? '').slice(0, 300)}）`);
    return undefined;
  }
  // 逐行 trim：Windows 上 Chrome 的 --dump-dom 会把 DOM 里的 \n 写成 \r\n，
  // 不 trim 的话每行**最后**一个字段会带一个看不见的 \r（"none" ≠ "none\r"）。
  const rows = match[1].trim().split(/\r?\n/).map((line) => line.trim());
  const parsed = { raw: rows, rows: [] };
  for (const row of rows) {
    if (row.startsWith('env |')) { parsed.env = row; continue; }
    const fields = Object.fromEntries(row.split(' | ').slice(1).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }));
    parsed.rows.push({ name: row.split(' | ')[0], ...fields });
  }
  return parsed;
}

const show = (tag, probe) => {
  log(`── ${tag}`);
  for (const row of probe.raw) log('   ', row);
};
const find = (probe, name) => probe.rows.find((row) => row.name.startsWith(name));

log('');
const cases = [
  { tag: 'BEFORE 手机竖屏(500) 鼠标', file: FIXTURE_BEFORE, windowSize: 500, touch: false },
  { tag: 'AFTER  手机竖屏(500) 鼠标', file: FIXTURE_AFTER, windowSize: 500, touch: false },
  { tag: 'AFTER  手机竖屏(500) 触屏', file: FIXTURE_AFTER, windowSize: 500, touch: true },
  { tag: 'BEFORE 窄屏中段(824) 鼠标', file: FIXTURE_BEFORE, windowSize: 824, touch: false },
  { tag: 'AFTER  窄屏中段(824) 鼠标', file: FIXTURE_AFTER, windowSize: 824, touch: false },
  { tag: 'AFTER  窄屏中段(824) 触屏', file: FIXTURE_AFTER, windowSize: 824, touch: true },
  { tag: 'AFTER  宽屏(1100) 鼠标', file: FIXTURE_AFTER, windowSize: 1100, touch: false },
].map((item) => ({ ...item, probe: runProbe(item) }));

if (cases.some((item) => item.probe === undefined)) {
  log('有探针没跑出结果，无法判定。');
  process.exit(1);
}
for (const item of cases) show(item.tag, item.probe);
log('');

const [beforePhone, afterPhone, afterPhoneTouch, beforeMid, afterMid, afterMidTouch, afterWide] = cases.map((item) => item.probe);
const num = (row, key) => Number(row[key]);
const openRow = (probe, prefix) => find(probe, prefix);

// ── 5. 判定 ──────────────────────────────────────────────────────────────────

log('判定：');

// 5.1 缺陷本身：手机竖屏展开后侧栏必须占满整帧
{
  const row = openRow(afterPhone, '手机竖屏+展开');
  check('手机竖屏展开：侧栏 = 整帧宽（撑满）', num(row, 'sidebar') === num(row, 'frame'),
    `sidebar=${row.sidebar} frame=${row.frame}`);
  check('手机竖屏展开：中间列归零（右侧不再留残影）', num(row, 'center') === 0, `center=${row.center}`);
  check('手机竖屏展开：列宽把手让位', row.handle === 'none', `handle=${row.handle}`);
  check('手机竖屏展开：右栏面板让位', row.rightPanel === 'none', `rightPanel=${row.rightPanel}`);
  // 兜底那一档（max-width:599.98px）在桌面 Chromium 上就已经生效 —— 这正是它的作用
  check('手机竖屏展开：靠 ≤599.98px 兜底也能生效（不依赖 hover 判定）',
    beforePhone.env.includes('hover-none=false'), `${beforePhone.env}`);
  // 触屏与鼠标两种指针类型下，手机那一档的表现必须一致（不该时灵时不灵）
  {
    const touchRow = openRow(afterPhoneTouch, '手机竖屏+展开');
    check('手机竖屏展开：触屏与鼠标两种指针下数值完全一致',
      ['sidebar', 'center', 'handle', 'rightPanel'].every((key) => touchRow[key] === row[key]),
      `mouse=${JSON.stringify(row)} touch=${JSON.stringify(touchRow)}`);
  }
}

// 5.2 修复前就是 280px：证明这确实是缺陷、且上面量到的变化不是夹具自带的
{
  const row = openRow(beforePhone, '手机竖屏+展开');
  check('修复前：手机竖屏展开时侧栏是 280px（缺陷可复现）', num(row, 'sidebar') === 280,
    `sidebar=${row.sidebar}`);
}

// 5.3 折叠态一律不动 —— 上一版就是错在这里
for (const [tag, probe, name] of [
  ['手机竖屏', afterPhone, '手机竖屏+折叠'],
  ['窄屏中段', afterMid, '窄屏中段+折叠'],
]) {
  const row = find(probe, name);
  check(`${tag}折叠：仍是 56px 图标轨道（不得被撑宽）`, num(row, 'sidebar') === 56, `sidebar=${row.sidebar}`);
  check(`${tag}折叠：中间列不被吞掉`, num(row, 'center') === num(row, 'frame') - 56, `center=${row.center}`);
  check(`${tag}折叠：列宽把手与右栏面板都不受影响`,
    row.handle === 'block' && row.rightPanel === 'block', `handle=${row.handle} rightPanel=${row.rightPanel}`);
}

// 5.4 窄桌面窗口：鼠标环境下必须与修复前完全一致
{
  const before = openRow(beforeMid, '窄屏中段+展开');
  const after = openRow(afterMid, '窄屏中段+展开');
  check('窄桌面窗口（鼠标）：窄屏中段展开仍是 280px，一字未改', num(after, 'sidebar') === 280,
    `sidebar=${after.sidebar}`);
  check('窄桌面窗口（鼠标）：与修复前逐格一致',
    ['sidebar', 'center', 'handle', 'rightPanel'].every((key) => before[key] === after[key]),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}

// 5.5 手机横屏（窄屏 + 无悬停指针）：要撑满
{
  const row = openRow(afterMidTouch, '窄屏中段+展开');
  check('手机横屏（触屏）：侧栏 = 整帧宽', num(row, 'sidebar') === num(row, 'frame'),
    `sidebar=${row.sidebar} frame=${row.frame}`);
  check('手机横屏（触屏）：中间列归零', num(row, 'center') === 0, `center=${row.center}`);
}

// 5.6 宽屏桌面：不动
{
  const row = openRow(afterWide, '宽屏+展开');
  check('宽屏桌面展开：仍是 280px，一字未改', num(row, 'sidebar') === 280 && num(row, 'handle') !== 'none',
    `sidebar=${row.sidebar} handle=${row.handle}`);
}

log('');
if (failures.length > 0) {
  log(`失败 ${failures.length} 项：${failures.join('；')}`);
  process.exit(1);
}
log('全部符合预期。');
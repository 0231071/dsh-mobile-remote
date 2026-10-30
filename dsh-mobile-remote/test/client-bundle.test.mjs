/**
 * 浏览器半（lib/client.js）真实执行验证。
 *
 * 客户端 bundle 是手写的 lazy-CJS 经典脚本，宿主只负责把它送到浏览器、由页面的
 * ModuleLoader 调 factory。这里用 node:vm 复刻那条契约并**真跑一遍**：
 *  - 顶层必须只调用 window.__ModuleLoader__.load({ id, factory }) 并把 id 写对；
 *  - factory 必须能被 require("react") 喂起来（React 由壳播种）；
 *  - apply(ctx) 必须往 settings.section 注册出 id=mobile-remote 的整页；
 *  - 组件在 off / on 两种状态下都能渲染出预期结构（含二维码 <img>）；
 *  - 窄屏抽屉样式在**模块加载期**注入恰好一次，且只命中「展开态」——折叠的 56px
 *    图标轨道绝不能被改到（上一版就是在这里帮倒忙，见 README「第 5 个缺陷」）。
 *
 * 这一步能抓住语法错误、导出名写错、槽名/注册参数写错——都是浏览器里才会暴露的错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, '..', 'lib', 'client.js');
const source = fs.readFileSync(BUNDLE, 'utf8');

/** 最小 React 替身：仅提供组件用到的 API，并允许预置 useState 初值。 */
function makeReact(stateQueue) {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [stateQueue.length > 0 ? stateQueue.shift() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  };
}

/** 在沙箱里执行 bundle，取回 ModuleLoader 注册的定义。 */
function loadBundle(stateQueue = [], fetchImpl, documentOverrides = {}) {
  const loaded = [];
  const injectedStyles = [];
  const context = {
    window: { __ModuleLoader__: { load: (definition) => loaded.push(definition) } },
    document: {
      head: { appendChild: (node) => injectedStyles.push(node) },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      ...documentOverrides,
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl ?? (() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') })),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    URL,
    JSON,
    Object,
    Symbol,
    Promise,
    Error,
  };
  vm.createContext(context);
  new vm.Script(source, { filename: 'client.js' }).runInContext(context);

  assert.equal(loaded.length, 1, '顶层应恰好调用一次 __ModuleLoader__.load');
  const definition = loaded[0];
  assert.equal(definition.id, 'dsh-mobile-remote', 'bundle id 必须是包名');
  assert.equal(typeof definition.factory, 'function', 'factory 必须是函数');

  const react = makeReact(stateQueue);
  const exports = definition.factory((name) => {
    assert.equal(name, 'react', `未声明的外部依赖：${name}`);
    return react;
  });
  return { definition, exports, react, injectedStyles };
}

/** 在渲染树里按元素类型找节点。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out; }
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

test('bundle 形态：lazy-CJS 工厂 + id/导出名正确', () => {
  const { definition, exports } = loadBundle();
  const firstStatement = source.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
  assert.ok(firstStatement.startsWith('window.__ModuleLoader__.load('), '必须是经典脚本顶层注册工厂');
  assert.equal(typeof definition.factory, 'function');
  // 注意：bundle 跑在独立 vm realm 里，数组是跨 realm 对象，不能用 deepStrictEqual 比原型。
  assert.equal([...exports.inject].join(','), 'slots', 'apply 前必须等 slots 服务');
  assert.equal(typeof exports.apply, 'function');
});

test('apply 注册出「设置 → 手机连接」整页', () => {
  const { exports } = loadBundle();
  const registrations = [];
  const injected = [];
  exports.apply({
    slots: {
      inject: (slot, callback) => { injected.push(slot); return callback(); },
      register: (descriptor, component) => { registrations.push({ descriptor, component }); return () => {}; },
    },
  });

  // 已回到原生状态：只注册设置页，不再往页面里塞任何 UI
  assert.deepEqual(injected.slice().sort(), ['settings.section'], '只应注入设置页座位');

  const sections = registrations.filter((r) => r.descriptor.name === 'settings.section');
  assert.equal(sections.length, 1, '应恰好注册一个设置页');
  const { descriptor, component } = sections[0];
  assert.equal(descriptor.id, 'mobile-remote', 'section id 决定导航项身份');
  assert.equal(descriptor.label, '手机连接');
  assert.equal(typeof component, 'function', '组件必须是可渲染的函数');
});

test('组件渲染：关闭态显示模式选择与开启按钮', () => {
  const { exports } = loadBundle();
  const registrations = [];
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: (d, c) => { registrations.push({ d, c }); return () => {}; } },
  });
  const tree = registrations[0].c({ close: () => {} });

  const buttons = findAll(tree, (node) => node.type === 'button');
  const labels = buttons.map((b) => (b.children ?? []).join(''));
  assert.ok(labels.some((t) => t.includes('局域网')), `应有局域网模式按钮，实际 ${JSON.stringify(labels)}`);
  assert.ok(labels.some((t) => t.includes('公网')), '应有公网模式按钮');
  assert.ok(labels.some((t) => t.includes('开启并生成二维码')), '应有开启按钮');
  assert.equal(findAll(tree, (node) => node.type === 'img').length, 0, '未开启时不应有二维码');
  assert.ok(JSON.stringify(tree).includes('未开启'), '未开启时应显示状态文案');
});

test('组件渲染：开启态显示二维码与链接', () => {
  // useState 顺序：state, error, busy, mode, ip, copied
  const live = {
    phase: 'on',
    enabled: true,
    mode: 'lan',
    lanIps: ['192.168.1.5', '10.0.0.9'],
    selectedIp: '192.168.1.5',
    proxyPort: 41234,
    targetPort: 19387,
    baseUrl: 'http://192.168.1.5:41234',
    authUrl: 'http://192.168.1.5:41234/?token=SECRET',
    publicUrl: null,
    provider: null,
    qrPng: 'data:image/png;base64,AAAB',
    message: '手机需与电脑在同一 Wi-Fi 下扫码',
    lastError: null,
  };
  const { exports } = loadBundle([live, null, false, 'lan', '192.168.1.5', false]);
  const registrations = [];
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: (d, c) => { registrations.push({ d, c }); return () => {}; } },
  });
  const tree = registrations[0].c({ close: () => {} });

  const images = findAll(tree, (node) => node.type === 'img');
  assert.equal(images.length, 1, '开启后应渲染二维码图片');
  assert.equal(images[0].props.src, live.qrPng, '二维码应直接使用宿主给的 PNG');

  const text = JSON.stringify(tree);
  assert.ok(text.includes(live.authUrl), '应显示可复制的入口链接');
  assert.ok(text.includes('已连接'), '应显示已连接状态');
  assert.ok(text.includes('关闭手机连接'), '应提供关闭按钮');

  // 多网卡时应出现网卡选择
  assert.equal(findAll(tree, (node) => node.type === 'select').length, 1, '多网卡时应可切换地址');
});

test('组件渲染：启动中/出错态都有明确文案', () => {
  for (const [phase, expectText] of [['starting', '启动中'], ['error', '出错']]) {
    const state = { phase, mode: 'public', lanIps: [], message: phase === 'error' ? '公网隧道建立失败' : '正在建立公网隧道…', lastError: phase === 'error' ? '探针失败' : null };
    const { exports } = loadBundle([state, null, false, 'public', null, false]);
    const registrations = [];
    exports.apply({
      slots: { inject: (_s, cb) => cb(), register: (d, c) => { registrations.push({ d, c }); return () => {}; } },
    });
    const text = JSON.stringify(registrations[0].c({ close: () => {} }));
    assert.ok(text.includes(expectText), `${phase} 态应包含「${expectText}」`);
  }
});

test('主按钮必须用静态强调色，不能拿 alias 墨色当实心底色', () => {
  const { exports } = loadBundle();
  const registrations = [];
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: (d, c) => { registrations.push({ d, c }); return () => {}; } },
  });
  const tree = registrations[0].c({ close: () => {} });

  const toggle = findAll(tree, (node) => node.type === 'button'
    && (node.children ?? []).join('').includes('开启并生成二维码'))[0];
  assert.ok(toggle, '应能找到开启按钮');
  const { background, color } = toggle.props.style;

  assert.notEqual(background, 'transparent', '主按钮背景不能是 transparent');
  // 这套设计系统里 --dsw-alias-brand-primary 是「墨色/前景色」：浅色主题近黑、
  // 深色主题近白（#f9fafb）。它**是有定义的**，所以 var() 的兜底参数不会生效 ——
  // 拿它当实心底色再配白字，就是用户看到的「按钮全白、没有文字」。
  assert.doesNotMatch(background, /--dsw-alias-brand-primary/,
    '实心按钮底色绝不能用 alias 墨色（深色主题下它是近白）');
  assert.match(background, /var\(--dsw-static-deepseek-500, #[0-9a-f]{6}\)/,
    `实心底色需用静态强调色并带兜底，实际 ${background}`);
  assert.equal(color, '#ffffff', '白字必须配足够深的静态底色');

  // 兜底 hex 的亮度必须够低，防止有人再把它换成浅色。
  const fallbackHex = background.match(/#([0-9a-f]{6})/i)[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(fallbackHex.slice(i, i + 2), 16));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  assert.ok(luminance < 0.7, `兜底底色亮度过高（${luminance.toFixed(2)}），白字会看不清`);
});

test('窄屏：只把「展开态」的会话列表撑满整屏，绝不动折叠的图标轨道', () => {
  const { exports, injectedStyles } = loadBundle();
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: () => () => {} },
  });

  // 样式在模块加载期注入（apply 之前就该在，才能赶在首帧前生效），只注入一次。
  assert.equal(injectedStyles.length, 1, '应恰好注入一条样式表');
  const tag = injectedStyles[0];
  assert.equal(tag.id, `${exports.DRAWER_STYLE_ID}`, '样式表要有稳定 id，热更新重跑工厂时据此去重');
  const css = tag.textContent;
  assert.equal(css, exports.DRAWER_CSS, '注入内容就是导出的常量');

  // 生效范围：窄屏触屏设备（含手机横屏）或极窄屏兜底；桌面窗口再窄也不碰。
  assert.ok(css.includes('@media (max-width: 1023.98px) and (hover: none), (max-width: 599.98px)'),
    '必须限定在「窄屏无悬停指针」或「极窄屏兜底」内，桌面窗口不得被改');
  assert.match(css, /max-width:\s*1023\.98px\)\s*and\s*\(hover:\s*none\)/,
    '窄屏那一档必须带 (hover: none)：否则把桌面窗口拖到 900px 也会被改到');
  assert.match(css, /,\s*\(max-width:\s*599\.98px\)/,
    '必须有极窄屏兜底：万一某内核 hover 判定异常，竖屏手机仍要生效');

  // 核心行为：展开态的帧网格让侧栏占满。
  assert.match(css, /:not\(\[data-sidebar-collapsed\]\)\s*\{[^}]*grid-template-columns:\s*100%\s+minmax\(0px,\s*1fr\)\s+minmax\(0px,\s*0px\)\s*!important/,
    '展开态必须用 100% 覆盖内联轨道，且带 !important（内联样式只能被它压过）');

  // 关键回归：**折叠态绝不能被宽度规则命中**。上一版就是撑了 56px 轨道，
  // 白占对话宽度（见 README「第 5 个缺陷」）。判据：CSS 里每次出现
  // data-sidebar-collapsed 都必须是被 :not( 取反使用。
  const occurrences = css.match(/data-sidebar-collapsed/g) ?? [];
  const negated = css.match(/:not\(\[data-sidebar-collapsed\]\)/g) ?? [];
  assert.ok(occurrences.length > 0, '展开态判据必须写在选择器里');
  assert.equal(occurrences.length, negated.length,
    'data-sidebar-collapsed 只能以 :not(...) 形式出现，否则会改到折叠的 56px 轨道');

  // 轨道宽度不能写死成任何 px —— 写死就又是上一版那个错。
  assert.doesNotMatch(css, /grid-template-columns:[^;]*\d+px\s+minmax/,
    '侧栏轨道不得写成固定 px（那正是「撑轨道」的老毛病）');

  // 右侧面板会画在整屏的会话列表之上，展开时让它让位；收起即恢复（只隐藏，不动状态）。
  assert.match(css, /:not\(\[data-sidebar-collapsed\]\)\s*\[data-sidebar-right-open\]\s*\{[^}]*display:\s*none/,
    '窄屏展开时右侧面板必须让位');
  // 钉在 280px 的 8px 拖拽把手（touch-action:none）整屏后毫无意义，且会吞滑动手势。
  assert.match(css, /:not\(\[data-sidebar-collapsed\]\)\s*\[data-side="sidebar"\]\s*\{[^}]*display:\s*none/,
    '窄屏展开时列宽拖拽把手必须隐掉');
});

test('样式注入幂等：已存在同一 id 时不重复注入', () => {
  const existing = { id: '', textContent: '' };
  const { exports, injectedStyles } = loadBundle([], undefined, {
    getElementById: (id) => (id === existing.id || id === 'dsh-mobile-remote-narrow-drawer' ? existing : null),
  });
  assert.equal(injectedStyles.length, 0, '已注入过就不得再插一条');
  assert.equal(typeof exports.apply, 'function', 'bundle 仍要正常导出');
});

test('apply 本身不再往页面里加样式（样式只在模块加载期注入一次）', () => {
  const { exports, injectedStyles } = loadBundle();
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: () => () => {} },
  });
  const afterLoad = injectedStyles.length;
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: () => () => {} },
  });
  assert.equal(injectedStyles.length, afterLoad, 'apply 不得再叠加样式表');
});

test('宿主半未加载（404）时给出可照做的提示，而不是裸 HTTP 404', () => {
  const message = '宿主半未加载（HTTP 404）。浏览器半会热更新、宿主半不会：请彻底退出 DSH 桌面客户端'
    + '（托盘图标右键退出，或在任务管理器里结束进程）后重新启动，仅关闭窗口或刷新页面无效。';
  // useState 顺序：state, error, busy, mode, ip, copied —— 取不到状态时 state 为 null
  const { exports } = loadBundle([null, message, false, 'lan', null, false]);
  const registrations = [];
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: (d, c) => { registrations.push({ d, c }); return () => {}; } },
  });
  const tree = registrations[0].c({ close: () => {} });
  const text = JSON.stringify(tree);

  assert.ok(text.includes('插件宿主半没有加载'), '应有醒目标题');
  assert.ok(text.includes('彻底退出'), '应说明要彻底退出而不是刷新');
  assert.ok(text.includes('刷新状态'), '应提供常驻的重试入口');
  assert.ok(text.includes('出错'), '状态行应为出错态，而不是「未开启」');
});

// ── 运行中切换接入模式（用户反馈：选了「公网」，界面还是「局域网」） ──────────────

const LAN_RUNNING = {
  phase: 'on', enabled: true, mode: 'lan',
  lanIps: ['192.168.1.5'], selectedIp: '192.168.1.5',
  proxyPort: 41234, targetPort: 19387,
  baseUrl: 'http://192.168.1.5:41234',
  authUrl: 'http://192.168.1.5:41234/?token=SECRET',
  publicUrl: null, provider: null,
  qrPng: 'data:image/png;base64,AAAB',
  message: '手机需与电脑在同一 Wi-Fi 下扫码；链接含一次性登录令牌，请勿分享。',
  lastError: null,
};

test('运行中改选另一种模式：按钮变成「切换并重新开启」，而不是什么都不做', () => {
  // useState 顺序：state, error, busy, mode, ip, copied —— 这里选中了 public
  const { exports } = loadBundle([LAN_RUNNING, null, false, 'public', '192.168.1.5', false]);
  const registrations = [];
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: (d, c) => { registrations.push({ d, c }); return () => {}; } },
  });
  const tree = registrations[0].c({ close: () => {} });
  const text = JSON.stringify(tree);

  const toggle = findAll(tree, (node) => node.type === 'button'
    && (node.children ?? []).join('').includes('切换'))[0];
  assert.ok(toggle, '应出现「切换…」按钮');
  assert.ok((toggle.children ?? []).join('').includes('切换到公网并重新开启'),
    `按钮文案应为「切换到公网并重新开启」，实际 ${JSON.stringify(toggle.children)}`);
  assert.ok(text.includes('当前正以「局域网」模式连接'), '应说明当前是什么模式、点一下就能切');
  assert.ok(text.includes('待切换'), '二维码区应标明「已选择公网，待切换」');

  // 关闭按钮不应再出现——此模式下主操作是「切换」，不是「关闭」
  assert.ok(!text.includes('关闭手机连接'), '待切换时不该只剩「关闭手机连接」');
});

test('点「切换」直接发 enable(public)，无需先手动关闭', async () => {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...LAN_RUNNING, mode: 'public', phase: 'starting' }),
      text: () => Promise.resolve(''),
    });
  };
  const { exports } = loadBundle([LAN_RUNNING, null, false, 'public', '192.168.1.5', false], fetchImpl);
  const registrations = [];
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: (d, c) => { registrations.push({ d, c }); return () => {}; } },
  });
  const tree = registrations[0].c({ close: () => {} });
  const toggle = findAll(tree, (node) => node.type === 'button'
    && (node.children ?? []).join('').includes('切换到公网并重新开启'))[0];

  toggle.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1, '应恰好发一次请求');
  assert.equal(calls[0].url, '/mobile-remote/enable', '应直接走 enable（宿主 start() 会先停旧会话）');
  assert.equal(JSON.parse(calls[0].init.body).mode, 'public', 'body.mode 必须是 public');
});

test('未在运行时选中公网：按钮是普通「开启并生成二维码」，且带上 mode=public', async () => {
  const calls = [];
  const off = { ...LAN_RUNNING, phase: 'off', enabled: false, qrPng: null, authUrl: null, mode: 'lan', message: '未开启' };
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(off), text: () => Promise.resolve('') });
  };
  const { exports } = loadBundle([off, null, false, 'public', null, false], fetchImpl);
  const registrations = [];
  exports.apply({
    slots: { inject: (_s, cb) => cb(), register: (d, c) => { registrations.push({ d, c }); return () => {}; } },
  });
  const tree = registrations[0].c({ close: () => {} });
  const toggle = findAll(tree, (node) => node.type === 'button'
    && (node.children ?? []).join('').includes('开启并生成二维码'))[0];

  toggle.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0].url, '/mobile-remote/enable');
  assert.equal(JSON.parse(calls[0].init.body).mode, 'public', '选中的公网模式必须传下去');
});

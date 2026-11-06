/**
 * dsh-mobile-remote —— 浏览器半（手写的 lazy-CJS 经典脚本，无构建步骤）。
 *
 * 宿主契约（dsh-client-modules）：插件 bundle 执行时只做一件事——
 * `window.__ModuleLoader__.load({ id, factory })` 注册工厂；真正的模块体在首次
 * require 时才跑。依赖走 `require("react")`（壳播种的 React），JSX 在此不可用，
 * 故统一用 `React.createElement`。
 *
 * UI 座位：`settings.section`（additive list，replaceRisk: none），注册出
 * 「设置 → 手机连接」一整页。页面数据全部来自宿主半的 /mobile-remote/* 路由
 * （与官方 /api 同一套 Host/Origin + cookie 校验，未认证一律 401）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-mobile-remote',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const ENDPOINT = '/mobile-remote';

    /** 窄屏抽屉样式的 id：工厂可能被重复执行（模块热更新），据此做幂等。 */
    const DRAWER_STYLE_ID = 'dsh-mobile-remote-narrow-drawer';

    // ── 手机端：点鲸鱼图标展开的会话列表必须撑满整屏 ──────────────────────────
    //
    // 现场：DSH 的壳在 `viewport < 1024` 时把左侧栏收成 56px 图标轨道（这是对的），
    // 点左上角那个鲸鱼图标会把轨道展开；但展开态仍沿用**桌面宽度**去挤占中间列，
    // 手机上就只剩右侧一条极窄的对话残影。用户要的是展开即整屏。
    //
    // 壳的真实结构（`dsh-client-ui-layout`）：
    //   · 帧 = 一个 CSS Grid，**内联** `grid-template-columns: <sidebar>px minmax(…) minmax(…)`，
    //     侧栏宽度由 `computeColumns()` 算出来（窄屏展开时就是 280px，写死在内联样式里）；
    //   · 折叠时帧上带 `data-sidebar-collapsed`，展开时该属性**不存在**。
    //
    // 所以：
    //   1) 只能靠外部样式表 + `!important` 覆盖内联轨道（`!important` 才能压过内联样式）；
    //   2) 只匹配**展开态**（`:not([data-sidebar-collapsed])`）—— 折叠的 56px 轨道
    //      一律不动。上一版"撑轨道"就是栽在这里：窄屏本来就该是 56px，撑宽只会白占
    //      对话宽度（回归用例断言 CSS 里每次出现 `data-sidebar-collapsed` 都带 `:not(`）；
    //   3) 用 `100%` 而不是 `100vw`：手机浏览器的 `100vw` 会把滚动条算进去；
    //   4) 帧本身没有稳定的 class（构建期哈希），只用**未哈希的钩子**定位：
    //      `data-shell-overlay` 是帧的直接子节点、`data-sidebar-collapsed` 只在折叠态出现。
    //      DSH 自己的 CSS 也在用 `:has()`。
    //
    // 生效范围有两档，**都不碰桌面**（用户要的只是"手机上撑满"，别的别动）：
    //   · `max-width:1023.98px and (hover:none)`：整段窄屏 + 无悬停指针 = 手机/平板
    //     （含手机横屏，横屏可达 900+ px）。桌面窗口即便拖到 900px 宽也是 `hover:hover`，
    //     保持原来的"280px 侧栏 + 对话共存"，一行都不改。
    //   · `max-width:599.98px`：任何设备都算。纯兜底 —— 万一某个手机内核对 `hover`
    //     判定异常，竖屏（<600px）这一档仍然必定生效，不至于"改了等于没改"。
    //
    // 展开态下两个连带问题，一并只在该状态下处理（其余状态这条 media query 完全不生效）：
    //   · 右侧面板：它挂在 `position:relative` 的右栏里、内部面板绝对定位锚在右边缘且
    //     `overflow:visible`，会把整屏的会话列表盖掉一部分 → 让位（抽屉收起即恢复）；
    //   · 列宽拖拽把手：8px、`touch-action:none`，钉在 280px 处。整屏后拖它已无意义
    //     （宽度被本样式接管），却会吞掉正好落在那一竖条上的滑动手势 → 一并隐掉。
    const DRAWER_CSS = [
      '/* dsh-mobile-remote: 窄屏（手机）下把「展开态」的会话列表撑满整屏 */',
      '@media (max-width: 1023.98px) and (hover: none), (max-width: 599.98px) {',
      '  /* 侧栏 | 中间列 | 右栏：侧栏占满，另两栏归零 */',
      '  :has(> [data-shell-overlay]):not([data-sidebar-collapsed]) {',
      '    grid-template-columns: 100% minmax(0px, 1fr) minmax(0px, 0px) !important;',
      '  }',
      '  :has(> [data-shell-overlay]):not([data-sidebar-collapsed]) [data-sidebar-right-open] {',
      '    display: none;',
      '  }',
      '  :has(> [data-shell-overlay]):not([data-sidebar-collapsed]) [data-side="sidebar"] {',
      '    display: none;',
      '  }',
      '}',
    ].join('\n');

    /** 注入窄屏抽屉样式；可重复调用（热更新重跑工厂时不会叠加）。 */
    function installDrawerCss() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(DRAWER_STYLE_ID) !== null) return;
      const tag = document.createElement('style');
      tag.id = DRAWER_STYLE_ID;
      tag.textContent = DRAWER_CSS;
      document.head.appendChild(tag);
    }

    // 模块一被 require 就注入 —— 不等 `apply`：样式要在第一次绘制前就在，且与
    // 「设置 → 手机连接」那一页是否被打开无关。
    installDrawerCss();

    // 两个坑，都踩过：
    //  1) 主题可能整条不给值 → `background: var(--x)` 失效变透明；
    //  2) 更阴的是**给了值但语义不对**：这套设计系统里
    //     `--dsw-alias-brand-primary` 是「墨色/前景色」（浅色主题=近黑，深色主题=近白
    //     #f9fafb），拿它当实心按钮底色，配上白字就是白底白字。它**有定义**，所以
    //     var() 的兜底参数根本不会生效 —— 上一版修复就是栽在这里。
    // 结论：实心按钮只用**静态调色板**（字面 hex，深浅主题一致），且仍带兜底。
    const C = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      muted: 'var(--dsw-alias-label-secondary, #57606a)',
      border: 'var(--dsw-alias-border-l1, #d1d9e0)',
      borderStrong: 'var(--dsw-alias-border-l2, #afb8c1)',
      /** 前景/强调文字与描边：跟随主题墨色（浅色近黑、深色近白） */
      ink: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      /** 实心按钮底色：静态调色板，绝不用 alias 墨色 */
      accent: 'var(--dsw-static-deepseek-500, #4176e6)',
      accentText: '#ffffff',
      success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary, #9a6700)',
      error: 'var(--dsw-alias-state-error-primary, #cf222e)',
      idle: 'var(--dsw-alias-state-idle-primary, #57606a)',
      layer1: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.06))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12))',
    };

    async function request(action, body) {
      const url = action ? `${ENDPOINT}/${action}` : `${ENDPOINT}/status`;
      const response = await fetch(url, body === undefined
        ? { headers: { accept: 'application/json' } }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        });
      if (!response.ok) {
        // 必须把 URL 与响应体一起带出来：同样是 404，"静态回退的 404"（宿主半没进树）
        // 与"插件自己回的 404（未知操作）"含义完全不同。只报状态码等于没说 ——
        // 手机端那次报错就是被这条吞掉了关键区别。
        const detail = await response.text().catch(() => '');
        const error = new Error(
          `${describeFailure(response.status)}［${url} → HTTP ${response.status}`
          + `${detail ? `｜响应体：${detail.slice(0, 160)}` : ''}］`,
        );
        error.status = response.status;
        throw error;
      }
      return response.json();
    }

    /**
     * 把 HTTP 状态翻译成「用户能照做」的话。
     *
     * 最容易被误解的一档是 404：那**不是**插件坏了，而是宿主半没进加载树——
     * 浏览器半可以随模块图热更（标签页就这么冒出来的），但宿主插件是在
     * profile 组合期挂载的，必须整个客户端重启才会生效。
     */
    function describeFailure(status) {
      if (status === 404) {
        return '宿主半未加载（HTTP 404）。浏览器半会热更新、宿主半不会：请彻底退出 DSH 桌面客户端'
          + '（托盘图标右键退出，或在任务管理器里结束进程）后重新启动，仅关闭窗口或刷新页面无效。';
      }
      if (status === 401 || status === 403) {
        return `未通过 DSH 鉴权（HTTP ${status}）。请从 DSH 界面内打开本页，不要用外部浏览器直接访问该端口。`;
      }
      return `请求失败（HTTP ${status}）。`;
    }

    const PHASE_TEXT = {
      off: '未开启',
      starting: '启动中…',
      on: '已连接',
      error: '出错',
    };

    function phaseColor(phase) {
      if (phase === 'on') return C.success;
      if (phase === 'starting') return C.warn;
      if (phase === 'error') return C.error;
      return C.idle;
    }

    function chip(active) {
      return {
        padding: '8px 14px',
        borderRadius: 8,
        border: `1px solid ${active ? C.ink : C.border}`,
        background: active ? C.layer1 : 'transparent',
        color: active ? C.ink : C.text,
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        lineHeight: '18px',
      };
    }

    /** 主按钮：必须**永远有不透明底色**，否则主题缺 token 时会变成白底白字。 */
    function primaryButton(disabled) {
      return {
        padding: '9px 18px',
        borderRadius: 8,
        border: `1px solid ${disabled ? C.border : C.accent}`,
        background: disabled ? C.layer2 : C.accent,
        color: disabled ? C.muted : C.accentText,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: '18px',
        opacity: disabled ? 0.85 : 1,
      };
    }

    function ghostButton() {
      return {
        padding: '9px 18px',
        borderRadius: 8,
        border: `1px solid ${C.borderStrong}`,
        background: 'transparent',
        color: C.text,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '18px',
      };
    }

    /** 设置项里的文本输入框。 */
    function fieldInput() {
      return {
        flex: '1 1 200px',
        minWidth: 160,
        padding: '7px 10px',
        borderRadius: 8,
        border: `1px solid ${C.borderStrong}`,
        background: C.layer1,
        color: C.text,
        fontSize: 13,
        lineHeight: '18px',
      };
    }

    function MobileRemoteSection() {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [mode, setMode] = useState('lan');
      const [ip, setIp] = useState(null);
      const [copied, setCopied] = useState(false);
      // 公网「自有域名」模式的两个必填项。DBL 刻意分开存：它们对应 Cloudflare 面板里的
      // 「公共主机名」与「服务地址」两处，改一个就必须改另一个，界面上要挨着摆。
      const [provider, setProvider] = useState('quick');
      const [publicHost, setPublicHost] = useState('');
      const [publicPort, setPublicPort] = useState('');
      // 重启后自动开启：默认打开 —— 用户要的就是「重启后不用回桌面点一下」。
      const [autoStart, setAutoStart] = useState(true);
      const alive = useRef(true);

      useEffect(() => () => { alive.current = false; }, []);

      const refresh = useCallback(async () => {
        try {
          const next = await request(null);
          if (!alive.current) return;
          setState(next);
          setError(null);
          // 只在**真的有一场会话在跑**时才用宿主的模式回填选项。
          // 宿主的默认 mode 恒为 'lan'，若无条件回填，用户刚点「公网」就会被下一次
          // 刷新（挂载时、以及 starting 期间的轮询）打回「局域网」——这正是用户看到的
          // 「选了公网页签，界面还是局域网」。
          if (next.enabled && next.mode) setMode(next.mode);
          if (next.selectedIp) setIp(next.selectedIp);
          // 偏好回填：这几个值来自磁盘，刷新时应以宿主为准（否则用户会看到自己上次的输入被吞掉）。
          if (typeof next.autoStart === 'boolean') setAutoStart(next.autoStart);
          if (next.publicProvider) setProvider(next.publicProvider);
          if (next.publicHost) setPublicHost(next.publicHost);
          if (next.publicPort) setPublicPort(String(next.publicPort));
        } catch (err) {
          if (alive.current) setError(err instanceof Error ? err.message : String(err));
        }
      }, []);

      useEffect(() => { void refresh(); }, [refresh]);

      // 公网模式建立隧道可能耗时较久，启动中持续轮询直到落到 on/error。
      useEffect(() => {
        if (state?.phase !== 'starting') return undefined;
        const timer = setInterval(() => { void refresh(); }, 1500);
        return () => clearInterval(timer);
      }, [state?.phase, refresh]);

      const act = useCallback(async (action, body) => {
        setBusy(true);
        setError(null);
        try {
          const next = await request(action, body);
          if (alive.current) {
            setState(next);
            if (next.enabled && next.mode) setMode(next.mode);
          }
        } catch (err) {
          if (alive.current) setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (alive.current) setBusy(false);
        }
      }, []);

      const copyLink = useCallback(async () => {
        if (!state?.entryUrl) return;
        try {
          await navigator.clipboard.writeText(state.entryUrl);
          setCopied(true);
          setTimeout(() => { if (alive.current) setCopied(false); }, 1600);
        } catch {
          setCopied(false);
        }
      }, [state?.entryUrl]);

      // 连状态都取不到（宿主半没加载）时，别把界面装成「未开启，一切正常」。
      const hostUnreachable = state === null && error !== null;
      const phase = state?.phase ?? (hostUnreachable ? 'error' : 'off');
      const running = phase === 'on';
      const starting = phase === 'starting';
      const lanIps = state?.lanIps ?? [];

      // 「正在跑的会话用的模式」与「用户此刻选中的模式」是两件事：
      // 运行中改选另一个模式时，必须让按钮直接变成「切换并重新开启」，
      // 否则点了页签什么都不会发生（用户就是这么卡住的）。
      const activeMode = state?.enabled ? state.mode : null;
      const pendingSwitch = Boolean(running && activeMode && mode !== activeMode);
      const MODE_LABEL = { lan: '局域网', public: '公网' };
      const toggleLabel = starting
        ? '正在开启…'
        : pendingSwitch
          ? `切换到${MODE_LABEL[mode]}并重新开启`
          : running ? '关闭手机连接' : '开启并生成二维码';
      // 宿主的 start() 本身就会先停掉旧会话，所以「切换」一次点击即可。
      const toggleAction = () => {
        const wantsDisable = running && !pendingSwitch;
        if (wantsDisable) {
          void act('disable');
          return;
        }
        void act('enable', {
          mode,
          ip,
          autoStart,
          // 公网下把「地址来源」一并带上：quick = 随机域名（每次开启都换）；
          // stable = 自有域名（固定主机名 + 固定本地端口，重启后二维码仍然有效）。
          publicProvider: mode === 'public' ? provider : undefined,
          publicHost: mode === 'public' && provider === 'stable' ? publicHost : undefined,
          publicPort: mode === 'public' && provider === 'stable' ? Number(publicPort) : undefined,
        });
      };

      const children = [];

      children.push(h('div', { key: 'intro', style: { color: C.muted, fontSize: 13, lineHeight: '20px' } },
        '手机扫码后进入与桌面端完全相同的 DSH Web UI —— 同一进程、同一会话与任务。'
        + '选择接入方式后点击开启，二维码用系统相机或微信扫一扫均可。'));

      // 出错横幅放在最上面：这是用户唯一需要先处理的事。
      if (error || state?.lastError) {
        children.push(h('div', {
          key: 'error',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 14px',
            borderRadius: 8,
            border: `1px solid ${C.error}`,
            background: C.layer1,
            color: C.text,
            fontSize: 12,
            lineHeight: '19px',
          },
        }, [
          h('div', { key: 'title', style: { color: C.error, fontWeight: 600 } },
            hostUnreachable ? '插件宿主半没有加载' : '出错了'),
          h('div', { key: 'body' }, error ?? state.lastError),
          hostUnreachable
            ? h('div', { key: 'hint', style: { color: C.muted } },
              '若重启后仍是这个提示，请在客户端安装目录下确认 profile 里已启用 dsh-mobile-remote，'
              + '并查看启动日志里的 “[mobile-remote] 已挂载” 一行。')
            : null,
        ]));
      }

      // 模式选择
      const modes = h('div', { key: 'modes', style: { display: 'flex', gap: 10, flexWrap: 'wrap' } }, [
        h('button', {
          key: 'lan',
          type: 'button',
          style: chip(mode === 'lan'),
          disabled: busy || starting,
          onClick: () => setMode('lan'),
        }, '局域网（同一 Wi-Fi）'),
        h('button', {
          key: 'public',
          type: 'button',
          style: chip(mode === 'public'),
          disabled: busy || starting,
          onClick: () => setMode('public'),
        }, '公网（任意网络，含 4G/5G）'),
      ]);
      children.push(modes);

      // 运行中改选了另一种模式：说清楚"点一下按钮就能切"，别让用户以为页签坏了。
      if (pendingSwitch) {
        children.push(h('div', {
          key: 'switch-hint',
          style: { fontSize: 12, color: C.warn, lineHeight: '18px' },
        }, `当前正以「${MODE_LABEL[activeMode]}」模式连接。点下面的「${toggleLabel}」即可直接切换，不必先手动关闭。`));
      }

      // 公网「地址来源」：这一项**直接决定重启后旧二维码还能不能用**。
      // 快速隧道的域名每次开启都换（免费隧道没有复用域名的办法）；自有域名配合常驻的
      // 命名隧道才是固定的，所以把它摆在这么前面。
      if (mode === 'public') {
        children.push(h('div', { key: 'provider', style: { display: 'flex', gap: 10, flexWrap: 'wrap' } }, [
          h('button', {
            key: 'quick',
            type: 'button',
            style: chip(provider === 'quick'),
            disabled: busy || starting,
            onClick: () => setProvider('quick'),
          }, '快速隧道（随机域名，重启要重扫）'),
          h('button', {
            key: 'stable',
            type: 'button',
            style: chip(provider === 'stable'),
            disabled: busy || starting,
            onClick: () => setProvider('stable'),
          }, '自有域名（固定，重启不用重扫）'),
        ]));

        if (provider === 'stable') {
          const row = (key, label, input) => h('label', {
            key,
            style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: C.muted },
          }, [h('span', { key: 'l', style: { minWidth: 68 } }, label), input]);

          children.push(h('div', {
            key: 'stable-config',
            style: { display: 'flex', flexDirection: 'column', gap: 8 },
          }, [
            row('host', '公网域名', h('input', {
              key: 'i',
              value: publicHost,
              placeholder: 'dsh.example.com',
              disabled: busy || starting,
              onChange: (event) => setPublicHost(event.target.value),
              style: fieldInput(),
            })),
            row('port', '本地端口', h('input', {
              key: 'i',
              value: publicPort,
              placeholder: '47823',
              inputMode: 'numeric',
              disabled: busy || starting,
              onChange: (event) => setPublicPort(event.target.value.replace(/[^\d]/g, '')),
              style: fieldInput(),
            })),
            h('div', { key: 'hint', style: { fontSize: 12, color: C.muted, lineHeight: '19px' } },
              `Cloudflare 面板里：「公共主机名」填 ${publicHost || '你的域名'}，`
              + `「服务地址」填 http://localhost:${publicPort || '上面这个端口'}。`
              + '隧道用 cloudflared 以服务方式常驻（cloudflared service install <token>），'
              + '插件不托管它、也不保存你的 Cloudflare 凭据。这样 DSH 重启后这条二维码仍然有效。'),
          ]));
        }
      }

      // 局域网网卡选择
      if (mode === 'lan' && lanIps.length > 1) {
        const options = lanIps.map((address) => h('option', { key: address, value: address }, address));
        children.push(h('div', {
          key: 'ip',
          style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: C.muted },
        }, [
          h('span', { key: 'label' }, '使用网卡地址'),
          h('select', {
            key: 'select',
            value: ip ?? lanIps[0],
            disabled: busy || starting,
            onChange: (event) => setIp(event.target.value),
            style: {
              padding: '6px 10px',
              borderRadius: 8,
              border: `1px solid ${C.borderStrong}`,
              background: C.layer1,
              color: C.text,
              fontSize: 13,
            },
          }, options),
        ]));
      }

      // 重启后自动开启：这是「不用回桌面点一下」的实现；显式关闭会把它一起关掉。
      children.push(h('label', {
        key: 'autostart',
        style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.muted },
      }, [
        h('input', {
          key: 'cb',
          type: 'checkbox',
          checked: autoStart,
          disabled: busy || starting,
          onChange: (event) => setAutoStart(event.target.checked),
        }),
        h('span', { key: 't' }, 'DSH 重启后自动按这次的形态开启（模式与端口都会记住）'),
      ]));

      // 主操作
      const actions = [
        h('button', {
          key: 'toggle',
          type: 'button',
          style: primaryButton(busy || starting),
          disabled: busy || starting,
          onClick: toggleAction,
        }, toggleLabel),
      ];
      // 刷新按钮常驻：宿主半没加载、或状态卡住时，用户至少有个明确的重试动作。
      actions.push(h('button', {
        key: 'refresh',
        type: 'button',
        style: ghostButton(),
        disabled: busy,
        onClick: () => void refresh(),
      }, '刷新状态'));
      children.push(h('div', { key: 'actions', style: { display: 'flex', gap: 10, flexWrap: 'wrap' } }, actions));

      // 状态行
      children.push(h('div', {
        key: 'status',
        style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 },
      }, [
        h('span', { key: 'dot', style: { color: phaseColor(phase), fontWeight: 600 } }, `● ${PHASE_TEXT[phase] ?? phase}`),
        state?.message ? h('span', { key: 'msg', style: { color: C.muted } }, state.message) : null,
      ]));

      // 二维码
      if (running && state?.qrPng) {
        children.push(h('div', {
          key: 'qr',
          style: { display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' },
        }, [
          h('div', {
            key: 'card',
            style: {
              background: '#fff',
              padding: 12,
              borderRadius: 12,
              border: `1px solid ${C.border}`,
              lineHeight: 0,
            },
          }, h('img', {
            src: state.qrPng,
            alt: '手机连接二维码',
            width: 224,
            height: 224,
            style: { display: 'block', imageRendering: 'pixelated' },
          })),
          h('div', {
            key: 'meta',
            style: { flex: '1 1 260px', minWidth: 240, display: 'flex', flexDirection: 'column', gap: 10 },
          }, [
            h('div', { key: 'mode', style: { fontSize: 13, color: C.text, fontWeight: 600 } },
              (state.mode === 'public'
                ? (state.publicProvider === 'stable' ? '公网 · 自有域名（固定）' : '公网隧道（cloudflared 快速隧道）')
                : '局域网直连')
              + (pendingSwitch ? `　·　已选择「${MODE_LABEL[mode]}」，待切换` : '')),
            h('div', {
              key: 'url',
              style: {
                fontSize: 12,
                color: C.muted,
                wordBreak: 'break-all',
                background: C.layer1,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: '8px 10px',
                lineHeight: '18px',
              },
            }, state.entryUrl ?? ''),
            h('div', {
              key: 'stability',
              style: { fontSize: 12, color: state.entryStable ? C.success : C.warn, lineHeight: '18px' },
            }, state.entryStable
              ? '这条地址是长期入口：DSH 重启后仍然有效，手机不用重扫。'
              : '注意：快速隧道的域名每次开启都会换，重启后这条地址会失效（改用「自有域名」可避免）。'),
            h('div', { key: 'copy', style: { display: 'flex', gap: 10, flexWrap: 'wrap' } }, [
              h('button', {
                key: 'btn',
                type: 'button',
                style: ghostButton(),
                onClick: () => void copyLink(),
              }, copied ? '已复制' : '复制链接'),
              h('button', {
                key: 'rotate',
                type: 'button',
                style: ghostButton(),
                disabled: busy,
                // 长期入口不随重启轮换，所以必须给一个显式的作废手段：换钥匙后旧链接/旧二维码立刻失效。
                onClick: () => void act('rotate-entry'),
              }, '重置长期入口'),
            ]),
            h('div', { key: 'tip', style: { fontSize: 12, color: C.muted, lineHeight: '18px' } },
              state.mode === 'public'
                ? '链接含登录令牌，等于本机 DSH 的钥匙：请勿转发给他人，用完点「关闭手机连接」。'
                : '手机需与电脑在同一 Wi-Fi；链接含登录令牌，请勿分享。'),
          ]),
        ]));
      }

      // 使用说明
      children.push(h('div', {
        key: 'help',
        style: {
          marginTop: 4,
          paddingTop: 14,
          borderTop: `1px solid ${C.border}`,
          fontSize: 12,
          color: C.muted,
          lineHeight: '20px',
        },
      }, [
        h('div', { key: 't', style: { color: C.text, fontWeight: 600, marginBottom: 4 } }, '说明'),
        h('div', { key: 'a' }, '· DSH 自身始终只监听 127.0.0.1，本功能通过本机改写代理对外开放，不会修改 dsh web 的绑定地址。'),
        h('div', { key: 'b' }, '· 手机首次扫码由 DSH 校验令牌并下发会话 cookie，之后凭 cookie 访问；代理不接触 DSH 的鉴权判断。'),
        h('div', { key: 'c' }, '· 公网模式依赖 cloudflared 快速隧道（首次会自动下载）；微信内置浏览器可直接打开该链接。'),
        h('div', { key: 'd' }, '· 手机端登录票失效时（微信回收网页、清缓存、从聊天再次打开都会这样），会显示「重新认证」页：点一下即可恢复，不用扫第二次码。'),
        h('div', { key: 'e' }, '· 二维码里是「长期入口」：只要主机名与端口不变（局域网 / 自有域名），DSH 重启后同一条链接仍然有效；快速隧道每次换域名，所以做不到。'),
        h('div', { key: 'f' }, state?.statePath ? `· 偏好与长期密钥存在 ${state.statePath}；换电脑或想彻底作废旧链接，点上面的「重置长期入口」。` : ''),
      ]));

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: '4px 2px 24px',
          color: C.text,
          maxWidth: 640,
        },
      }, children);
    }
    /** 浏览器半消费的宿主客户端服务。 */
    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'mobile-remote',
        order: 25,
        label: '手机连接',
      }, MobileRemoteSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.MobileRemoteSection = MobileRemoteSection;
    exports.DRAWER_STYLE_ID = DRAWER_STYLE_ID;
    exports.DRAWER_CSS = DRAWER_CSS;
    return module.exports;
  },
});

# 🐳 DSH Mobile Remote

> **给你的 DSH 加一条「手机遥控」通道**：桌面端点一下出二维码，手机用系统相机或微信扫一扫，
> 就进入**同一个 DSH** —— 同一进程、同一会话、同一任务队列，模型和工具全都能用。

<p>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://github.com/0231071/dsh-mobile-remote/actions/workflows/test.yml"><img alt="test" src="https://github.com/0231071/dsh-mobile-remote/actions/workflows/test.yml/badge.svg"></a>
  <img alt="runtime deps" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg">
  <img alt="tests" src="https://img.shields.io/badge/tests-42-brightgreen.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-339933.svg">
  <img alt="dsh" src="https://img.shields.io/badge/DSH-bundle%20plugin-4d6bfe.svg">
</p>

**English TL;DR** — A community DSH bundle that turns your desktop DeepSeek Harness into something you
can drive from your phone: the desktop shows a QR code, the phone scans it and lands in the *exact same*
web UI (same process, same sessions, same tools). Two transports — LAN direct, or a Cloudflare quick
tunnel when you're on 4G/5G. `dsh web` keeps listening on `127.0.0.1` only; the plugin never touches the
bind address. Zero runtime dependencies, zero build step, everything verified by real execution rather
than by assertion. Deep-dive docs are in Chinese: [`dsh-mobile-remote/README.md`](dsh-mobile-remote/README.md).

---

## 30 秒看懂

| | |
|---|---|
| **痛点** | DSH 跑在桌面上，人一离开电脑就用不了。而把它绑到 `0.0.0.0` 是官方明确拒绝的事 —— 那等于把「可执行任意命令的界面」暴露给整个网络。 |
| **做法** | DSH **仍然只听 `127.0.0.1`**。插件在 `0.0.0.0` 上另开一个**头部改写反向代理**，转发时把 `Host`/`Origin`/`Referer` 改写成回环 authority；鉴权**完全交给 DSH 自己**（二维码里装的是官方一次性 token，插件不接触任何密钥）。 |
| **结果** | 手机扫码即用。同一 Wi-Fi 走局域网直连；在外面用 4G/5G 就走 cloudflared 快速隧道。 |

```
   手机（浏览器 / 微信）
        │  扫码打开  http://<局域网IP>:<代理端口>/?token=…
        │            https://<随机>.trycloudflare.com/?token=…
        ▼
 ┌──────────────────────────────┐
 │  公网模式：cloudflared 隧道    │  quick tunnel，出站 QUIC 到 Cloudflare 边缘
 └──────────────┬───────────────┘
                ▼
 ┌──────────────────────────────┐
 │  本插件：RewriteProxy          │  监听 0.0.0.0:<随机端口>
 │  · Host → 127.0.0.1:<DSH端口>  │
 │  · Origin / Referer 同步改写    │
 │  · 双向全双工（SSE / WebSocket）│
 └──────────────┬───────────────┘
                ▼
 ┌──────────────────────────────┐
 │  官方 dsh web（只听 127.0.0.1）│  token → 303 + 会话 cookie
 │  鉴权与业务全在这里             │
 └──────────────────────────────┘
```

## 快速开始

```powershell
git clone https://github.com/0231071/dsh-mobile-remote.git
cd dsh-mobile-remote
```

**1) 装进 profile**（插件是标准 DSH bundle：宿主半 + 浏览器半）

* 推荐：在 DSH 里让 Agent 调用 `plugin_manager install_bundle`，
  `target = link:<克隆目录>/dsh-mobile-remote`；
* 或者手工：在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加
  `"dsh-mobile-remote": "link:<克隆目录>/dsh-mobile-remote"`，同名文件的
  `dsh.profile.bundles` 数组追加 `"dsh-mobile-remote"`，然后在该目录 `pnpm install`。

**2) 彻底退出 DSH 桌面客户端，再重新启动** ⚠️

> 只关窗口、刷新页面、重启 web 服务**都无效**。profile 的 bundle 列表在启动时读取；
> 热更新只覆盖已加载 entry 的重新构建，不会把新 bundle 加进树。症状很好认：你会先看到
> 「设置 → 手机连接」这个标签页冒出来（浏览器半热更了），点进去接口却报 404（宿主半没挂上）。
> 拿不准就先跑 `node dsh-mobile-remote/tools/doctor.mjs`，它会把现场判给你看。

**3) 设置 → 手机连接 → 选模式 → 开启并生成二维码 → 扫码**

> ⚠️ **公网模式：二维码出来后请等约 1 分钟再扫。** Cloudflare 快速隧道的临时域名是动态建的
> DNS 记录，实测**头 ~67 秒是 NXDOMAIN**（`tools/measure-dns-window.mjs` 可原地复现）——
> 这段时间扫，手机（微信）报的就是「无法打开页面」。二维码和 token 一直有效，**不必重新生成**；
> 界面确认域名生效后会把文案改成「现在可以扫码」。局域网模式没有这个等待。

## 三种接入方式

| 模式 | 二维码里的地址 | 适用场景 | 出口 |
|---|---|---|---|
| **局域网** | `http://<局域网IP>:<端口>/?token=…` | 手机与电脑同一 Wi-Fi | 本机代理直连，不过公网 |
| **公网** | `https://<随机>.trycloudflare.com/?token=…` | 手机在任意网络（含 4G/5G、异地） | cloudflared 快速隧道 |
| **微信** | 同上（扫一扫识别 URL 后用内置浏览器打开） | 不想装扫码 App | 首次同样走 token → cookie |

**运行中切换模式**：正在用局域网时直接点「公网」页签，主按钮会立刻变成
**「切换到公网并重新开启」**，点一下就停旧会话、起隧道、出新二维码 —— 不需要先手动关闭。

**手机端适配**：窄屏下点左上角的鲸鱼图标展开会话列表时，列表会**撑满整屏**（而不是按桌面
的 280px 挤在左边、右边留一条极窄的对话残影）。这条样式只对手机生效，桌面窗口再窄也不会被改 ——
`node dsh-mobile-remote/tools/probe-narrow-drawer.mjs` 会用 headless Chromium 把「哪些状态被改了」
逐格量给你看。

## 安全说明（请认真读）

- DSH 永远只监听 `127.0.0.1`，本插件**不改变这一点**。
- 二维码里的链接 = **本机 DSH 的钥匙**（含一次性 token）。别截图发群、别贴到聊天窗口。
- 公网模式给出的是**免登录临时域名**，任何拿到链接的人都能操作你的电脑：不用时立刻点
  **关闭手机连接**（代理端口释放、隧道进程回收、二维码清空）。
- cookie 属性为 `HttpOnly; SameSite=Strict`，**不带 `Secure`** —— 这是官方行为，也是局域网
  http 能登录的原因。
- 公网隧道是 Cloudflare 的 quick tunnel，出入口都在 Cloudflare；链路之外没有额外中间人。

## 这个项目的灵魂：5 个真实缺陷的日志

这个仓库最值钱的地方不是代码，而是 [`dsh-mobile-remote/README.md`](dsh-mobile-remote/README.md)
里那份**缺陷日志**：每一条都是真实踩出来的，**每条都有回归用例或实测数字**，也写清了当时
判断错在哪。

| # | 缺陷 | 一句话根因 |
|---|---|---|
| 1 | 插件装了但接口全 404 | 路由前缀带了尾斜杠，拼出 `/mobile-remote//`，永远匹配不上 |
| 2 | 「设置里有标签页，接口全 404，日志里还什么都没有」 | 激活期写 `process.stderr` —— Electron GUI 进程没有可用 stdio，一句就把 `apply()` 掐死在注册路由之前 |
| 3 | 主按钮白底白字、像没有文字 | 把 `--dsw-alias-brand-primary`（**墨色**，深色主题下近白）当成了实心按钮的**强调色**；而且它**有定义**，所以 `var()` 的兜底参数根本不会生效 |
| 4 | 界面谎报「公网已就绪，可以扫」，手机一扫就报错 | 就绪探针把「边缘回源有响应」与「DNS 真的生效」等量齐观；实测临时域名**头 ~67 秒是 NXDOMAIN**，而 Cloudflare 在源站没接上时还回 **530** |
| 5 | 手机展开会话列表没撑满、右边留一条窄框 | 窄屏展开态仍按**桌面宽度**（280px）算网格轨道；上一版修复还错在去撑**折叠态**的 56px 图标轨道 |

几条通用的教训，值得抄走：

- **"边缘回源有响应" ≠ "手机能打开"** —— 前者只说明隧道通了，后者还要 DNS 生效 + 响应不是 530。
- **别把主题变量当「缺失就兜底」处理** —— 它可能是「存在但语义完全不同」，用例要断言语义
  （这个颜色能不能配白字），而不只是断言"有个值"。
- **"窄屏"不等于"该撑宽"** —— 折叠的图标轨道和展开的抽屉是两回事，改之前先问清改的是哪一格。

## 验证：全是真跑出来的，不是推断

```powershell
cd dsh-mobile-remote
npm test                             # 42 项单元/集成：二维码、改写代理、宿主半、浏览器半真实执行
npm run verify                       # 端到端：自己拉起 desktop profile 的 dsh web 跑通全流程
$env:WITH_PUBLIC="1"; npm run verify # 追加公网隧道那一段
npm run e2e:lan                      # 对「已在运行的真实 dsh web」跑一次手机令牌登录链路
node tools/probe-narrow-drawer.mjs   # headless Chromium 真机量窄屏抽屉的生效范围
node tools/doctor.mjs                # 现场体检：插件到底加载到哪一步了
```

几个"不信自证"的设计：

- 二维码不走第三方库，测试里**另写了一个解码器**（逐块校验 Reed–Solomon 伴随式为零），
  再把 PNG 反解回模块矩阵 ——「编码器自己说对」不算数，得图上真的印对了才算。
- 浏览器半是手写的 lazy-CJS bundle，`test/client-bundle.test.mjs` 用 `node:vm` 复刻宿主的
  ModuleLoader 契约把它**真跑一遍**：语法错误、导出名写错、槽名写错都跑不掉。
- 窄屏抽屉那条 CSS，`tools/probe-narrow-drawer.mjs` 用真实 Chromium 量布局，并且注入的
  字节**直接取自 bundle 导出的常量** —— 保证「被验证的字节」与「发出去的字节」是同一份。

## 已知限制

- 二维码实现只支持 QR 版本 1–10、纠错等级 L/M（足够容纳最长的 token URL；URL 场景不需要更高）。
- 公网用 Cloudflare **快速隧道**：域名随机、每次开启都换、不保证 SLA。要固定域名请换成命名
  隧道（`cloudflared tunnel run` + 自己的 DNS 记录），把 `lib/tunnel.js` 的启动参数换掉即可。
- 隧道断开有看门狗（置为 error 并回收代理），但**不会自动重连**，需要手动再点一次开启。
- 局域网模式不做 HTTPS（明文流量仅本网段可嗅探；敏感场景请用公网模式）。
- 插件不持久化任何偏好（模式/端口每次都从默认值开始），因为状态就是一次会话级的「开/关」。
- 包设了 `private: true`，**不发布到 npm**：它作为 DSH bundle 以本地 `link:` 方式安装。
- 这是**社区插件，不是官方组件**。

## 目录

| 路径 | 说明 |
|---|---|
| `dsh-mobile-remote/lib/host.js` | 宿主半：状态机 + `/mobile-remote/*` 路由 + 生命周期 |
| `dsh-mobile-remote/lib/proxy.js` | 头部改写反向代理（Host/Origin/Referer + 双向全双工） |
| `dsh-mobile-remote/lib/tunnel.js` | cloudflared 受管获取 + quick tunnel + 就绪探针 + 看门狗 |
| `dsh-mobile-remote/lib/qr.js` | 自含 QR 编码器（v1–10，纠错 L/M）+ PNG 写出 |
| `dsh-mobile-remote/lib/client.js` | 浏览器半：手写 lazy-CJS bundle，注册 `settings.section` 整页 + 窄屏会话列表撑满样式 |
| `dsh-mobile-remote/test/` | 单元/集成测试 + 独立 QR 解码器（用于反证编码器） |
| `dsh-mobile-remote/tools/` | 端到端、体检与诊断脚本（不参与 `npm test`） |

## 卸载

1. `~/.dsh/profiles/desktop/package.json`：从 `dsh.profile.bundles` 去掉 `dsh-mobile-remote`，
   并从 `dependencies` 删除该 link；
2. 在该目录 `pnpm install`，重启客户端；
3. 删除 `~/.dsh/mobile-remote/`（仅当插件下载过 cloudflared 时存在）。

## 贡献与反馈

欢迎 Issue / PR。带 bug 报告时如果能附上 `node tools/doctor.mjs` 的输出，能省一大圈来回。

最有价值的贡献方向：

- **iOS / Android 真机上的窄屏适配**：目前的移动端适配是在桌面 Chromium 上量出来的，
  真机（尤其是微信内置浏览器）的反馈最有用。
- **命名隧道 / 固定域名**：把公网模式从 quick tunnel 换成自己的域名。
- **英文文档**：这份 README 的完整英译。

## License

[MIT](LICENSE) © 2026 0231071 · 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
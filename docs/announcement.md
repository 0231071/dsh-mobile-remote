# 社区发布贴（中英对照）· Community post (bilingual)

> **怎么用**：这段是给你自己看的说明，不要复制。
>
> - **贴哪里**：`deepseek-ai/deepseek-harness` → **Discussions → Show Your Plugins!**
>   （`https://github.com/deepseek-ai/deepseek-harness/discussions/new?category=show-your-plugins`）。
>   上游 `CONTRIBUTING.md` 明确**不收外部 PR**，但明确鼓励「做插件 + 用 `dsh-plugin` topic 让大家发现」——
>   这个分类就是官方给的位置。仓库已经带上 `dsh-plugin` topic 了。
> - **标题**（三选一，取下面第一行作为 Discussion 标题，正文不含标题）：
>   1. `[Plugin] DSH Mobile Remote —— 手机扫码控制电脑上的 DSH｜Control your desktop DSH from your phone with one QR scan`
>   2. `[Plugin] DSH Mobile Remote：不改绑定地址，让手机扫码用上同一个 DSH`
>   3. `DSH Mobile Remote —— 局域网 / 公网双模的手机遥控（附 5 个真实缺陷的排查日志）`
> - **配图**（强烈建议，能显著提高点击率）：正文里有两处醒目的**配图占位行**，
>   各拖一张图进去替换掉那行 —— ① 桌面端「设置 → 手机连接」；② 手机上打开后的样子。
>   GitHub 会自动上传成 user-attachments 链接。
> - **短消息版**：见文末，可直接贴到 Discord（`https://discord.gg/4MrtZUhpxg`）。
> - 正文在下面的分隔线之后；**英文与中文两版各自完整**，读者只读一版也不会缺信息。

---

**English** · [中文见下](#中文)

Hi all 👋

I built a plugin that lets you drive your **desktop** DSH from your **phone**: the desktop shows a QR code, your phone scans it (system camera or WeChat) and lands in *the exact same* web UI — same process, same sessions, same task queue, same tools.

Concretely: kick off a long task at your desk, walk away, and keep steering **the same session** from your phone — no second instance, no second login, no state to sync.

**Repo:** https://github.com/0231071/dsh-mobile-remote · MIT · tagged [`dsh-plugin`](https://github.com/topics/dsh-plugin)

> 📷 **配图 ①：换成桌面端「设置 → 手机连接」的截图 / replace with a desktop-side screenshot, then continue.**

### Two transports

| Mode | QR contains | When |
|---|---|---|
| **LAN** | `http://<lan-ip>:<port>/?token=…` | phone on the same Wi-Fi — traffic never leaves your network |
| **Public** | `https://<random>.trycloudflare.com/?token=…` | phone on 4G/5G, anywhere — `cloudflared` quick tunnel, no port forwarding, no VPS |

> 📷 **配图 ②：换成手机上打开的样子 / replace with a phone screenshot, then continue.**

### The design decision that matters: DSH is *not* bound to `0.0.0.0`

`dsh web` refuses `--host 0.0.0.0` on purpose — it would expose a UI that can run arbitrary commands. So this plugin never touches the bind address:

```
phone ──► cloudflared quick tunnel (public mode)  ──┐
phone ──► http://<lan-ip>:<port>  (LAN mode)      ──┴─► RewriteProxy on 0.0.0.0
                                                          Host/Origin/Referer → loopback authority
                                                          full-duplex (SSE + WebSocket)
                                                              │
                                                              ▼
                                              dsh web on 127.0.0.1 (unchanged)
                                              token → 303 + cookie, all auth stays here
```

1. DSH keeps listening on `127.0.0.1` only.
2. The plugin opens a separate reverse proxy that **rewrites `Host`/`Origin`/`Referer` back to the loopback authority** — that's what makes DSH's own trust check and its authority-bound session cookie work.
3. Auth is 100% DSH's: the QR carries an official one-time token, and the plugin never sees a key.

### Install (3 steps, one honest warning)

```sh
git clone https://github.com/0231071/dsh-mobile-remote.git
```

1. Install it as a bundle — `plugin_manager install_bundle`, `target = link:<clone>/dsh-mobile-remote` (or hand-edit the profile's `dependencies` + `dsh.profile.bundles`).
2. **Fully quit the desktop client and start it again.** Closing the window / refreshing / restarting the web server will *not* work: the profile's bundle list is read at startup. The tell-tale symptom is that the settings tab shows up (the client half hot-reloads) but its endpoints 404 (the host half never mounted).
3. Settings → 手机连接 → pick a mode → **开启并生成二维码** → scan.

⚠️ **Public mode: wait ~60 seconds before scanning.** The quick-tunnel hostname is a brand-new DNS record; measured, it is NXDOMAIN for the first ~67 s (`tools/measure-dns-window.mjs` reproduces this on your own machine). The QR code and token stay valid — no need to regenerate.

### Why it might be worth 10 minutes even if you don't need a phone remote

The package README keeps an honest **defect log** — five real bugs, each with a regression test or a measured number, and each written up with what I got wrong:

- one line of `process.stderr.write` during activation killed the whole plugin inside the Electron GUI (no usable stdio), and the symptom was "the tab is there, but everything 404s and the log is empty";
- a route prefix with a trailing slash can never match (`/mobile-remote//`);
- `--dsw-alias-brand-primary` is the **ink** colour, not the accent — the dark theme turns it near-white, so a "solid accent button" became white-on-white, and the `var()` fallback never fires because the variable *is* defined;
- the public-mode readiness probe treated "the Cloudflare edge answered" as "the phone can open it". It can't: DNS wasn't live yet, and Cloudflare returns **530** while the origin isn't wired up;
- the narrow-screen session drawer inherited the desktop column width. (My first attempt at that one made it worse by widening the *collapsed* icon rail — the lesson is in the README.)

The tests are written so they can't flatter themselves: the QR encoder is verified by a **separately written decoder** (Reed–Solomon syndromes must be zero, then the PNG is read back into a module matrix), the client bundle is **actually executed** under `node:vm` against the host's ModuleLoader contract, and the narrow-screen CSS is measured in a real Chromium with the very bytes the bundle exports.

`npm test` → **42 passing**, green on Node 20/22 in CI.

### Known limits

- quick tunnels are ephemeral and best-effort; use your own named tunnel if you need a stable hostname;
- DSH is in developer preview, so internal UI hooks this plugin styles may move (it degrades gracefully — the CSS just stops applying);
- LAN mode is plain http, scoped to your network.

### Feedback I'd love

Real-device reports especially — **iOS Safari / Android Chrome / WeChat's in-app browser**. And if something breaks, pasting the output of `node tools/doctor.mjs` into your reply makes it several times faster to pin down.

Thanks for the "everything is a plugin" architecture — this was the first bundle I wrote, and the plugin/seam design is what made it possible without patching anything upstream. 🐳

---

## 中文

先谢过「一切皆插件」这个架构 —— 这是我写的第一个 bundle，全程没有改动上游任何代码。

我做的是一个让**手机遥控桌面 DSH** 的插件：桌面端点一下出二维码，手机用系统相机或**微信**扫一扫，
就进入**同一个** DSH Web UI —— 同一进程、同一会话、同一任务队列，模型和工具全都能用。

具体一点：在电脑上起一个长任务，起身走开，然后在手机上接着指挥**同一个会话** ——
不需要第二个实例、不需要二次登录、不需要同步任何状态。

**仓库：** https://github.com/0231071/dsh-mobile-remote · MIT · 已带 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic

> 📷 **配图 ①：换成桌面端「设置 → 手机连接」的截图 / replace with a desktop-side screenshot, then continue.**

### 两种接入

| 模式 | 二维码里是什么 | 什么时候用 |
|---|---|---|
| **局域网** | `http://<局域网IP>:<端口>/?token=…` | 手机和电脑同一 Wi-Fi，流量不出本网段 |
| **公网** | `https://<随机>.trycloudflare.com/?token=…` | 手机在 4G/5G、异地 —— cloudflared 快速隧道，不用端口映射、不用服务器 |

> 📷 **配图 ②：换成手机上打开的样子 / replace with a phone screenshot, then continue.**

### 关键设计：**没有**把 DSH 绑到 `0.0.0.0`

`dsh web` 拒绝 `--host 0.0.0.0` 是有道理的（那等于把一个能执行任意命令的界面挂到网络上）。
所以这个插件**不碰绑定地址**：

1. DSH 依旧只听 `127.0.0.1`；
2. 插件在 `0.0.0.0` 上另开一个**头部改写反向代理**，转发时把 `Host`/`Origin`/`Referer` 改写成回环 authority ——
   这是让 DSH 自己的信任判定与「authority 绑定 cookie」正常工作的关键；
3. 鉴权 100% 交给 DSH：二维码里装的是官方一次性 token，插件不接触、不保存任何密钥。

### 三步装上（外加一句实话）

```sh
git clone https://github.com/0231071/dsh-mobile-remote.git
```

1. 作为 bundle 装进去：`plugin_manager install_bundle`，`target = link:<克隆目录>/dsh-mobile-remote`
   （或手工改 profile 的 `dependencies` 与 `dsh.profile.bundles`）；
2. **彻底退出客户端再启动** —— 只关窗口 / 刷页面 / 重启 web 服务**都无效**，profile 的 bundle 列表是启动时读的。
   症状很好认：设置里会先冒出标签页（浏览器半热更了），点进去接口却 404（宿主半没挂上）；
3. 设置 → 手机连接 → 选模式 → **开启并生成二维码** → 扫码。

⚠️ **公网模式：二维码出来请等约 60 秒再扫。** 临时域名是刚建的 DNS 记录，实测**头 ~67 秒是 NXDOMAIN**
（`tools/measure-dns-window.mjs` 可以在你自己机器上复现）。二维码和 token 一直有效，不必重新生成。

### 就算你不需要手机遥控，也值得看 10 分钟

包里的 README 留了一份**缺陷日志**：5 个真实踩出来的坑，每个都配了回归用例或实测数字，
也写清了当时判断错在哪：

- 激活期一句 `process.stderr.write` 就把整个插件掐死（Electron GUI 进程没有可用 stdio），
  现场表现是「标签页在、接口全 404、日志里还什么都没有」；
- 路由前缀带尾斜杠 = 永远匹配不上；
- `--dsw-alias-brand-primary` 是**墨色**不是强调色 —— 深色主题下它是近白，实心按钮就成了白底白字，
  而且它**有定义**，所以 `var()` 的兜底参数根本不会生效；
- 公网就绪探针把「Cloudflare 边缘有响应」当成了「手机能打开」—— 其实不能：域名还没进 DNS，
  而 Cloudflare 在源站没接上时回的是 **530**；
- 窄屏展开会话列表沿用了桌面列宽（我第一版修法还把**折叠**的 56px 图标轨道撑宽了，帮了倒忙，教训写在 README 里）。

用例也刻意做成「不能自证」：二维码编码器由**另写的一个解码器**反证（逐块验 Reed–Solomon 伴随式为零，
再把 PNG 反解回模块矩阵）；浏览器半用 `node:vm` 复刻宿主 ModuleLoader 契约**真跑一遍**；
窄屏那条 CSS 用真实 Chromium 量布局，注入的字节直接取自 bundle 导出的常量。

`npm test` → **42 项全过**，CI 在 Node 20/22 上是绿的。

### 已知限制

- 快速隧道是临时的、不保证 SLA；要固定域名请换成自己的命名隧道；
- DSH 处于开发者预览，本插件依赖的内部 UI 钩子可能会变（**失效是静默降级**，不会把页面弄坏）；
- 局域网模式是明文 http，仅限本网段。

### 想要什么反馈

最想要**真机反馈**：iOS Safari / Android Chrome / **微信内置浏览器**。
出错的话，把 `node tools/doctor.mjs` 的输出贴上来，能省一大圈来回。🐳

---

## 短消息版（直接贴 Discord）

```
DSH Mobile Remote — control your desktop DSH from your phone. Desktop shows a QR code, phone scans it
(camera or WeChat) and gets the exact same web UI. LAN direct, or a Cloudflare quick tunnel when you're on
4G. `dsh web` still listens on 127.0.0.1 only. MIT · https://github.com/0231071/dsh-mobile-remote

手机扫码遥控桌面 DSH：同一进程、同一会话、同一套工具；局域网直连或公网隧道二选一，
DSH 仍旧只听 127.0.0.1。MIT · https://github.com/0231071/dsh-mobile-remote
```
# dsh-mobile-remote

**给 DSH 桌面客户端加「手机扫码远程控制」**：桌面端点一下，出一个二维码；手机用系统相机或微信扫一扫，就打开**同一个** DSH Web UI —— 同一进程、同一会话、同一任务队列，模型和工具全都能用。

接入方式两种，覆盖「在家同一 Wi-Fi」和「在外面用 4G/5G」两种场景：

| 模式 | 二维码里的地址 | 适用场景 | 出口 |
|---|---|---|---|
| **局域网** | `http://<局域网IP>:<端口>/?token=…` | 手机与电脑同一 Wi-Fi | 本机代理直连，不过公网 |
| **公网** | `https://<随机>.trycloudflare.com/?token=…` | 手机在任意网络（含 4G/5G、异地） | cloudflared 快速隧道 |

> 界面位置：**设置 → 手机连接**。默认关闭，不点开启就什么都不会监听。

---

## 1. 为什么需要一个插件，而不是改个启动参数

官方 `dsh web` 出于安全**刻意拒绝**监听 `0.0.0.0`：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
       it would expose remote code execution to the network; use 127.0.0.1 instead
```

这句拒绝是有道理的（DSH 能跑任意命令，把它暴露到局域网等于把机器交出去）。所以本插件**不碰绑定地址**，而是：

1. DSH 依旧只听 `127.0.0.1`；
2. 本插件在 `0.0.0.0` 上另开一个**头部改写反向代理**，流量转给回环上的 DSH；
3. 代理在转发时把 `Host` / `Origin` / `Referer` 改写成回环 authority —— 这是让 DSH 的信任判定与「authority 绑定 cookie」正常工作的关键；
4. 鉴权完全交给 DSH 自己：二维码里带的是官方**进程级登录令牌**（不是一次性的 —— 进程没重启就一直有效，重启才换），首次访问由 DSH 校验并下发会话 cookie。插件不参与 DSH 的鉴权判断；它自己只持有一张**恢复票**（见 §5.1），用于在 DSH 的 cookie 失效后重新换一次票。

---

## 2. 安装

插件是一个标准 DSH bundle（`dsh.bundle.patch` + `dsh.client` 双半），以本地 link 方式装进 profile：

```powershell
git clone https://github.com/0231071/dsh-mobile-remote.git
```

```powershell
# 方式一：让 DSH 自己装（推荐）
#   在 DSH 里让 Agent 调用 plugin_manager install_bundle，
#   target = link:<克隆下来的仓库目录>/dsh-mobile-remote

# 方式二：手工装
#   1) 在 ~/.dsh/profiles/desktop/package.json 的 dependencies 加：
#        "dsh-mobile-remote": "link:<克隆下来的仓库目录>/dsh-mobile-remote"
#   2) 同名文件里的 dsh.profile.bundles 数组追加 "dsh-mobile-remote"
#   3) 在该目录执行：pnpm install
```

**装完必须重启 DSH 桌面客户端**：profile 的 bundle 列表在启动时读取，热更新只覆盖已加载 entry 的重新构建，不会把新 bundle 加进树。

卸载：从 `dsh.profile.bundles` 移除并 `pnpm remove dsh-mobile-remote`，再删目录即可（插件不写任何全局状态，除受管的 cloudflared 二进制外）。

---

## 3. 使用

1. 打开 **设置 → 手机连接**；
2. 选 **局域网** 或 **公网**（局域网模式下若有多张网卡，可挑具体那个地址）；
3. 点 **开启并生成二维码**：
   - 局域网：几乎瞬时完成；
   - 公网：首次会确认 cloudflared（PATH 里有就用现成的，没有则自动下载到 `$DSH_HOME/mobile-remote/bin`），随后建隧道并做一次探针。
     **二维码出来后请等约 1 分钟再扫**：临时域名的 DNS 记录要 30–90 秒才生效，抢先扫会得到
     「无法打开页面」（二维码不必重新生成，界面会在确认生效后提示「现在可以扫码」）；
4. 手机扫码 → 直接进入 DSH Web UI；
5. 用完点 **关闭手机连接**：代理端口释放、隧道进程回收、二维码清空。

**用一段时间后手机提示「需要重新认证」**：不用重新扫码 —— 页面上点「重新认证」即可（原因与边界见 §5）。

**运行中切换模式**：正在用局域网时想换公网，直接点「公网」页签即可 —— 主按钮会立刻变成
**「切换到公网并重新开启」**，点一下就会停掉旧会话、起隧道、出新二维码，不需要先手动关闭。
（早期版本里点页签没有任何反馈，界面仍显示局域网，看起来像页签坏了。）

**微信扫码**：微信「扫一扫」识别到 URL 后会用自己的内置浏览器打开。首次进入同样走 token → cookie 流程，之后和系统浏览器一样。链接没有 `Secure` cookie 限制，http/https 都能用。

---

## 4. 工作原理

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
 │  · 认证成功时补发「恢复票」      │
 │  · 文档 401 → 重新认证中转页    │
 └──────────────┬───────────────┘
                ▼
 ┌──────────────────────────────┐
 │  官方 dsh web（只听 127.0.0.1）│
 │  token → 303 + 会话 cookie     │  鉴权与业务全在这里
 └──────────────────────────────┘
```

三个容易踩的点，实现里都做了专门处理：

- **Prefix 路由匹配**：宿主 WebServer 的规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`。路由前缀**绝不能带尾斜杠** —— 写成 `/mobile-remote/` 会拼出 `/mobile-remote//`，任何请求都匹配不上（会表现为「插件装了但接口 404」）。
- **非升级请求强制 `Connection: close`**：这样一条连接只承载一个请求，避免 keep-alive 复用连接时第二个请求的 `Host` 没被改写。
- **双向全双工**：会话流式输出与 WebSocket 升级都靠它；客户端断开时必须连带销毁上游 socket，否则长连接会泄漏。

插件自己的 HTTP 路由（`/mobile-remote/status|enable|disable`）与官方 `/api` 走**同一套**信任判定（`connection.requestRejection`）：未带有效 cookie 一律 401。

**两个例外**：`/mobile-remote/relay`（中转页）与 `/mobile-remote/redeem`（换票入口）**刻意不挂**这道判定 —— 它们派上用场的时刻，正是手机没有 DSH cookie 的时刻；若也拦，就变成「401 页面要求你先认证」的死循环。这两条路径的安全边界由「恢复票」自己承担（见 §5.1），且都不回显任何内部状态。

---

## 5. 手机端登录票失效了怎么办

### 5.1 为什么会失效（这不是插件的 bug，是 DSH 的鉴权形态决定的）

DSH 的浏览器鉴权只有两张票：

1. **进程级登录令牌**：`BrowserAuth.launchToken`，只从 URL 进来（`GET /?token=…` → `303 Location: ./` + `Set-Cookie`）。303 之后地址栏里就没有它了。
2. **签名 cookie**：名字是 `dsh-auth-<sha256(authority)>`，值里绑死 `authority`（也就是代理改写后的回环 `127.0.0.1:<端口>`），属性 `HttpOnly; SameSite=Strict`，绝对有效期 30 天。

于是只要那张 cookie **不在**或**没被发送**，DSH 对文档请求就只回一行纯文本：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

（这句来自 `BrowserAuth.writeUnauthorized`；注意只有 **HTML 文档**和 `/connect` 走这个判定，JS/CSS 等静态资源不需要 cookie —— 所以现场表现是「整页变成这行字」，而不是白屏或转圈。）

手机端最常见的两个触发点，都不在 DSH 侧：

- **微信内置浏览器回收网页**：切后台久了 WebView 被系统/微信回收，回来时重载的是**已去掉 token 的地址**，cookie 若已不在就直接 401；
- **`SameSite=Strict` 跨站入口不发 cookie**：从聊天链接、收藏、浮窗、「最近使用」再次打开那种地址（已无 token），浏览器判定为跨站顶层导航，**不发** Strict cookie → 401。

还有一种服务端成因值得知道：DSH 的校验里有 `payload.issuedAt > now` 这一条，**电脑时钟被往回拨**（睡眠唤醒 / NTP 校时）会让已签发的 cookie 全部判无效，同样只能换新票。

### 5.2 现在的自愈路径（不必二次扫码）

- 代理在**DSH 刚认证成功的那一刻**（302/303 + 它自己的 `dsh-auth-*` cookie）顺手给这台手机补一张 `dsh-mobile-boot`（**恢复票**，`HttpOnly; SameSite=Lax`，无 `Secure`）。
  只对「DSH 已经认证过」的响应注入，**未认证访客永远拿不到** —— 否则等于把钥匙发给任何能打开隧道的人。
- 文档被 401 掉时，代理把这个响应换成**重新认证中转页**（状态仍是 401，把话说清楚 + 一个按钮），手机上不再只剩一行纯文本。
- 按钮打到 `/mobile-remote/redeem`：恢复票有效 → `302` 到 `ctx.connection.authenticatedUrl(...)`（那条带 token 的入口地址），由 **DSH 自己**重新下发会话 cookie，回到界面。
- 恢复票也没了（微信清了缓存、换了浏览器）→ 中转页直接告诉你「只能重新扫一次码」，并列出步骤；**这时不会给你一个点了必然失败的按钮** —— 一个「点了又回到同一页」的循环比没有按钮更糟。

因为用的是 `SameSite=Lax`，**上面那个「Strict 不发 cookie」的场景正好被覆盖**：跨站入口进来时 Strict cookie 缺席、恢复票在场，点一下即可恢复。

> 为什么要 `Lax` 而不是 `Strict`：要救的正是「Strict 不发」的场景。Lax 只在**顶层 GET 导航**时发送，脚本也读不到（HttpOnly），跨站子请求拿不到它。

### 5.3 恢复票的权限边界（必须说清楚）

恢复票能换出 DSH 的会话 cookie，**所以它本身就是钥匙**，与二维码里的链接同一档权限。它不比现有模型多给任何一类权限（拿到会话 cookie 的人本来就能操作这台机器），只是让「同一个浏览器」在 DSH cookie 失效后还能自己换一次票。因此：

- **每次开启连接重新生成**，关闭 / 切换模式 / 重启 DSH 即作废；
- 只以 HttpOnly cookie 形式回到那台手机的浏览器里，**不进 JSON、不进日志、不回显**；
- 中转页是**未认证可达**的静态页：不含 token、不含内部状态，外泄无害。

---

## 6. 安全说明

- DSH 永远只监听 `127.0.0.1`，本插件不改变这一点。
- 二维码里的链接 = **本机 DSH 的钥匙**（含进程级登录令牌）。别截图发群、别贴到聊天窗口。
- 公网模式给出的是**免登录临时域名**，任何拿到链接的人都能操作你的电脑：不用时立刻点「关闭手机连接」。
- DSH 自己的会话 cookie 属性为 `HttpOnly; SameSite=Strict`，**不带 `Secure`** —— 这是官方行为，也是局域网 http 可以登录的原因。
- 恢复票（`dsh-mobile-boot`）是本插件唯一的长期凭据，`HttpOnly; SameSite=Lax`，同样不带 `Secure`（否则局域网 http 下存不下来）；权限边界见 §5.3。
- 公网隧道是 Cloudflare 的 quick tunnel，出入口都在 Cloudflare；链路之外没有额外中间人。

---

## 7. 排查

| 现象 | 原因与处理 |
|---|---|
| **设置里有「手机连接」标签页，点进去底下按钮空白、文本框报 HTTP 404** | 典型「浏览器半热更了、宿主半没进加载树」。浏览器半会随模块图热更新（标签页就这么冒出来的），宿主插件却是在 profile 组合期挂载的 —— 必须**彻底退出**客户端再启动（托盘右键退出 / 任务管理器结束进程），关窗口、刷页面、重启 web 服务都无效。先跑 `node tools/doctor.mjs` 确认：`/api` 有响应但 `/mobile-remote/*` 是 404 就是这个现场；再看 `$DSH_HOME/mobile-remote/activation.log` 判断模块是否被加载、`apply()` 走到哪一步。 |
| 主按钮白底白字、像没有文字 | 主题语义坑：这套设计系统里 `--dsw-alias-brand-primary` 是**墨色/前景色**（浅色主题=近黑，深色主题=近白 `#f9fafb`），不是强调色。拿它当实心按钮底色再配白字就是白底白字 —— 而且它**有定义**，所以 `var()` 的兜底参数不会生效。现在实心按钮只用静态调色板（`--dsw-static-deepseek-500`，深浅主题一致）并带 hex 兜底。 |
| 设置里看不到「手机连接」 | bundle 没进启动树。确认 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `dsh-mobile-remote`，然后**重启**客户端。 |
| **手机扫码报「无法打开页面」** | 先判断是不是**扫早了**：quick tunnel 的临时子域是动态建的 DNS 记录，实测新域名**头 ~67 秒是 NXDOMAIN**（`node tools/measure-dns-window.mjs` 可原地复现）。这段时间里手机在任何网络都打不开，微信就显示「无法打开页面」——不是插件坏了，也不是被墙。**等 1 分钟后扫同一个二维码即可，不必重新生成**（token 一直在）。插件现在也只会在确认域名生效后才显示「现在可以扫码」。 |
| 公网模式一直显示「等待域名生效」 | 正常现象，多半是本机解析器不解析 Cloudflare 临时子域（见上一行）。插件在后台持续探针最多 3 分钟；若到点仍未确认，会如实说「未能确认域名生效」，而不是谎报就绪。手机用自己的 DNS，直接扫往往能开。 |
| 手机扫不开、电脑能开 | 局域网模式多为防火墙拦了代理端口，或手机不在同一网段（访客 Wi-Fi / AP 隔离）。先在电脑上放行该端口或改用公网模式。 |
| 公网模式最终提示「探针未通过」 | 说明本机解析不到该临时子域（部分公司网络/出口 DNS 不解析动态记录）。**不影响手机**：手机用自己的 DNS。等 1 分钟后扫同一个二维码即可确认；也可用 `node tools/check-tunnel-url.mjs <隧道地址>` 绕开本机 DNS 验证链路。 |
| 公网模式卡在「正在建立公网隧道…」 | cloudflared 首次下载慢或被墙；也可自行预装 `cloudflared` 到 PATH，插件会优先用现成的。 |
| 扫码后一直转圈 | 看一眼是不是登录令牌过期（**只有重启 DSH 才会换 token**；同一个二维码在进程没重启时一直有效）。关掉再开一次会用新 token 重新生成二维码。 |
| **用一段时间后，手机整页变成一行字：`dsh web authentication required; reopen the URL printed by dsh web.`** | 手机端那张 DSH 会话 cookie 不在了或没被发送（微信回收网页后重载、清缓存、或从聊天/收藏这类跨站入口回来时 `SameSite=Strict` 不发 cookie）。**现在不会只剩这行字**：代理会把文档 401 换成「重新认证」中转页，点一下即可恢复，不必重新扫码 —— 见 §5。若中转页按钮点了又回来（恢复票也没了），才需要重新扫一次码。先把这句原文当判据：它只由 DSH 的 `BrowserAuth.writeUnauthorized` 产生，且**只作用于 HTML 文档**，所以看到它就说明「DSH 进程和代理都还活着，只是这台手机没票」，不是隧道断了（隧道断了是「无法打开页面」）。 |
| **手机上点鲸鱼图标展开会话列表，右边还留一条窄缝、没撑满屏** | 窄屏抽屉样式没生效。它在浏览器半里，**手机上刷新一次页面**即可拿到新 bundle（不需要重启客户端、不需要重新扫码）。若刷新后仍然如此，多半是 DSH 换了 `dsh-client-ui-layout` 的 data 钩子 —— 见「第 5 个缺陷」。 |

---

## 8. 验证

仓库自带三层验证，全部离线可跑（不依赖任何外部二维码库）：

```powershell
npm test                      # 单元 + 集成：二维码、改写代理、宿主半、自愈件、浏览器半真实执行
npm run verify                # 端到端：自己拉起 desktop profile 的 dsh web，跑通全流程
$env:WITH_PUBLIC="1"; npm run verify   # 追加公网隧道那一段
npm run e2e:lan               # 对「已在运行的真实 dsh web」跑一次手机令牌登录链路
node tools/probe-narrow-drawer.mjs   # 真机(headless Chromium)量窄屏抽屉：手机撑满、折叠态与桌面一字未改
node tools/doctor.mjs         # 现场体检：判断插件加载到哪一步了
```

`npm test` 里与「登录票失效」直接相关的用例（都在 `test/proxy.test.mjs`、`test/host-plugin.test.mjs`、`test/recover.test.mjs`）：

- 文档 401 → 换成中转页；**接口/资源的 401 一字不改地透传**（不往 JSON 客户端里塞 HTML）；
- `HEAD` 文档不换页（不许有响应体）；
- DSH 认证成功时补发恢复票（`Set-Cookie` 里同时有 `dsh-auth-*` 与 `dsh-mobile-boot`）；
- **未认证访客拿不到恢复票**（否则等于把钥匙发给任何能打开隧道的人）；
- 恢复票 → `/mobile-remote/redeem` → `302` 到入口地址；**错票、关闭连接后的旧票都换不出任何地址**；
- 中转页与换票入口在 `requestRejection() === 401` 时仍可达（否则就是「401 页要求你先认证」），同时 `/status` 仍必须 401；
- 恢复票的 cookie 属性（`HttpOnly` / `SameSite=Lax` / 无 `Secure`）与定时安全比较。

`npm run verify` 实际断言的东西（每一条都对应一个真实失败模式）：

1. 启动清单里有 `dsh-mobile-remote`，且它的 combo bundle 能取到、里面含设置页注册；
2. `/mobile-remote/status` 未认证 → 401（证明没绕过鉴权），带 cookie → 200；
3. 局域网模式能进 `on`，状态里有 `qrPng` 与非空局域网 IP；
4. **把 `qrPng` 当图片解析回文本再解码，结果必须等于 `authUrl`** —— 等价于手机扫了一次；
5. 拿 `authUrl` 像手机一样走代理：`303 → cookie → 200`，且首页含 `__DSH_BOOT__`；
6. 关闭后代理端口释放、`qrPng` 清空；
7. 公网模式：cloudflared 起来 → 公网域名跑一遍未认证 401 与带 token 303/200。

其中二维码的验证方式值得一提：测试里**另写了一个解码器**（`test/qr-decode.mjs`），逐块校验 Reed–Solomon 伴随式必须为零，再配合 `test/png-matrix.mjs` 把 PNG 反解回模块矩阵。这样「编码器自己说对」不算数，得图上真的印对了才算。

### 实测结论（本机跑出来的，不是推断）

`$env:WITH_PUBLIC="1"; node tools/verify-plugin.mjs` → **全部通过，0 项失败**：

```
✅ 启动清单包含 dsh-mobile-remote
✅ 插件 client bundle 可服务        → /plugins/??dsh-mobile-remote/client.js
✅ 插件路由未认证 → 401 / 带 cookie → 200
✅ 局域网模式进入 on，二维码 37×37、纠错 M
✅ 二维码解码结果 === authUrl
✅ 手机首跳（经代理）→ 303 → 带 cookie 首页 200（含 __DSH_BOOT__）
✅ 关闭后 phase=off、qrPng 清空
✅ 公网地址 https://<随机>.trycloudflare.com
✅ 公网未认证 → 401 / 带 token → 303 / 带 cookie → 200（含 __DSH_BOOT__）
✅ 公网二维码内容 === 公网 authUrl
```

公网那一段的真实耗时值得记一笔：cloudflared **秒级**就 `Registered tunnel connection … location=hkg09 protocol=quic`，但该临时子域的 DNS 记录要 **60–80 秒**才在全球生效。这也是本插件把就绪探针改成「后台轮询、不阻塞出码」的原因 —— 早期版本阻塞等 30 秒就报失败，属于误报。

### 上线后修掉的两个真实缺陷（都有回归用例）

1. **路由前缀带尾斜杠 = 永远 404**。宿主 WebServer 的匹配规则是
   `pathname === prefix || pathname.startsWith(prefix + '/')`；前缀写成 `/mobile-remote/`
   会拼出 `/mobile-remote//`，任何请求都匹配不上。现在 `test/host-plugin.test.mjs`
   直接断言前缀不以 `/` 结尾。
2. **激活期写 `process.stderr` 会掐死整个插件**。Electron GUI 进程没有可用 stdio，
   一句 `process.stderr.write(...)` 就抛异常，把 `apply()` 拦在路由注册**之前** ——
   现场表现是「设置里有标签页，但接口全 404，宿主日志里还什么都没有」。
   现在：激活期在注册路由之前只做纯声明，日志一律走 `ctx.logger` 且包 try/catch，
   网卡探测也有安全外壳。回归用例会把 `process.stderr` 置为 `undefined` 再跑 `apply()`
   （并断言它确实被置空了），把这一行加回去就会立刻变红。

因为第 2 条暴露了「宿主 GUI 里没有任何可读证据」这个更根本的问题，现在插件会把激活
轨迹写进 `$DSH_HOME/mobile-remote/activation.log`（模块被 import、`apply()` 进入、
路由注册成功、公网探针结果、隧道意外退出）。整个写入包在 try/catch 里，跟踪失败不影响
功能；测试通过 `DSH_MOBILE_REMOTE_TRACE_DIR` 把它重定向到临时目录，不会污染你的
`~/.dsh`。

### 第 3 个缺陷：把「墨色」当成了「强调色」

上线后用户反馈「主按钮全白、没有文字」。第一版修复思路是「主题没定义该变量 → 给
`var()` 加兜底色」，**但那个前提是错的**。查 `dsh-client-ui-theme` 里的真实定义：

```css
--dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-1000);  /* 浅色主题：近黑 */
--dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50);    /* 深色主题：近白 #f9fafb */
```

`brand-primary` 是**墨色/前景色**（用来写文字、描边），深色主题下它是近白。拿它当实心
按钮底色 + 白字 = 白底白字。而且它**有定义**，所以 `var(--x, fallback)` 的兜底参数根本
不会触发 —— 上一版修复因此完全无效。现在实心按钮改用静态调色板
`var(--dsw-static-deepseek-500, #4176e6)`（深浅主题一致），回归用例同时断言「不得使用
`--dsw-alias-brand-primary` 作实心底色」以及「兜底 hex 亮度足够低（白字可读）」。

这三条的共同教训：**别把主题变量当"缺失就兜底"处理**。它可能是"存在但语义完全不同"，
而这类错误只在真实主题下才暴露 —— 所以用例要断言语义（这个颜色能不能配白字），
而不只是断言"有个值"。

### 第 4 个缺陷：探针在"边缘回源成功"时就收工，界面谎报「公网已就绪，手机可以扫」

**现场**：用户点开公网模式，二维码秒出、界面很快显示「公网已就绪，手机可在任意网络扫码」，
于是立刻用微信扫码 —— 手机报**「无法打开页面」**。

**实测（`node tools/measure-dns-window.mjs`，本机跑出来的一遍）**：新建一条 quick tunnel，
从地址生成的那一刻起同时盯 DNS 与整条链路：

```
t+  0s 本机DNS=ENOTFOUND  打开页面=ENOTFOUND
t+ 64s 本机DNS=ENOTFOUND  打开页面=ENOTFOUND      ← 前 64 秒都是 NXDOMAIN
t+ 67s 本机DNS=104.16.231.132  打开页面=✅ OK    ← 域名进入 DNS 后才可用
```

同时，cloudflared 在**隧道建好后几秒**就 `Registered tunnel connection … protocol=quic`，
于是"边缘 IP + SNI 回源"这条兜底探针在 t+几秒就成功了。

**根因**：`waitForPublicReady` 把两条证据等量齐观 —— 任一成功即 return。但两条路的证据
强度完全不同：

- `direct`（按域名直连）成功 ⇒ **临时子域的 DNS 记录已经存在**，这正是手机扫码需要的；
- `edge`（解析边缘 IP + SNI/Host 直连）成功 ⇒ 只证明"Cloudflare 边缘能把该 Host 回源到
  本机"，**完全不证明 DNS 记录存在**。

于是在域名还没生效的 60 多秒里，探针已经收工并返回 `via:'edge'`，界面据此宣告"已就绪、
可以扫"；而用户一扫，手机在**解析阶段**就失败了。更糟的是探针收工后再无人重试，
界面会**永久**停在"已就绪"，用户无从知道该再等一会儿。

**修复**（`lib/tunnel.js` + `lib/host.js`）：

1. 探针只在 `direct` 成功时提前返回；`edge` 成功仅记录，继续等 `direct` 直到超时。
   到期仍只有 `edge` 时返回 `via:'edge'`，语义明确是"隧道通、但**未能确认**域名已生效"。
2. 文案不再撒谎：只有 `via:'direct'` 才允许出现「现在可以扫码」；二维码刚出时明确写
   「请等约 1 分钟再扫；刚出码就扫会提示『无法打开页面』」，并说明**二维码不必重新生成**。
3. 还有一个更隐蔽的坑：两个探针原本把**任何** HTTP 响应都当"可达"。可 Cloudflare 在源站
   没接上时会回 HTTP **530**（"有响应"但是错误页）—— 实测隧道建好后第 5 秒边缘探针拿到的
   就是这个 530，手机打开也只会看到这张错误页。现在规则是 **`status < 500` 才算链路真的
   走到了本机 DSH**（DSH 未认证时的 401 正是合适的"通"信号）。完整实测：

   ```
   t+  3s 隧道已建（= 界面上二维码出现的时刻）
   t+  5s 边缘回源 HTTP 530  → 判为未就绪（旧代码在这里就宣告"已就绪"）
   t+ 69s 直连 HTTP 401     → 域名已生效且真的走到 DSH ⇒ 现在才说"可以扫"
   ```

**回归用例** `test/public-ready.test.mjs`（8 条）：探针做成可注入，把这条真实时序确定性地
摆出来 —— 注入"前 3 次直连失败、第 4 次成功 + 边缘立刻成功"，断言最终必须 `via:'direct'`
且直连被重试了 4 次；把提前返回那行加回去立刻变红（已实测）。另有本地假源站直连
`probeDirectFetch`，断言 530/502 必须判为未就绪；以及一组纯文案断言：`edge`/失败态
不得出现「已就绪」「现在可以扫码」。

顺便记住这个可复现的判据：**"边缘回源有响应" ≠ "手机能打开"**。前者只说明隧道通到
Cloudflare，后者还要 DNS 生效 + 响应不是 Cloudflare 错误页。

### 第 5 个缺陷：手机点开鲸鱼图标后，会话列表没有撑满整屏

**现场**：手机上点左上角第一个鲸鱼图标展开会话列表，列表**没有撑满屏幕**，右侧还留着
一条极窄的对话残影 —— 在手机上这就是「会话列表只有 2/3 宽，右边一条缝点不到」。

**根因**（都在 `dsh-client-ui-layout` 的 `AppFrame` 里）：

壳在 `viewport < 1024` 时把左侧栏收成 56px 图标轨道（**这是对的**，窄屏就该只有图标）；
点鲸鱼图标只是把 `narrowExpanded` 打开，而**展开态仍按桌面宽度算轨道**：

```js
const narrow = viewport < SIDEBAR_AUTO_COLLAPSE;              // 1024
const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;
const sidebarPreference = sidebarCollapsed ? 0 : layoutInfo.sidebar === 0 ? 280 : layoutInfo.sidebar;
const cols = computeColumns(viewport, sidebarPreference, …);  // clampWidth(280, 264, 420) = 280
```

算出来的 280px 是**内联**写到帧上的：

```html
<div class="<构建期哈希>_frame" style="grid-template-columns: 280px minmax(0px,1fr) minmax(0px,0px)">
  <div class="…_sidebarCol">…</div>   <!-- 会话列表 -->
  <div class="…_centerCol">…</div>    <!-- 对话，被挤成 viewport-280 -->
```

手机上帧宽 ≈ 390px，中间列就只剩 ~110px —— 用户看到的那条「极窄框」就是它。

**修复**（`lib/client.js`，浏览器半在模块加载期注入一条幂等的样式表）：

```css
/* 窄屏触屏设备（含手机横屏）或极窄屏兜底；桌面窗口再窄也不碰 */
@media (max-width: 1023.98px) and (hover: none), (max-width: 599.98px) {
  /* 帧 | 中间列 | 右栏：只认「展开态」（折叠时帧上带 data-sidebar-collapsed） */
  :has(> [data-shell-overlay]):not([data-sidebar-collapsed]) {
    grid-template-columns: 100% minmax(0px, 1fr) minmax(0px, 0px) !important;
  }
  /* 右栏面板锚在右边缘且 overflow:visible，会盖在整屏列表上 → 让位 */
  :has(> [data-shell-overlay]):not([data-sidebar-collapsed]) [data-sidebar-right-open] { display: none; }
  /* 8px 的列宽把手钉在 280px 处且 touch-action:none，整屏后只会吞滑动手势 → 隐掉 */
  :has(> [data-shell-overlay]):not([data-sidebar-collapsed]) [data-side="sidebar"] { display: none; }
}
```

五个要点，每一个都对应一次真实的踩坑：

1. **必须 `!important`**：轨道写在**内联样式**上，样式表里只有 important 能压过内联。
2. **只命中展开态**：折叠时帧上带 `data-sidebar-collapsed`，展开时该属性**不存在**，
   所以条件是 `:not([data-sidebar-collapsed])` —— 折叠的 56px 轨道一律不动。
   **这正是上一版的错**：那次去「撑侧栏轨道」，实际命中的是折叠态，把 56px 图标轨道撑宽、
   白占对话宽度，于是整段 CSS 被撤掉（连用例都写成了「不得注入任何样式」，见本节末尾）。
   窄屏**本来就该**是 56px 图标轨道；要撑的是**点开之后的那一层**，两者不是一回事。
3. **只用未哈希的稳定钩子**：帧自己没有稳定 class（`mP3x-q_frame` 这类构建期哈希会随版本变），
   于是用 `:has(> [data-shell-overlay])` 认帧（`data-shell-overlay` 是帧的直接子节点，全站唯一），
   用 `data-sidebar-collapsed` 认折叠态，用 `data-sidebar-right-open` / `data-side="sidebar"`
   认右栏面板与列宽把手。DSH 自己的 CSS 也在用 `:has()`。
   代价要说清楚：**这些钩子哪天变了，这条样式会静默失效**（退回 280px 的老样子），
   不会把页面弄坏 —— 对着 `dsh-client-ui-layout` 的 `AppFrame` 重新核对钩子即可。
4. **用 `100%` 而不是 `100vw`**：手机浏览器的 `100vw` 会把滚动条算进去。
5. **生效范围要卡住"只有手机"**（用户明确要求「其他地方不需要调整」）：DSH 的
   「narrow」阈值是 1024px，可**桌面窗口也能拖到 900px 宽**，那种情况下 280px 侧栏 +
   对话共存是更好的形态。所以：
   - 主条件 `max-width:1023.98px and (hover:none)` —— 窄屏 + 无悬停指针 = 手机/平板
     （**含手机横屏**，横屏可达 900+ px）；桌面窗口是 `hover:hover`，一行都不改。
   - 兜底条件 `max-width:599.98px` —— 任何设备。万一某个手机内核对 `hover` 判定异常，
     竖屏这一档仍必定生效，不至于「改了等于没改」（下面的实测里 500px 那一行就是靠它命中的）。

两个连带问题只在「窄屏 + 抽屉展开」这一个状态下顺手处理，抽屉收起立即恢复
（只加了 CSS，没有动任何状态；右栏面板、列宽把手都是隐藏而非卸载）。

**验证**（`node tools/probe-narrow-drawer.mjs`，headless Chromium **真机量布局**，不是推断）：
夹具复刻了 AppFrame 的网格、内联轨道与那三个 data 钩子，注入的 CSS **直接取
`lib/client.js` 导出的 `DRAWER_CSS` 字节** —— 保证「被验证的字节」与「发出去的字节」
是同一份；触屏那一档用 `--blink-settings=primaryHoverType=1,availableHoverTypes=1`
让 Chromium 报 `hover:none`（桌面 Chromium 默认报 `hover:hover`，正好用来验证「桌面不受影响」）：

```
BEFORE 手机竖屏(500) 鼠标  +展开 | sidebar=280  center=220  handle=block rightPanel=block
AFTER  手机竖屏(500) 鼠标  +展开 | sidebar=500  center=0    handle=none  rightPanel=none
AFTER  手机竖屏(500) 触屏  +展开 | sidebar=500  center=0    handle=none  rightPanel=none
AFTER  窄屏中段(808) 鼠标  +展开 | sidebar=280  center=528  handle=block rightPanel=block  ← 与 BEFORE 逐格一致
AFTER  窄屏中段(808) 触屏  +展开 | sidebar=808  center=0    handle=none  rightPanel=none   ← 手机横屏也撑满
AFTER  宽屏(1084)    鼠标  +展开 | sidebar=280  center=804  handle=block rightPanel=block
（上述每一档的「+折叠」一律 sidebar=56、center=frame-56，一字未改）
```

即：**只有「手机 + 展开」这一格变了**，折叠的 56px 图标轨道、宽屏桌面、以及
**窄桌面窗口**（鼠标）三格逐格未动 —— 上一版正是错在没把这几格区分开。
脚本自带 17 条断言，不符预期会以退出码 1 结束并打印实际数值。

**回归用例**（`test/client-bundle.test.mjs`，用 `node:vm` 真跑一遍 bundle）：

- 样式在**模块加载期**注入恰好一次（不等 `apply`，要赶在首帧前），id 固定，重复 `apply()`
  不再叠加，已存在同 id 时跳过；
- 断言生效范围是 `max-width:1023.98px and (hover:none)` 或 `max-width:599.98px` 兜底
  （两条都断言，缺一不可：前者护住「窄桌面窗口别被改」，后者护住「手机一定生效」），
  并含 `:not([data-sidebar-collapsed])` + `100%` + `!important`；
- 两条**专门盯住上一版那个错**的断言：CSS 里每次出现 `data-sidebar-collapsed` 都必须带
  `:not(`；`grid-template-columns` 的侧栏轨道**不得写成任何固定 px**。把「撑折叠轨道」加回去
  会立刻变红。

> 旧用例 `回到原生状态：不再向页面注入任何样式` 断言的是「一条样式都不许注入」——
> 那是早先「撑折叠轨道」那次失败留下的过度纠正。要修的是「别撑**折叠态**」，
> 不是「别注入任何样式」，该用例已按上面这两条改写。

---

## 9. 目录结构

```
dsh-mobile-remote/
├── package.json            # exports["."]=宿主半、exports["./client"]=浏览器半、dsh.client 声明
├── cordis.patch.yml        # bundle 补丁：把本包 insert 进宿主树
├── lib/
│   ├── host.js             # 宿主半：状态机 + 路由（status/enable/disable + relay/redeem）+ 生命周期
│   ├── proxy.js            # 改写代理：Host/Origin/Referer + 全双工 + 401 换中转页 + 恢复票注入
│   ├── recover.js          # 自愈件：恢复票（签发/校验/属性）+ 重新认证中转页
│   ├── tunnel.js           # cloudflared 受管获取 + quick tunnel + 就绪探针
│   ├── net.js              # 局域网 IPv4 择优（虚拟网卡垫底）
│   ├── qr.js               # 自含 QR 编码器（版本 1–10，纠错 L/M）+ PNG 写出
│   └── client.js           # 浏览器半：手写 lazy-CJS bundle，注册 settings.section + 窄屏会话列表撑满样式
├── test/                   # 单元/集成测试（*.test.mjs）+ 独立解码器
└── tools/                  # 端到端、体检与诊断脚本（不参与 npm test）
```

**浏览器半为什么是手写的、没有构建步骤**：宿主不构建第三方 bundle，缺 `exports["./client"]` 指向的成品就直接启动失败。这里用 `React.createElement` 手写那份 lazy-CJS 经典脚本，产物本身就是源码，零依赖、零构建、可审计。`test/client-bundle.test.mjs` 用 `node:vm` 复刻宿主的 ModuleLoader 契约把这份 bundle **真跑一遍**，语法错误、导出名写错、槽名写错都跑不掉。

---

## 10. 已知限制

- 只支持 QR 版本 1–10、纠错等级 L/M（足够容纳最长的 token URL；字节模式，URL 场景不需要更高）。
- 公网模式用的是 Cloudflare **快速隧道**：域名随机、每次开启都换、不保证 SLA。要固定域名请换成命名隧道（`cloudflared tunnel run` + 自己的 DNS 记录），把 `lib/tunnel.js` 的启动参数换掉即可。
- 隧道断开有看门狗（会置为 error 并回收代理），但**不会自动重连**——需要手动再点一次开启。
- 局域网模式不做 HTTPS。局域网内的明文流量仅在本网段可嗅探，敏感场景请用公网模式（https）。
- 插件不持久化任何偏好（模式/端口每次从默认值开始），因为目前的状态就是一次会话级的「开/关」。
- 自愈链路对 DSH 的两处实现细节有依赖，都属于「退化了也只会回到扫码」的优雅降级：
  1. **恢复票的注入时机**是「302/303 且响应里带 `Set-Cookie: dsh-auth-…`」。DSH 若改掉这个 cookie 前缀，代理就不再签发恢复票 —— 中转页照样出现（它只看 401），只是按钮换不出票来，需要重新扫码；
  2. **中转页只替换「文档」的 401**（`sec-fetch-dest: document` 或 `Accept: text/html`）。接口与静态资源的 401 一字不动地透传，因为客户端自己会处理它们。

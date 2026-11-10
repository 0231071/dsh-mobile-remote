<!--
提交用（本注释在 GitHub 上不显示，留着无妨）：
  标题：  [提交插件] DSH Mobile Remote —— 手机扫码远程控制桌面 DSH
  提交地址：https://github.com/2BingLing/dsh-market/issues/new?template=submit_plugin.md&labels=submission
  正文：  从下面的「## 插件信息」开始整段粘贴。
  注意：  正文里**只保留一个** github.com 链接（本仓库）。管道会正则提取正文里所有
          github.com/owner/repo 当候选仓库，多写别家链接只会往候选池里塞噪音。
-->

## 插件信息

- **GitHub 仓库地址**：https://github.com/0231071/dsh-mobile-remote
- **插件类型**：cordis-plugin
- **一句话简介**：给 DSH 桌面客户端加一条「手机遥控」通道 —— 桌面端点一下出二维码，手机用系统相机或微信扫一扫就进入**同一个会话**；局域网直连或 Cloudflare 快速隧道二选一，`dsh web` 仍然只听 127.0.0.1。
- **作者自述简介**：[ 我是这个插件的作者。起因很具体：DSH 跑在桌面上，人一离开电脑就用不了；而把它绑到 0.0.0.0 是官方明确拒绝的事，那句拒绝其实是对的 —— DSH 能跑任意命令，暴露到网络上等于把机器交出去。所以这个插件换了条路：DSH 仍旧只听 127.0.0.1，插件在旁边另开一个「头部改写反向代理」，把 Host / Origin / Referer 改写成回环 authority，鉴权 100% 还是 DSH 自己那套。手机扫码进的是同一个进程、同一个会话，不是第二个实例，不用二次登录，也没有状态要同步。踩过的坑我都写进了 README 的缺陷日志，每条都配了回归用例或实测数字。最想要真机反馈（iOS Safari / Android Chrome / 微信内置浏览器），出问题把 `node tools/doctor.mjs` 的输出贴上来，我能很快定位。 ]
- **是否已打 dsh-plugin 相关 topic**：已打 `dsh-plugin`，另有 `deepseek-harness`、`dsh`、`cloudflared`、`qrcode`、`remote-control`、`reverse-proxy`、`zero-dependency`、`mobile`

## 补充说明（可选）

### 插件本体在子目录 `dsh-mobile-remote/`

本仓库根目录放的是项目文档（`README.md`、`docs/announcement.md`），**插件本体在子目录 `dsh-mobile-remote/`** 里：
`package.json`（含 `dsh.bundle.patch` + `dsh.client` 双半声明）和 `cordis.patch.yml` 都在该目录下，
`exports` 指向 `./lib/host.js`（宿主半）与 `./lib/client.js`（浏览器半）。
如果一键安装命令需要指向子目录，麻烦按子目录 bundle 的写法生成，直接装仓库根目录会因为没有 `package.json` 而失败。

### 独特功能 / 使用场景

- **扫码进的是同一个会话，不是镜像**：同一进程、同一会话、同一任务队列，手机上接着指挥电脑上那个长任务，模型和工具都在。
- **不碰 DSH 的绑定地址**：启用前后 `dsh web` 都是 `127.0.0.1`。插件在 `0.0.0.0` 上另开代理并在转发时改写 `Host`/`Origin`/`Referer` —— 这是让 DSH 自己的信任判定与「authority 绑定 cookie」正常工作的关键。鉴权、cookie、令牌全部由 DSH 处理，插件不参与判定。
- **二维码能长期用（快速隧道下也不重扫）**：长期入口密钥和恢复票持久化在 `$DSH_HOME/mobile-remote/`，DSH 重启后入口地址不变；公网模式下 cloudflared 会被 detach 出去（Windows 上必须 `detached: true`，这条是实测出来的，README §3.2 有对照实验），下次启动探测到「端口能绑回 + 域名打过来真的到了本机」才复用同一条隧道。
- **手机端 401 自愈**：微信回收网页后重开，浏览器不会再带 `SameSite=Strict` 的会话 cookie，页面会变成一行 `dsh web authentication required`。插件给持有恢复票的请求自动 302 换票（无需点按钮），没有恢复票的才给一张中转页，不必回到电脑重新扫码。
- **零运行时依赖、无构建步骤**：手写 QR 编码器（用另写的解码器反证，逐块验 Reed–Solomon 伴随式为零）、手写极简 React 客户端 bundle、`node:http` 裸 TCP 反代。

### 需要额外配置吗

- **不需要任何 API Key、不需要注册账号。** 局域网模式零依赖；公网模式首次开启会自动把 `cloudflared` 下载到 DSH 受管目录（约 40 MB，Cloudflare 快速隧道，免注册），二维码里不包含任何 Cloudflare 凭据。
- 装完必须**完全退出桌面客户端再启动**（profile 的 bundle 列表是启动时读的，热更新不会把新 bundle 加进树）。
- 公网模式的临时域名刚建出来有约 67 秒 DNS 未生效（`tools/measure-dns-window.mjs` 可在本机复现），二维码本身一直有效，等一会儿再扫即可，不必重新生成。
- 版本/许可：MIT，`engines.node >= 20`，DSH 开发者预览期内会跟着上游内部钩子调整（失效是静默降级）。

### 截图 / 演示

仓库里暂时没有截图，两张关键图我可以补（桌面端「设置 → 手机连接」界面、手机上打开后的样子）。
可复现的验证手段有：`npm test`（75 项，含二维码解码器反证、改写代理、`node:vm` 里真跑客户端 bundle、隧道复用判定），
以及 `node tools/verify-plugin.mjs`（对着一台真实运行中的客户端做端到端体检）。

/**
 * 「登录票失效」自愈件：引导票（boot ticket）+ 重新认证中转页。
 *
 * 为什么需要它（真实现场）：DSH 的浏览器鉴权只有两张票 ——
 *  ① 进程级 token（只从 URL 进来，`GET /?token=…` → 303 换票，之后地址栏里就没有了）；
 *  ② 绑定 authority 的签名 cookie（`HttpOnly; SameSite=Strict`，30 天绝对有效期）。
 * 于是手机端只要那张 cookie 不在了（微信回收网页后重载、清缓存、换浏览器），或者
 * **没被发送**（`SameSite=Strict` 在「从聊天/收藏/浮窗跨站回到已无 token 的地址」时
 * 一律不发），文档请求就会被 DSH 回成一行纯文本：
 *
 *     dsh web authentication required; reopen the URL printed by dsh web.
 *
 * 而唯一的自救动作是「重新打开那条带 token 的 URL」——公网模式下就是「再去扫一次码」。
 * 用户手里只有同一台手机，这事儿就变成了死结。
 *
 * 本模块把这条自救路径补上：
 *  - 代理在**DSH 刚认证成功的那一刻**（302/303 + DSH 自己的 `dsh-auth-*` cookie）
 *    顺手给这台手机补一张 `dsh-mobile-boot`（下文「引导票」）。它跟 DSH 的 cookie
 *    是**两张独立**的票：DSH 换名/换代/按 authority 作废都不影响它。
 *  - 文档被 401 掉时，代理把这个响应换成一张会解释、带按钮的中转页，而不是一行纯文本。
 *  - 按钮打到 `/mobile-remote/redeem`：只要引导票还在，就 302 到
 *    `ctx.connection.authenticatedUrl(...)`（那条带 token 的 URL），由 DSH 自己重新下发
 *    会话 cookie —— **不需要第二次扫码**。
 *
 * 引导票为什么用 `SameSite=Lax` 而不是 DSH 那种 `Strict`：要救的正是「Strict 不发」的场景。
 * Lax 只在**顶层 GET 导航**时发送，脚本读不到（HttpOnly），因此跨站子请求拿不到它。
 *
 * 权限等价性（必须说清楚）：引导票能换出 DSH 会话 cookie，所以它**就是钥匙**，
 * 和二维码里的链接同一档权限。它不比现有模型多给任何一类权限，只是让「同一个浏览器」
 * 在 DSH cookie 失效后还能自己换一次票。谁拿到它，谁就等价于拿到了这台机器。
 * 因此：每次开启连接（每次出二维码）都重新生成，关闭连接即作废，绝不下发未认证的访客。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 中转页路径：文档被 401 换掉时，按钮指向的页面与它同源。 */
export const RELAY_PATH = '/mobile-remote/relay';
/** 换票入口：校验引导票后 302 到带 token 的入口地址。 */
export const REDEEM_PATH = '/mobile-remote/redeem';

/** 引导票 cookie 名。刻意与 DSH 的 `dsh-auth-` 前缀区分开：这是插件自己的票。 */
export const BOOT_COOKIE_NAME = 'dsh-mobile-boot';

/**
 * 「刚刚试过一次换票」的短命标记（60 秒）。
 *
 * 为什么需要它：换票成功后如果 DSH 仍然回 401（典型是电脑时钟被回拨，`issuedAt > now`
 * 让新票立刻失效），代理的自动恢复会变成「401 → 换票 → 401 → 换票」的无限重定向。
 * 浏览器转二十来次就报错，而用户完全看不出发生了什么。有这个标记，自动恢复就只试一次，
 * 再失败就落到中转页上把话说清楚。
 */
export const TRYING_COOKIE_NAME = 'dsh-mobile-trying';

/**
 * 引导票有效期。刻意给足（7 天）：它真正的寿命由「连接是否还开着」决定
 * —— 关闭连接、切换模式、重启 DSH 都会换一张新票，手机也就再也用不上旧票。
 * 若比 DSH 的 30 天 cookie 短，就会出现「DSH 票还活着、恢复票先过期」的倒挂，
 * 那时反而修不了，所以这里取一个明显长于日常使用时长又不至于无限期的值。
 */
export const BOOT_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** 引导票随机部分的字节数（与 DSH 自己的会话密钥同量级）。 */
const SECRET_BYTES = 32;

/** 生成一张新的引导票密钥（base64url，可直接放进 cookie 值）。 */
export function mintBootSecret() {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * 定时安全比较两张引导票。
 *
 * 用 `timingSafeEqual` 而不是 `===`：这里比较的是**密钥**，长度一致时等值提前返回会泄漏
 * 前缀信息。长度不同直接判否（长度本身不是秘密）。
 *
 * @param {unknown} presented 请求带来的值
 * @param {unknown} expected 当前有效的密钥
 * @returns {boolean}
 */
export function bootSecretMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 从 Cookie 头里取指定名字的值（不做通用 cookie 解码，保持与 DSH 自己同样的保守做法）。
 *
 * @param {string | undefined} headerValue 原始 Cookie 头
 * @param {string} name 目标 cookie 名
 * @returns {string | undefined}
 */
export function cookieValue(headerValue, name) {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * 这张请求是否带着有效的引导票。
 *
 * @param {string | undefined} cookieHeader 原始 Cookie 头
 * @param {string | null | undefined} secret 当前引导票密钥
 * @returns {boolean}
 */
export function requestHasBootTicket(cookieHeader, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  return bootSecretMatches(cookieValue(cookieHeader, BOOT_COOKIE_NAME), secret);
}

/**
 * 组装 `Set-Cookie` 头值。
 *
 * 刻意**不带 `Secure`**，与 DSH 自己的选择一致且理由相同：局域网模式下手机走的是
 * `http://<局域网IP>:<端口>`，带上 Secure 那张票就永远不会被存下来。公网模式虽是 https，
 * 但决定权在「代理到 DSH 这一段是不是 TLS」——它不是，所以不加。
 *
 * @param {string} secret 引导票密钥
 * @param {{ maxAgeSeconds?: number }} [options]
 * @returns {string}
 */
export function bootCookieSetCookie(secret, options = {}) {
  const maxAge = Number.isInteger(options.maxAgeSeconds) && options.maxAgeSeconds > 0
    ? options.maxAgeSeconds
    : BOOT_COOKIE_MAX_AGE_SECONDS;
  return `${BOOT_COOKIE_NAME}=${secret}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`;
}

/** 「刚试过一次换票」标记的 `Set-Cookie` 头值（60 秒后自动消失）。 */
export function tryingCookieSetCookie() {
  return `${TRYING_COOKIE_NAME}=1; Max-Age=60; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * 这张请求是否处于「刚试过换票」的窗口里。
 * @param {string | undefined} cookieHeader 原始 Cookie 头
 * @returns {boolean}
 */
export function requestIsRetrying(cookieHeader) {
  return cookieValue(cookieHeader, TRYING_COOKIE_NAME) === '1';
}

/** HTML 文本转义（中转页里的说明可能带外部字符串）。 */
function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 重新认证中转页。
 *
 * 三条硬约束（每一条都对应一次真实的踩坑）：
 *  1. **不引用任何外部资源**（样式内联、无脚本）：这张页面是在「手机已经没登录态」时给的，
 *     多一个外部请求就多一个失败点；也给不出可执行的 JS 来救场（文档都没过鉴权）。
 *  2. **不自动跳转**：自动跳 `/redeem` 在引导票也失效时会变成「跳一下又回来」的静默循环，
 *     用户完全看不出发生了什么。给按钮 + 一句「为什么」，让人看见。
 *  3. **不显示 token / 不显示内部状态**：这页是未认证可达的，里头只允许有静态文案。
 *
 * @param {{ note?: string | null, redeemable?: boolean }} [options]
 *   `note`：现场说明（例如「恢复票也没了」）；
 *   `redeemable`：**调用方确认换票不可能成功**时传 `false` —— 此时不再给按钮。
 *   一个点了必然失败、还写着「不用再扫码」的按钮比没有按钮更糟：它会把用户引向
 *   「点了又回来」的循环，而循环本身不解释任何事情。
 * @returns {string}
 */
export function relayPageHtml(options = {}) {
  const note = typeof options.note === 'string' && options.note.length > 0 ? options.note : null;
  const redeemable = options.redeemable !== false;
  const actions = redeemable
    ? `    <div class="actions">
      <a class="button" href="${REDEEM_PATH}">重新认证（不用再扫码）</a>
    </div>
    <p class="muted">点它会把这张票换回来，然后自动回到 DSH 界面。</p>
    <p class="muted">如果点了仍然回到这一页，说明恢复票也一起没了，按下述步骤重扫码即可。</p>`
    : `    <p class="muted">恢复票已经不在（或连接已关闭），所以这里没有可点的按钮。照下面做即可：</p>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>手机连接需要重新认证</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px 18px calc(24px + env(safe-area-inset-bottom));
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #14171c;
  }
  @media (prefers-color-scheme: dark) { body { background: #0f1115; color: #f2f4f8; } }
  .card {
    width: 100%; max-width: 460px; background: #fff; border: 1px solid #e3e6eb;
    border-radius: 16px; padding: 22px 20px 20px;
    box-shadow: 0 8px 30px rgba(15, 23, 42, .06);
  }
  @media (prefers-color-scheme: dark) { .card { background: #171a20; border-color: #262b33; } }
  h1 { margin: 0 0 10px; font-size: 18px; line-height: 1.4; }
  p { margin: 0 0 12px; }
  .muted { color: #6b7280; font-size: 13.5px; }
  @media (prefers-color-scheme: dark) { .muted { color: #9aa3af; } }
  .note {
    margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; font-size: 13.5px;
    background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412;
  }
  @media (prefers-color-scheme: dark) {
    .note { background: #2a1e12; border-color: #57330f; color: #f8c790; }
  }
  .actions { display: flex; flex-direction: column; gap: 10px; margin: 16px 0 4px; }
  a.button {
    display: block; text-align: center; text-decoration: none; font-weight: 600; font-size: 15px;
    padding: 13px 16px; border-radius: 12px; color: #fff; background: #4d6bfe;
  }
  a.button:active { background: #3f59d6; }
  ol { margin: 8px 0 0; padding-left: 20px; }
  li { margin: 4px 0; }
</style>
</head>
<body>
  <main class="card">
    <h1>手机连接需要重新认证</h1>
    <p>DSH 给这台手机发的登录票（cookie）已经不在了：网页被微信回收后重载、清过缓存、
      或者从聊天/收藏里再次打开都可能是原因。<strong>电脑那头的 DSH 没有断</strong>，任务也还在跑。</p>
${note === null ? '' : `    <p class="note">${escapeHtml(note)}</p>`}
${actions}
    <ol class="muted">
      <li>回到电脑，打开 <strong>设置 → 手机连接</strong>；</li>
      <li>用这台手机重新扫一次二维码（链接就是钥匙，别转发给他人）；</li>
      <li>用完记得点「关闭手机连接」。</li>
    </ol>
  </main>
</body>
</html>
`;
}

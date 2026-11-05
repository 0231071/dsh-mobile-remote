/**
 * 自愈件（lib/recover.js）单元验证。
 *
 * 这一层的重点不是「功能跑通」，而是**把几条不能退让的性质钉死**：
 *  - 恢复票的 cookie 属性（HttpOnly / SameSite=Lax / 无 Secure）——少一条，
 *    要么脚本能读到它（等于把钥匙交给页面），要么局域网 http 模式下根本存不下来；
 *  - 比较必须走定时安全路径（这里只验行为：等值放行、任何差异都拒绝、空值拒绝）；
 *  - 中转页必须**不含脚本、不含外部资源**，且 note 必须转义 ——
 *    这页是「手机已经没登录态」时唯一能看到的界面，绝不能再依赖任何会失败的东西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOT_COOKIE_NAME,
  REDEEM_PATH,
  RELAY_PATH,
  bootCookieSetCookie,
  bootSecretMatches,
  cookieValue,
  mintBootSecret,
  relayPageHtml,
  requestHasBootTicket,
} from '../lib/recover.js';

test('恢复票：每次都是新的 32 字节随机串，且可直接放进 cookie 值', () => {
  const a = mintBootSecret();
  const b = mintBootSecret();
  assert.notEqual(a, b, '两次签发的票不得相同');
  assert.match(a, /^[A-Za-z0-9_-]+$/, '必须是 base64url（cookie 值安全字符集）');
  assert.ok(Buffer.from(a, 'base64url').byteLength === 32, '随机部分应为 32 字节');
});

test('恢复票比较：等值放行，任何差异、空值、非字符串一律拒绝', () => {
  const secret = mintBootSecret();
  assert.equal(bootSecretMatches(secret, secret), true);
  assert.equal(bootSecretMatches(`${secret}x`, secret), false, '长度不同应拒绝');
  const flipped = `${secret.slice(0, -1)}${secret.at(-1) === 'A' ? 'B' : 'A'}`;
  assert.equal(bootSecretMatches(flipped, secret), false, '同长度也不同应拒绝');
  assert.equal(bootSecretMatches('', ''), false, '空值不得因为「空 === 空」而放行');
  assert.equal(bootSecretMatches(undefined, secret), false);
  assert.equal(bootSecretMatches(secret, null), false);
});

test('恢复票 cookie：HttpOnly + SameSite=Lax + Path=/ + 有期限，且不带 Secure', () => {
  const secret = mintBootSecret();
  const header = bootCookieSetCookie(secret);
  assert.ok(header.startsWith(`${BOOT_COOKIE_NAME}=${secret}`), '格式应为 `名字=值; 属性…`');
  assert.match(header, /HttpOnly/, '脚本不得读取恢复票（它等同钥匙）');
  assert.match(header, /SameSite=Lax/, '必须能被顶层导航带上：要救的正是 Strict 不发的场景');
  assert.match(header, /Path=\//, '必须覆盖整个应用，否则换票路径收不到它');
  assert.match(header, /Max-Age=\d+/, '必须有过期时间，不能是「关浏览器才清」的会话票');
  assert.ok(!/Secure/.test(header), '局域网是 http，带 Secure 就永远存不下来（与 DSH 自己的取舍一致）');

  const custom = bootCookieSetCookie(secret, { maxAgeSeconds: 600 });
  assert.match(custom, /Max-Age=600/);
  // 非法值必须回落到默认，而不是拼出 `Max-Age=NaN`
  assert.match(bootCookieSetCookie(secret, { maxAgeSeconds: -5 }), /Max-Age=604800/, '非法值应回落默认 7 天');
});

test('Cookie 解析：能从多个 cookie 里挑出恢复票', () => {
  const secret = mintBootSecret();
  const header = `sess=1; ${BOOT_COOKIE_NAME}=${secret}; other=2`;
  assert.equal(cookieValue(header, BOOT_COOKIE_NAME), secret);
  assert.equal(requestHasBootTicket(header, secret), true);

  assert.equal(requestHasBootTicket(`sess=1; ${BOOT_COOKIE_NAME}=wrong`, secret), false);
  assert.equal(requestHasBootTicket('sess=1', secret), false, '没有这张票就是没有');
  assert.equal(requestHasBootTicket(undefined, secret), false);
  assert.equal(requestHasBootTicket(header, null), false, '没有密钥时一律拒绝（连接已关）');
});

test('中转页：引导到换票入口、不依赖脚本或外部资源、note 必须转义', () => {
  const html = relayPageHtml();
  assert.match(html, new RegExp(`href="${REDEEM_PATH}"`), '按钮必须指向换票入口');
  assert.ok(!/<script/i.test(html), '页面上不能有脚本：它出现在没登录态时，执行环境也不可信');
  assert.ok(!/https?:\/\//i.test(html), '不得引用任何外部资源（多一个请求就多一个失败点）');
  assert.ok(!/class="note"/.test(html), '没有 note 时不应渲染提示块');
  assert.ok(html.includes('重新认证'), '得有给人看的动作文案');

  const noted = relayPageHtml({ note: '<script>alert(1)</script> & 换行驱动' });
  assert.ok(!noted.includes('<script>alert(1)</script>'), 'note 必须被转义，不能成为注入点');
  assert.match(noted, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; /);
});

test('中转页：已知换票不可能时不给按钮（点了必然回原页的按钮比没有按钮更糟）', () => {
  const blocked = relayPageHtml({ note: '恢复票也不在了', redeemable: false });
  assert.ok(!blocked.includes(`href="${REDEEM_PATH}"`), '确定换不出票时不能还摆一个按钮');
  assert.ok(!blocked.includes('不用再扫码'), '文案不得再承诺「不用再扫码」');
  assert.match(blocked, /恢复票也不在了/, '仍要把原因说清楚');
  assert.match(blocked, /二维码/, '仍要给可照做的下一步');

  // 默认（从 401 中转过来，我们并不知道手机有没有恢复票）必须给按钮
  assert.ok(relayPageHtml().includes(`href="${REDEEM_PATH}"`));
  assert.ok(relayPageHtml({ note: '现场说明' }).includes(`href="${REDEEM_PATH}"`));
});

test('路径常量：中转页与换票入口都挂在插件前缀下（不占用主应用的路径）', () => {
  assert.equal(RELAY_PATH, '/mobile-remote/relay');
  assert.equal(REDEEM_PATH, '/mobile-remote/redeem');
  for (const path of [RELAY_PATH, REDEEM_PATH]) {
    assert.ok(path.startsWith('/mobile-remote/'), `${path} 必须在插件前缀内`);
    assert.ok(!path.endsWith('/'), `${path} 不能带尾斜杠（宿主匹配规则会拼出 //）`);
  }
});

/**
 * 偏好与长期钥匙（lib/prefs.js）。
 *
 * 这一层服务的需求很具体：「DSH 重启后自动开启，且原来的二维码仍然有效」。
 * 因此要钉死的性质是：
 *  - 状态能**原样**读回来（端口、模式、两把钥匙），否则重启后就还原不出同一个入口；
 *  - 文件坏了/字段被改坏时**回落到默认值**而不是让插件起不来（激活失败=整页空白且没有日志）；
 *  - 已有的钥匙**绝不被覆盖**（覆盖=用户手机上那条长期入口直接作废）；
 *  - 写入是原子的（写一半被杀不能留下半截 JSON，那正好砸在「重启后偏好全丢」上）。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-prefs-'));
process.env.DSH_HOME = homeDir;

const {
  defaultPrefs,
  ensureSecrets,
  loadPrefs,
  mobileRemoteDir,
  normalizePrefs,
  prefsPath,
  randomKey,
  savePrefs,
} = await import('../lib/prefs.js');

after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

/** 每个用例开始前清干净。 */
function reset() {
  fs.rmSync(mobileRemoteDir(), { recursive: true, force: true });
}

test('默认值：全关、局域网、公网走快速隧道、没有钥匙', () => {
  const prefs = defaultPrefs();
  assert.equal(prefs.autoStart, false);
  assert.equal(prefs.mode, 'lan');
  assert.equal(prefs.public.provider, 'quick');
  assert.equal(prefs.entryKey, null);
  assert.equal(prefs.bootSecret, null);
});

test('归一化：坏字段一律回落，好字段照收（宽进严出）', () => {
  const prefs = normalizePrefs({
    autoStart: 'yes', // 不是布尔 → 忽略
    mode: 'wan', // 不认识 → 保留默认 lan
    lan: { ip: 42, port: '8080' }, // port 数字串可以收，ip 必须是字符串
    public: { provider: 'stable', host: 'https://DSH.Example.com/some/path', port: 47823 },
    entryKey: 'too-short', // 太短 → 不收
    bootSecret: 'A'.repeat(43),
  });
  assert.equal(prefs.autoStart, false, '非布尔应忽略');
  assert.equal(prefs.mode, 'lan', '不认识的模式应回落');
  assert.equal(prefs.lan.ip, null, '非字符串 IP 应忽略');
  assert.equal(prefs.lan.port, 8080, '数字串端口应收下');
  assert.equal(prefs.public.provider, 'stable');
  assert.equal(prefs.public.host, 'dsh.example.com', '粘贴整条 URL 也要能抽出主机名');
  assert.equal(prefs.public.port, 47823);
  assert.equal(prefs.entryKey, null, '太短的钥匙等于没有');
  assert.equal(prefs.bootSecret, 'A'.repeat(43));
});

test('主机名归一化：非法主机名一律不收（它要进 URL 与 Cloudflare 面板）', () => {
  for (const bad of ['', '   ', 'localhost', 'has space.com', 'no-dot', 'http://', '-bad.com']) {
    assert.equal(normalizePrefs({ public: { host: bad } }).public.host, null, `${JSON.stringify(bad)} 不该被收下`);
  }
  assert.equal(normalizePrefs({ public: { host: 'a-b.c-d.example.com' } }).public.host, 'a-b.c-d.example.com');
});

test('读写往返：端口、模式、公网配置与两把钥匙都能原样回来', () => {
  reset();
  const prefs = defaultPrefs();
  prefs.autoStart = true;
  prefs.mode = 'public';
  prefs.lan = { ip: '192.168.1.5', port: 47823 };
  prefs.public = { provider: 'stable', host: 'dsh.example.com', port: 47823 };
  prefs.entryKey = randomKey();
  prefs.bootSecret = randomKey();

  assert.equal(savePrefs(prefs), true, '应写入成功');
  const loaded = loadPrefs();
  assert.deepEqual(loaded, prefs, '读回来必须一模一样');

  // 原子写：不能留下临时文件
  const leftovers = fs.readdirSync(mobileRemoteDir()).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '不应残留临时文件');
});

test('文件损坏：回落默认值，绝不抛（插件必须还能起来）', () => {
  reset();
  fs.mkdirSync(mobileRemoteDir(), { recursive: true });
  fs.writeFileSync(prefsPath(), '{ this is not json', 'utf8');
  assert.deepEqual(loadPrefs(), defaultPrefs());

  fs.writeFileSync(prefsPath(), '[]', 'utf8');
  assert.deepEqual(loadPrefs(), defaultPrefs());

  assert.deepEqual(loadPrefs(), defaultPrefs(), '文件不存在时同样是默认值');
});

test('钥匙补齐：只在缺失时生成，已有的一律不覆盖', () => {
  const prefs = defaultPrefs();
  const first = ensureSecrets(prefs);
  assert.equal(first.changed, true);
  assert.ok(first.prefs.entryKey && first.prefs.bootSecret);

  const second = ensureSecrets({ ...first.prefs });
  assert.equal(second.changed, false, '两把都在时不应再改动');
  assert.equal(second.prefs.entryKey, first.prefs.entryKey, '覆盖 entryKey 等于把用户手机上那条长期入口作废');
  assert.equal(second.prefs.bootSecret, first.prefs.bootSecret);
});

test('隧道记录：三样齐全才保留，缺一样就丢掉（丢掉的代价只是下次重建隧道）', () => {
  const good = { pid: 4321, url: 'https://abc-def.trycloudflare.com', port: 51234, startedAt: 1700000000000 };
  assert.deepEqual(normalizePrefs({ tunnel: good }).tunnel, good);

  assert.equal(normalizePrefs({ tunnel: { ...good, url: 'https://evil.example.com' } }).tunnel, null,
    '只接受 trycloudflare 域名');
  assert.equal(normalizePrefs({ tunnel: { ...good, pid: 0 } }).tunnel, null);
  assert.equal(normalizePrefs({ tunnel: { ...good, port: 70000 } }).tunnel, null);
  assert.equal(normalizePrefs({ tunnel: 'nope' }).tunnel, null);
  assert.equal(normalizePrefs({}).tunnel, null, '默认没有可复用的隧道');
});

test('randomKey：每次不同，且是 cookie/URL 安全的字符集', () => {
  const keys = new Set(Array.from({ length: 50 }, () => randomKey()));
  assert.equal(keys.size, 50, '不应重复');
  for (const key of keys) {
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, `长度与字符集都不对：${key}`);
  }
});

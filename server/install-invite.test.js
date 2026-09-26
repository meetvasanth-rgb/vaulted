'use strict';

// A friend's invitation survives the install: the Play link carries the public
// profile code (Android), iPhone users type the code shown to them, and the new
// person always sees who invited them before anything is sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const activity = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const invite = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/InstallInvite.java'), 'utf8');
const gradle = fs.readFileSync(path.join(root, 'mobile/android/app/build.gradle'), 'utf8');

function extract(name, keyword = 'function') {
  const start = client.indexOf(`${keyword} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

const PLAY = 'https://play.google.com/store/apps/details?id=com.vaultlix.app';
const APPLE = 'https://apps.apple.com/in/app/vaultlix/id6798266989';

test('the store link for a friend\'s page: Play carries the code, the App Store cannot', () => {
  const context = vm.createContext({ VAULTLIX_GOOGLE_PLAY_LINK:PLAY, VAULTLIX_IOS_APP_STORE_LINK:APPLE, navigator:{}, encodeURIComponent });
  vm.runInContext(extract('inviteStoreTarget'), context);
  const target = (ua, platform = 'Linux', touch = 0) => JSON.parse(JSON.stringify(vm.runInContext(
    `inviteStoreTarget('ABC234', ${JSON.stringify(ua)}, ${JSON.stringify(platform)}, ${touch})`, context)));
  assert.deepEqual(target('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126'), { platform:'android', href:`${PLAY}&referrer=vaultlix_invite%3DABC234` });
  assert.deepEqual(target('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1'), { platform:'ios', href:APPLE });
  assert.deepEqual(target('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 'MacIntel', 5), { platform:'ios', href:APPLE }, 'iPadOS presents as a Mac');
  assert.equal(target('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome', 'MacIntel', 0), null, 'a desktop gets no store button');
  assert.equal(vm.runInContext("inviteStoreTarget('', 'Android')", context), null);
});

test('the invite code out of whatever was typed or pasted', () => {
  const context = vm.createContext({ String, normalizeProfileShareCode:value => (/^[A-HJ-NP-Z2-9]{6}$/.test(String(value).toUpperCase()) ? String(value).toUpperCase() : '') });
  vm.runInContext(extract('inviteCodeFromText'), context);
  const parse = text => vm.runInContext(`inviteCodeFromText(${JSON.stringify(text)})`, context);
  assert.equal(parse('ABC234'), 'ABC234');
  assert.equal(parse('  abc234  '), 'ABC234');
  assert.equal(parse('ABC-234'), 'ABC234');
  assert.equal(parse('abc 234'), 'ABC234');
  assert.equal(parse('P-ABC234'), 'ABC234');
  assert.equal(parse('PABC23'), 'PABC23', 'a code that happens to start with P is left alone');
  assert.equal(parse('https://vaultlix.com/p-ABC234?ref=qr'), 'ABC234');
  assert.equal(parse('open vaultlix.com/p/abc234 now'), 'ABC234');
  for (const bad of ['', 'ABC', 'ABC2345', 'ABC0O1', 'https://example.com/p-ABC234x', 'hello world', null, undefined]) assert.equal(parse(bad), '', String(bad));
});

function runCheck({ codes, checkedAfter = 0, lookup = async () => true, attempts = 0 }) {
  const log = { cleared:0, opened:[], storage:new Map(attempts ? [['vaultlix_install_invite_attempts_v1', String(attempts)]] : []) };
  let calls = 0;
  const bridge = {
    pendingInstallInvite:() => codes[Math.min(calls++, codes.length - 1)],
    installInviteChecked:() => calls > checkedAfter,
    clearInstallInvite:() => { log.cleared++; },
  };
  const context = vm.createContext({
    Date, Number, Promise, setTimeout, window:{ VaultlixAndroid:bridge },
    isNativeApp:() => true,
    normalizeProfileShareCode:value => (/^[A-HJ-NP-Z2-9]{6}$/.test(String(value)) ? String(value) : ''),
    localStorage:{ getItem:key => log.storage.get(key) ?? null, setItem:(key, value) => log.storage.set(key, value), removeItem:key => log.storage.delete(key) },
    openPublicProfileShareCode:async code => { log.opened.push(code); return lookup(code); },
    INSTALL_INVITE_ATTEMPTS_KEY:'vaultlix_install_invite_attempts_v1', INSTALL_INVITE_MAX_ATTEMPTS:3,
  });
  vm.runInContext(`${extract('checkInstallInvite', 'async function')}`, context);
  return { log, run:() => vm.runInContext('checkInstallInvite({ waitMs:200, pollMs:5 })', context) };
}

test('an invitation from the Play install opens that friend\'s page once, then is cleared', async () => {
  const t = runCheck({ codes:['ABC234'] });
  assert.equal(await t.run(), true);
  assert.deepEqual(t.log.opened, ['ABC234']);
  assert.equal(t.log.cleared, 1);
  assert.equal(t.log.storage.has('vaultlix_install_invite_attempts_v1'), false);
});

test('Google Play can take a moment on first launch: the app waits for it', async () => {
  const t = runCheck({ codes:['', '', '', 'XYZ789'], checkedAfter:99 });
  assert.equal(await t.run(), true);
  assert.deepEqual(t.log.opened, ['XYZ789']);
});

test('no invitation (Play has answered "nothing"): nothing opens and nobody is asked', async () => {
  const t = runCheck({ codes:[''], checkedAfter:0 });
  assert.equal(await t.run(), false);
  assert.deepEqual(t.log.opened, []);
  assert.equal(t.log.cleared, 0);
});

test('waiting for Play does not go on forever', async () => {
  const t = runCheck({ codes:[''], checkedAfter:1e9 });
  const started = Date.now();
  assert.equal(await t.run(), false);
  assert.ok(Date.now() - started < 1500);
});

test('a lookup that fails keeps the invitation for the next launch, but only three times', async () => {
  const failing = runCheck({ codes:['ABC234'], lookup:async () => false });
  assert.equal(await failing.run(), false);
  assert.equal(failing.log.cleared, 0, 'kept, so a bad connection does not lose it');
  assert.equal(failing.log.storage.get('vaultlix_install_invite_attempts_v1'), '1');
  const exhausted = runCheck({ codes:['ABC234'], attempts:3 });
  assert.equal(await exhausted.run(), false);
  assert.deepEqual(exhausted.log.opened, [], 'no more attempts');
  assert.equal(exhausted.log.cleared, 1, 'and it is dropped');
});

test('a browser or the iOS app (no Android bridge) does nothing', async () => {
  const context = vm.createContext({ window:{}, isNativeApp:() => true, Date });
  vm.runInContext(extract('checkInstallInvite', 'async function'), context);
  assert.equal(await vm.runInContext('checkInstallInvite()', context), false);
});

test('the pages: a store button on a friend\'s page, and "Have an invite code?" where a new person starts', () => {
  assert.match(client, /id="public-profile-get-app"/);
  assert.match(extract('performPublicProfileLookup', 'async function'), /showInviteGetApp\(result\.profile\)/);
  assert.match(extract('showInviteGetApp'), /isNativeApp\(\) \? null : inviteStoreTarget\(code\)/);
  assert.match(client, /class="landing-invite-link" type="button" onclick="openInviteCodePrompt\(\)">Have an invite code\?/);
  assert.match(client, /id="native-onboarding-invite"[^>]*onclick="openInviteCodePrompt\(\)"/);
  assert.match(extract('renderNativeOnboarding'), /inviteButton\.style\.display = page === 'welcome' \|\| page === 'identity' \? '' : 'none'/);
  assert.match(client, /onclick="closeNewConnection\(\);openInviteCodePrompt\(\)">Have an invite code\?/);
  assert.match(client, /id="invite-code-overlay"/);
});

test('the invite code goes through the same public, rate-limited lookup and shows the person before anything is sent', () => {
  assert.match(extract('submitInviteCode', 'async function'), /openPublicProfileShareCode\(code, \{ onError:setInviteCodeError \}\)/);
  assert.doesNotMatch(extract('submitInviteCode', 'async function'), /connections\/request|requestPrivateVault/, 'entering a code sends nothing');
  assert.doesNotMatch(extract('checkInstallInvite', 'async function'), /connections\/request|requestPrivateVault/, 'neither does an install invitation');
  assert.match(client, /const opened = await openPublicProfileShareCode\(code\);\s*if \(opened\) \{/);
});

test('the startup only asks for an install invitation when the app was not opened by a link', () => {
  assert.match(client, /if \(!publicProfileShareCode && !publicPrivateNumber && !startupRecovery && !startupConnectionRequestId && !pendingNumberGift\s*&& !loadQuickConnectTarget\(\)\) \{\s*checkInstallInvite\(\)\.catch\(\(\) => \{\}\);/);
});

test('Android: the install referrer is read once, validated, and offered to the page through the bridge', () => {
  assert.match(gradle, /implementation 'com\.android\.installreferrer:installreferrer:2\.2'/);
  assert.match(activity, /InstallInvite\.checkOnce\(getApplicationContext\(\)\);/);
  for (const method of ['pendingInstallInvite', 'installInviteChecked', 'clearInstallInvite']) {
    assert.match(activity, new RegExp(`@JavascriptInterface\\s+public \\w+ ${method}\\(`), method);
  }
  assert.match(invite, /\[A-HJ-NP-Z2-9\]\{6\}/);
  assert.match(invite, /MAX_AGE_SECONDS = 7L \* 24 \* 60 \* 60/);
  assert.match(invite, /SERVICE_UNAVAILABLE/);
  assert.doesNotMatch(invite, /getInstallReferrer\(\)\.getInstallReferrer\(\)[^;]*Log\./);
});

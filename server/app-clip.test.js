'use strict';

// The iPhone App Clip: scanning a friend's QR without Vaultlix installed shows
// the invitation, saves the friend's public code where the full app can read it
// after install, and the app then opens that friend's page. The pieces that can be
// checked without a phone are checked here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const client = read('client/index.html');
const project = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
const scene = read('mobile/ios/App/App/SceneDelegate.swift');
const appEntitlements = read('mobile/ios/App/App/App.entitlements');
const clipEntitlements = read('mobile/ios/App/VaultlixClip/VaultlixClip.entitlements');
const clipInfo = read('mobile/ios/App/VaultlixClip/Info.plist');
const aasa = JSON.parse(read('client/.well-known/apple-app-site-association'));

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

test('the website tells iOS which App Clip belongs to Vaultlix', () => {
  assert.deepEqual(aasa.appclips, { apps:['3KLX2S84MV.com.vaultlix.app.Clip'] });
  assert.ok(aasa.applinks.details.length > 0, 'the full app\'s universal links are untouched');
});

test('the App Clip target is embedded in the app and shares the invitation code and app group', () => {
  assert.match(project, /productType = "com\.apple\.product-type\.application\.on-demand-install-capable"/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.vaultlix\.app\.Clip;/);
  assert.match(project, /name = "Embed App Clips";/);
  assert.match(project, /dstPath = "\$\(CONTENTS_FOLDER_PATH\)\/AppClips";/);
  assert.match(project, /dstSubfolderSpec = 16;/);
  // The shared invitation files are compiled into both the app and the clip.
  for (const file of ['InviteLink.swift', 'SharedInvite.swift']) {
    assert.equal((project.match(new RegExp(`${file} in Sources \\*/ = \\{isa = PBXBuildFile`, 'g')) || []).length, 2, `${file} in both targets`);
  }
  // The app and the clip carry the same build number.
  const numbers = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(match => match[1]);
  assert.equal(new Set(numbers).size, 1, `one build number everywhere: ${numbers.join(',')}`);
});

test('entitlements: the clip is invoked from vaultlix.com and shares the group with the app', () => {
  assert.match(appEntitlements, /com\.apple\.security\.application-groups[\s\S]*group\.com\.vaultlix\.app/);
  assert.match(clipEntitlements, /com\.apple\.security\.application-groups[\s\S]*group\.com\.vaultlix\.app/);
  assert.match(clipEntitlements, /appclips:vaultlix\.com/);
  assert.match(clipEntitlements, /com\.apple\.developer\.parent-application-identifiers[\s\S]*\$\(AppIdentifierPrefix\)com\.vaultlix\.app/);
  assert.match(appEntitlements, /applinks:vaultlix\.com/, 'the app keeps its universal links');
  assert.match(clipInfo, /<key>NSAppClip<\/key>/);
  assert.match(clipInfo, /NSAppClipRequestEphemeralUserNotification<\/key>\s*<false\/>/);
  assert.match(clipInfo, /NSAppClipRequestLocationConfirmation<\/key>\s*<false\/>/);
});

test('the clip is small and asks for nothing: no calling, no encrypted storage, no permissions', () => {
  assert.doesNotMatch(clipInfo, /UsageDescription|UIBackgroundModes/);
  const sources = ['VaultlixClipApp.swift', 'InviteModel.swift', 'InviteView.swift'].map(file => read(`mobile/ios/App/VaultlixClip/${file}`)).join('\n');
  assert.doesNotMatch(sources, /import (WebRTC|SQLCipher|Capacitor|AVFoundation|CallKit|PushKit)/);
  // It only reads the public, unauthenticated lookup; nothing about the person is sent.
  assert.match(sources, /https:\/\/vaultlix\.com\\\(InviteLink\.lookupPath\(for: target\)\)/);
  assert.doesNotMatch(sources, /httpMethod\s*=\s*"POST"/);
  assert.match(sources, /SharedInvite\.save\(code: friend\.code\)/);
  assert.match(sources, /SKOverlay\.AppClipConfiguration/);
});

test('the full app hands the saved invitation to the page, validated, and lets it clear it', () => {
  assert.match(scene, /if let code = SharedInvite\.pendingCode\(\) \{/);
  assert.match(scene, /window\.__vaultlixIOSInstallInvite = '\\\(code\)';/);
  assert.match(scene, /action == "clearInstallInvite"[\s\S]*securityOrigin\.host == "vaultlix\.com"[\s\S]*SharedInvite\.clear\(\)/);
  const shared = read('mobile/ios/App/Shared/SharedInvite.swift');
  assert.match(shared, /guard InviteLink\.isValidShareCode\(code\)/, 'only a well-formed code is ever stored (so it is safe in a script)');
  assert.match(shared, /maxAge: TimeInterval = 7 \* 24 \* 60 \* 60/);
});

function runIos({ code = 'ABC234', done = null, lookup = async () => true } = {}) {
  const log = { posted:[], opened:[], storage:new Map(done ? [['vaultlix_install_invite_done_v1', done]] : []) };
  const context = vm.createContext({
    Date, Number, Promise, setTimeout,
    window:{ __vaultlixIOSInstallInvite:code, webkit:{ messageHandlers:{ vaultlixCall:{ postMessage:message => log.posted.push(message) } } } },
    isNativeApp:() => true,
    normalizeProfileShareCode:value => (/^[A-HJ-NP-Z2-9]{6}$/.test(String(value)) ? String(value) : ''),
    localStorage:{ getItem:key => log.storage.get(key) ?? null, setItem:(key, value) => log.storage.set(key, value), removeItem:key => log.storage.delete(key) },
    openPublicProfileShareCode:async value => { log.opened.push(value); return lookup(value); },
    INSTALL_INVITE_ATTEMPTS_KEY:'vaultlix_install_invite_attempts_v1', INSTALL_INVITE_MAX_ATTEMPTS:3,
  });
  vm.runInContext(`${extract('installInviteSource')}\nconst INSTALL_INVITE_DONE_KEY = 'vaultlix_install_invite_done_v1';\n${extract('checkInstallInvite', 'async function')}`, context);
  return { log, run:() => vm.runInContext('checkInstallInvite({ waitMs:100, pollMs:5 })', context) };
}

test('iPhone: the App Clip\'s invitation opens that friend\'s page once and is cleared', async () => {
  const t = runIos();
  assert.equal(await t.run(), true);
  assert.deepEqual(t.log.opened, ['ABC234']);
  assert.deepEqual(JSON.parse(JSON.stringify(t.log.posted)), [{ action:'clearInstallInvite' }]);
  assert.equal(t.log.storage.get('vaultlix_install_invite_done_v1'), 'ABC234');
});

test('iPhone: the same code is not shown again if the page reloads before the app restarts', async () => {
  const t = runIos({ done:'ABC234' });
  assert.equal(await t.run(), false);
  assert.deepEqual(t.log.opened, []);
  assert.deepEqual(JSON.parse(JSON.stringify(t.log.posted)), [{ action:'clearInstallInvite' }]);
});

test('iPhone: a new code after an earlier one is shown', async () => {
  const t = runIos({ code:'XYZ789', done:'ABC234' });
  assert.equal(await t.run(), true);
  assert.deepEqual(t.log.opened, ['XYZ789']);
});

test('iPhone: nothing saved means nothing happens', async () => {
  const context = vm.createContext({ window:{ webkit:{} }, isNativeApp:() => true, Date });
  vm.runInContext(`${extract('installInviteSource')}\n${extract('checkInstallInvite', 'async function')}`, context);
  assert.equal(await vm.runInContext('checkInstallInvite()', context), false);
});

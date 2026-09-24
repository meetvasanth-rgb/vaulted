const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'client/sw.js'), 'utf8');
const capacitor = JSON.parse(fs.readFileSync(path.join(root, 'mobile/capacitor.config.json'), 'utf8'));
const offline = fs.readFileSync(path.join(root, 'mobile/www/offline.html'), 'utf8');
const iosManager = fs.readFileSync(path.join(root, 'mobile/ios/App/App/AppDelegate.swift'), 'utf8');
const iosScene = fs.readFileSync(path.join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');

test('mobile shells replace the browser network error with a local offline page', () => {
  assert.equal(capacitor.server.errorPath, 'offline.html');
  assert.match(offline, /Vaultlix is offline/);
  assert.match(offline, /window\.addEventListener\('online'/);
});

test('service worker caches only static app-shell routes for offline navigation', () => {
  assert.match(worker, /APP_SHELL_CACHE/);
  assert.match(worker, /request\.mode === 'navigate'/);
  assert.match(worker, /cache\.match\('\/index\.html'\)/);
  assert.match(worker, /nativeAndroid && cachedShell/);
  assert.match(worker, /event\.waitUntil/);
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(worker, /cache\.put\([^\n]*(?:api|message|cipher|account|key)/i);
  assert.match(client, /registerServiceWorker\(\)\.catch/);
  assert.match(client, /function renderOfflineState\(\)/);
  assert.doesNotMatch(client, /You’re offline\. Vaultlix will reconnect automatically\./);
});

test('incoming CallKit flow holds the keyboard guard until the call is over', () => {
  assert.match(iosManager, /private var appKeyboardLockedForCall = false/);
  assert.match(iosManager, /input\.dataset\.vaultlixCallKeyboardGuard = '1'/);
  assert.doesNotMatch(iosManager, /window\.setTimeout\(\(\) => \{[\s\S]{0,300}vaultlixCallKeyboardGuard/);
  assert.match(iosManager, /func enforceCallKeyboardGuard\(\)/);
  assert.match(iosManager, /perform action: CXAnswerCallAction[\s\S]{0,300}enforceCallKeyboardGuard\(\)/);
  assert.match(iosManager, /didActivate audioSession:[\s\S]{0,220}enforceCallKeyboardGuard\(\)/);
  assert.match(iosScene, /sceneDidBecomeActive[\s\S]{0,180}enforceCallKeyboardGuard\(\)/);
});

test('an answered iOS CallKit call temporarily presents above App Lock', () => {
  assert.match(client, /body\.native-ios-call-over-app-lock #privacy-cover\{display:none!important\}/);
  assert.match(client, /function beginNativeIOSCallOverAppLock\(\)/);
  assert.match(client, /if \(!quickLockActive \|\| !window\.webkit\?\.messageHandlers\?\.vaultlixCall\) return false/);
  assert.match(client, /const presentNativeCallRoom = \(\) => \{[\s\S]{0,700}beginNativeIOSCallOverAppLock\(\);[\s\S]{0,100}showScreen\('s-chat'\)/);
  assert.match(client, /const restoreAppLockAfterCall = finishNativeIOSCallOverAppLock\(\)/);
  assert.match(client, /if \(restoreAppLockAfterCall && quickLockActive\) \{[\s\S]{0,500}hideCallOverlay\(\);/);
});

test('App Lock passcode fields request the native numeric keypad', () => {
  for (const id of ['app-lock-passcode', 'app-lock-current', 'app-lock-new', 'app-lock-confirm']) {
    assert.match(client, new RegExp(`id="${id}"[^>]*type="password"[^>]*inputmode="numeric"[^>]*pattern="\\[0-9\\]\\*"`));
  }
  assert.match(client, /if \(!\/\^\\d\{6,\}\$\/\.test\(next\)\) \{ error\.textContent = 'Use at least 6 digits\.'/);
  assert.doesNotMatch(client, /id="account-login-password"[^>]*inputmode="numeric"/);
});

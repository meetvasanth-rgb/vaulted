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
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(worker, /cache\.put\([^\n]*(?:api|message|cipher|account|key)/i);
  assert.match(client, /registerServiceWorker\(\)\.catch/);
  assert.match(client, /You’re offline\. Vaultlix will reconnect automatically\./);
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

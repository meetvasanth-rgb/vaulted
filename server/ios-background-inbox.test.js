const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const appDelegate = fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
const sceneDelegate = fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
const notificationService = fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'VaultlixNotificationService', 'NotificationService.swift'), 'utf8');
const notificationEntitlements = fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'VaultlixNotificationService', 'VaultlixNotificationService.entitlements'), 'utf8');

test('locked-screen message pushes leave a content-free inbox hint in the shared app group', () => {
  assert.match(notificationEntitlements, /com\.apple\.security\.application-groups[\s\S]*group\.com\.vaultlix\.app/);
  for (const source of [notificationService, appDelegate]) {
    assert.match(source, /recordPendingInboxMessage\(code: code, msgId: msgId\)/);
    assert.match(source, /UserDefaults\(suiteName: "group\.com\.vaultlix\.app"\)/);
    assert.match(source, /"code": code,[\s\S]*"msgId": msgId,[\s\S]*"receivedAt":/);
    assert.doesNotMatch(source, /recordPendingInboxMessage[\s\S]{0,900}"content"/);
  }
});

test('the iOS wrapper drains background hints when the web layer is ready and on resume', () => {
  assert.match(sceneDelegate, /if action == "ready"[\s\S]*flushPendingBackgroundInboxMessages\(\)/);
  assert.match(sceneDelegate, /func sceneDidBecomeActive[\s\S]*flushPendingBackgroundInboxMessages\(\)/);
  assert.match(sceneDelegate, /emit\(name: "vaultlix:background-inbox", detail: \["messages": messages\]\)/);
  assert.match(sceneDelegate, /defaults\.removeObject\(forKey: key\)/);
});

test('background hints paint unread state immediately and are consumed without a second increment', () => {
  assert.match(client, /window\.addEventListener\('vaultlix:background-inbox'/);
  assert.match(client, /room\.unread = Math\.max\(0, Number\(room\.unread\) \|\| 0\) \+ 1/);
  assert.match(client, /applyBackgroundInboxHints\(\);[\s\S]{0,80}showScreen\('s-vault-list'\)/);
  assert.match(client, /const backgroundInboxHinted = consumeBackgroundInboxHint\(room\.code, msg\.id\)/);
  assert.match(client, /if \(!backgroundInboxHinted\) \{\s*room\.unread\+\+/);
  assert.match(client, /if \(isRoomVisible\(room\)\) \{[\s\S]{0,180}hints\.delete\(msgId\)/);
  assert.match(client, /BACKGROUND_INBOX_HINTS_KEY/);
});

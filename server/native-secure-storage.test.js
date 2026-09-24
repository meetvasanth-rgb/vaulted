'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const android = readFileSync(join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/SecureMessageStore.java'), 'utf8');
const ios = readFileSync(join(root, 'mobile/ios/App/App/SecureMessageStore.swift'), 'utf8');
const client = readFileSync(join(root, 'client/index.html'), 'utf8');
const androidActivity = readFileSync(join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const iosScene = readFileSync(join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');

test('Android destroys the per-message Keystore key before deleting SQLCipher ciphertext', () => {
  const body = android.match(/synchronized boolean delete\([\s\S]*?\n    }/)[0];
  assert.ok(body.indexOf('deleteAlias(messageAlias') < body.indexOf('DELETE FROM messages'));
  assert.match(android, /PRAGMA secure_delete = ON/);
  assert.match(android, /PRAGMA wal_checkpoint\(TRUNCATE\)/);
});

test('iOS destroys the per-message ThisDeviceOnly Keychain item before deleting SQLCipher ciphertext', () => {
  const body = ios.match(/func delete\(conversationID:[\s\S]*?\n    }/)[0];
  assert.ok(body.indexOf('deleteKey(account:') < body.indexOf('DELETE FROM messages'));
  assert.match(body, /guard deleteKey\(account:/);
  assert.match(ios, /status == errSecSuccess \|\| status == errSecItemNotFound/);
  assert.match(ios, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(ios, /PRAGMA wal_checkpoint\(TRUNCATE\)/);
});

test('native cache follows render, individual deletion, clear-chat and room removal', () => {
  assert.match(client, /function renderMessageRecord[\s\S]*secureNativeStoreMessage\(room, rec\)/);
  assert.match(client, /function removeMessageRecord[\s\S]*secureNativeDeleteMessage\(room\.code, msgId\)/);
  assert.match(client, /function clearRoomChatLocally[\s\S]*secureNativeClearConversation\(room\.code\)/);
  assert.match(client, /function removeRoomFromState[\s\S]*secureNativeClearConversation\(code\)/);
});

test('a deleted record cannot be recreated by a queued native history-cache write', () => {
  const body = client.match(/function removeMessageRecord\(room, msgId\)[\s\S]*?\n}/)[0];
  assert.ok(body.indexOf('cancelSecureNativeCacheWrite') < body.indexOf('secureNativeDeleteMessage'));
  assert.match(client, /function cancelSecureNativeCacheWrite[\s\S]*secureNativeCacheQueue\.splice/);
  assert.match(client, /function clearRoomChatLocally[\s\S]*cancelAndScrubConversationCache\(room\)[\s\S]*secureNativeClearConversation/);
});

test('message records and rendered media references are scrubbed during deletion', () => {
  assert.match(client, /function scrubMessageRecord[\s\S]*record\[field\] = ''/);
  const body = client.match(/function removeMessageRecord\(room, msgId\)[\s\S]*?\n}/)[0];
  assert.match(body, /scrubMessageRecord\(record\)/);
  assert.match(body, /removeAttribute\('src'\)/);
  assert.match(body, /replaceChildren\(\)/);
});

test('decrypted native share/open staging files are cleaned after use', () => {
  assert.match(androidActivity, /void onResume\(\)[\s\S]*scheduleDecryptedMediaCacheCleanup\(\)/);
  assert.match(androidActivity, /scheduleDecryptedMediaCacheCleanup\(\)[\s\S]*mediaCacheCleanupExecutor\.execute/);
  assert.match(androidActivity, /void purgeDecryptedMediaCacheNow\(\)[\s\S]*file\.delete\(\)/);
  assert.match(androidActivity, /"shared-media", "open-media", "saved-media"/);
  assert.match(iosScene, /completionWithItemsHandler[\s\S]*removeItem\(at: fileURL\)/);
});

test('Emergency Exit cryptographically clears native message stores independently of WebView state', () => {
  assert.match(android, /synchronized boolean clearAll\(\)[\s\S]*startsWith\("vaultlix\.msg\."\)[\s\S]*deleteDatabase\(DB_NAME\)/);
  assert.match(androidActivity, /emergencyReset\(\)[\s\S]*secureMessageStore\.clearAll\(\)/);
  assert.match(ios, /func clearAll\(\)[\s\S]*kSecAttrService[\s\S]*vaultlix-messages\.db-wal/);
  assert.match(iosScene, /action == "emergencyReset"[\s\S]*SecureMessageStore\.shared\.clearAll\(\)/);
});

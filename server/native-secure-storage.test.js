'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const android = readFileSync(join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/SecureMessageStore.java'), 'utf8');
const ios = readFileSync(join(root, 'mobile/ios/App/App/SecureMessageStore.swift'), 'utf8');
const client = readFileSync(join(root, 'client/index.html'), 'utf8');

test('Android destroys the per-message Keystore key before deleting SQLCipher ciphertext', () => {
  const body = android.match(/synchronized boolean delete\([\s\S]*?\n    }/)[0];
  assert.ok(body.indexOf('deleteAlias(messageAlias') < body.indexOf('DELETE FROM messages'));
  assert.match(android, /PRAGMA secure_delete = ON/);
  assert.match(android, /PRAGMA wal_checkpoint\(TRUNCATE\)/);
});

test('iOS destroys the per-message ThisDeviceOnly Keychain item before deleting SQLCipher ciphertext', () => {
  const body = ios.match(/func delete\(conversationID:[\s\S]*?\n    }/)[0];
  assert.ok(body.indexOf('deleteKey(account:') < body.indexOf('DELETE FROM messages'));
  assert.match(ios, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(ios, /PRAGMA wal_checkpoint\(TRUNCATE\)/);
});

test('native cache follows render, individual deletion, clear-chat and room removal', () => {
  assert.match(client, /function renderMessageRecord[\s\S]*secureNativeStoreMessage\(room, rec\)/);
  assert.match(client, /function removeMessageRecord[\s\S]*secureNativeDeleteMessage\(room\.code, msgId\)/);
  assert.match(client, /function clearRoomChatLocally[\s\S]*secureNativeClearConversation\(room\.code\)/);
  assert.match(client, /function removeRoomFromState[\s\S]*secureNativeClearConversation\(code\)/);
});

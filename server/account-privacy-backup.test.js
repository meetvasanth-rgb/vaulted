'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');

function extract(name) {
  let start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  if (client.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = client.indexOf('(', start), parens = 0;
  for (; i < client.length; i++) {
    if (client[i] === '(') parens++;
    else if (client[i] === ')' && --parens === 0) { i++; break; }
  }
  i = client.indexOf('{', i);
  let braces = 0;
  for (; i < client.length; i++) {
    if (client[i] === '{') braces++;
    else if (client[i] === '}' && --braces === 0) { i++; break; }
  }
  return client.slice(start, i);
}

test('the encrypted account bundle carries all three privacy features', () => {
  const snapshot = extract('accountBundleSnapshot');
  const privacy = extract('accountPrivacyBackupSnapshot');
  assert.match(snapshot, /\.\.\.\(privacy \? \{ privacy \} : \{\}\)/);
  assert.match(privacy, /hiddenChats/);
  assert.match(privacy, /appLock/);
  assert.match(privacy, /locker/);
  assert.match(privacy, /lockerItems/);
  assert.match(privacy, /lockerEncryptedRecords\(\)/);
});

test('login and recovery restore privacy before reloading the app', () => {
  assert.match(client, /importAccountBundle\(bundle, result\.accountId\);\s*await restoreAccountPrivacyBackup\(bundle\.privacy, result\.accountId\)/);
  assert.match(client, /importAccountBundle\(recoveredBundle, result\.accountId\);\s*await restoreAccountPrivacyBackup\(recoveredBundle\.privacy, result\.accountId\)/);
});

test('sign-out verifies the privacy backup and refuses to erase on mismatch', () => {
  const prepare = extract('prepareAndConfirmAccountBackup');
  assert.match(prepare, /accountPrivacyBackupSnapshot\(state\.accountId\)/);
  assert.match(prepare, /syncAnonymousAccount\(false, expectedPrivacy\)/);
  assert.match(prepare, /accountPrivacyBackupFingerprint\(remote\.privacy\) !== accountPrivacyBackupFingerprint\(expectedPrivacy\)/);
  assert.match(prepare, /reason:'privacy'/);
  assert.match(client, /Sign out paused — Hidden Chats, App Lock or Locker could not be verified/);
});

test('privacy verification is stable when Locker records arrive in a different order', () => {
  const context = { JSON };
  vm.createContext(context);
  vm.runInContext(extract('accountPrivacyBackupFingerprint'), context);
  const first = { v:1, accountId:'a', hiddenChats:{ codes:['room'] }, appLock:{ salt:'s' }, locker:{ salt:'l' },
    lockerItems:[{ id:'b', ciphertext:'2' }, { id:'a', ciphertext:'1' }] };
  const second = { ...first, lockerItems:[first.lockerItems[1], first.lockerItems[0]] };
  assert.equal(context.accountPrivacyBackupFingerprint(first), context.accountPrivacyBackupFingerprint(second));
  second.lockerItems[0] = { ...second.lockerItems[0], ciphertext:'changed' };
  assert.notEqual(context.accountPrivacyBackupFingerprint(first), context.accountPrivacyBackupFingerprint(second));
});

test('a different account cannot inherit device privacy from the previous account', () => {
  const restore = extract('restoreAccountPrivacyBackup');
  assert.match(restore, /owner !== accountId/);
  assert.match(restore, /removeItem\(HIDDEN_CHATS_KEY\)/);
  assert.match(restore, /removeItem\(APP_LOCK_CONFIG_KEY\)/);
  assert.match(restore, /removeItem\(LOCKER_CONFIG_KEY\)/);
  assert.match(restore, /replaceLockerEncryptedRecords\(\[\]\)/);
});

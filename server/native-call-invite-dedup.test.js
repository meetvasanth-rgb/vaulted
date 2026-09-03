'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('accepted legacy native invite retries cannot create a second incoming call', () => {
  const server = read('server/index.js');
  assert.match(server, /nativeCallInProgress \|\| room2\.activeCall \|\| \(room2\.ringingUntil/);
});

test('Android and iOS native call retries carry one stable invitation ID', () => {
  const android = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeWebRtcCallEngine.java');
  assert.match(android, /inviteId = isOutgoing \? UUID\.randomUUID\(\)\.toString\(\) : ""/);
  assert.match(android, /wire\.put\("inviteId", inviteId\)/);

  const ios = read('mobile/ios/App/App/NativeWebRTCCallEngine.swift');
  assert.match(ios, /self\.inviteID = UUID\(\)\.uuidString/);
  assert.match(ios, /wire\["inviteId"\] = inviteID/);
});

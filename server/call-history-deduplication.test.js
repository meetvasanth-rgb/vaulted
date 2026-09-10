'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const iosScene = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
const iosManager = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
const iosEngine = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'NativeWebRTCCallEngine.swift'), 'utf8');
const androidMain = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
const androidEngine = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'NativeWebRtcCallEngine.java'), 'utf8');
const androidCallActivity = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'NativeCallActivity.java'), 'utf8');

function readFunction(name, nextName) {
  const start = client.indexOf(`function ${name}(`);
  const end = client.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return client.slice(start, end);
}

const context = { CALL_HISTORY_DEDUPE_WINDOW_MS: 12000 };
vm.createContext(context);
vm.runInContext(
  `${readFunction('callHistoryFamily', 'isSameCallHistoryRecord')}\n` +
  readFunction('isSameCallHistoryRecord', 'isDuplicateCallHistoryRecord'),
  context,
);

function call(content, ts, id = '') {
  return { id, kind: 'sys', content, ts };
}

test('near-simultaneous native duration variants collapse into one call', () => {
  assert.equal(context.isSameCallHistoryRecord(
    call('Encrypted call · 00:20 · 16:40', 100000),
    call('Encrypted call · 00:21 · 16:40', 101000),
  ), true);
});

test('missed and no-answer perspectives collapse for the same terminal event', () => {
  assert.equal(context.isSameCallHistoryRecord(
    call('No answer · 16:42', 100000),
    call('Missed encrypted call · 16:42', 100500),
  ), true);
});

test('canonical call ID wins even when callbacks arrive outside the fallback window', () => {
  assert.equal(context.isSameCallHistoryRecord(
    call('Encrypted call · 00:20 · 16:40', 100000, 'call-event-shared-id'),
    call('Encrypted call · 00:21 · 16:40', 200000, 'call-event-shared-id'),
  ), true);
});

test('different terminal outcomes and genuinely separate calls remain visible', () => {
  assert.equal(context.isSameCallHistoryRecord(
    call('Cancelled call · 16:42', 100000),
    call('Missed call · 16:42', 100500),
  ), false);
  assert.equal(context.isSameCallHistoryRecord(
    call('Encrypted call · 00:20 · 16:40', 100000),
    call('Encrypted call · 00:21 · 16:41', 113000),
  ), false);
});

test('web, iOS and Android reuse the same outgoing invitation ID', () => {
  assert.match(client, /startOutgoingCall\([\s\S]*?room\.callInviteId/);
  assert.match(client, /action: 'startOutgoing'[\s\S]*?inviteId: room\.callInviteId/);
  assert.match(iosScene, /inviteID: inviteID/);
  assert.match(iosManager, /prepareOutgoing\([\s\S]*?inviteID: inviteID/);
  assert.match(iosEngine, /self\.inviteID = inviteID/);
  assert.match(androidMain, /prepareOutgoing\(roomHandle, caller, inviteId\)/);
  assert.match(androidEngine, /prepare\(saved, true, caller, requestedInviteId\)/);
});

test('Android dedicated call screen is the sole call-history writer while visible', () => {
  assert.match(androidCallActivity, /static boolean isRunning\(\)/);
  assert.match(androidMain, /if \(NativeCallActivity\.isRunning\(\)\) return;/);
});

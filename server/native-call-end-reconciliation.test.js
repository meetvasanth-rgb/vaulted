const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const ios = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
const android = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'NativeCallActivity.java'), 'utf8');

test('locked iOS terminal call actions cannot resurrect stale call UI', () => {
  assert.match(ios, /"occurredAt": Date\(\)\.timeIntervalSince1970 \* 1000/);
  assert.match(ios, /pendingActions\.removeAll/);
  assert.match(client, /staleTerminalAction/);
  assert.match(client, /silentPresentation:true/);
});

test('native Android ending uses the Vaultlix sand treatment', () => {
  assert.match(android, /VANISH_BACKGROUND = Color\.rgb\(250, 245, 247\)/);
  assert.match(android, /VANISH_BURGUNDY = Color\.rgb\(104, 44, 67\)/);
  assert.match(android, /random\.nextInt\(35\) - 17/);
  assert.match(android, /\.setDuration\(850\)/);
});

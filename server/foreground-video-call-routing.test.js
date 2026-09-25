'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('signed mobile calls keep one native media owner so phone and speaker remain audible', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  const ios = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  const android = fs.readFileSync('mobile/android/app/src/main/java/com/vaultlix/app/VaultlixMessagingService.java', 'utf8');
  assert.doesNotMatch(client, /const nativeOnlySurface =/);
  assert.match(client, /androidNativeReady = !!\(room\.nativeRoomHandle && androidNativeBridge\?\.supportsNativeWebRtc\?\.\(\)\)/);
  assert.match(client, /const iosNativeReady = !!\(room\.nativeRoomHandle && iosBridge\)/);
  assert.match(android, /boolean nativePrepared = engine\.prepareIncoming\(code\)/);
  assert.doesNotMatch(ios, /UIApplication\.shared\.applicationState != \.active,[\s\S]*prepareIncoming/);
  assert.match(ios, /if let roomHandle = data\["roomHandle"\] as\? String,[\s\S]*prepareIncoming/);
});

test('native iOS answers do not start a second WebRTC media connection', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  const ios = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  assert.match(client, /if \(detail\.action === 'nativeConnected'\)[\s\S]*room\.nativeCallActive = true/);
  assert.match(client, /const iosNativeBridge = window\.webkit\?\.messageHandlers\?\.vaultlixCall;[\s\S]*if \(iosNativeBridge && room\.nativeRoomHandle\)/);
  assert.match(client, /iosNativeBridge\.postMessage\(\{ action: 'answer', code: room\.code \}\)/);
  assert.match(client, /if \(iosNativeBridge && room\.nativeRoomHandle\)[\s\S]*disconnectSignaling\(room\)[\s\S]*return;/);
  assert.match(ios, /if !nativeMediaCalls\.contains\(action\.callUUID\) \{[\s\S]*postAction\("answer"/);
});

test('Apple-silicon Mac calls use native CallKit media without reset-induced termination', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  const ios = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  const iosScene = fs.readFileSync('mobile/ios/App/App/SceneDelegate.swift', 'utf8');
  const nativeEngine = fs.readFileSync('mobile/ios/App/App/NativeWebRTCCallEngine.swift', 'utf8');
  assert.match(client, /iosNativeReady = !!\(room\.nativeRoomHandle && iosBridge\)/);
  assert.match(ios, /if let roomHandle = data\["roomHandle"\] as\? String,[\s\S]*prepareIncoming/);
  assert.match(client, /window\.webkit\?\.messageHandlers\?\.vaultlixCall && document\.hidden/);
  assert.match(nativeEngine, /let closingPeer = peer[\s\S]*peer = nil[\s\S]*closingPeer\?\.close\(\)/);
  assert.match(client, /traceMacCall\('peer-setup-start'/);
  assert.match(client, /traceMacCall\('answer-local-set'/);
  assert.match(iosScene, /action == "debugMacCall"[\s\S]*category: "MacCall"[\s\S]*\.notice\(/);
});

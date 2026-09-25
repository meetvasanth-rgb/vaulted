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
  assert.match(client, /const iosNativeReady = !!\(room\.nativeRoomHandle && iosBridge && !iosAppOnMac\)/);
  assert.match(android, /boolean nativePrepared = engine\.prepareIncoming\(code\)/);
  assert.doesNotMatch(ios, /UIApplication\.shared\.applicationState != \.active,[\s\S]*prepareIncoming/);
  assert.match(ios, /if !isRunningOnAppleSiliconMac,[\s\S]*let roomHandle = data\["roomHandle"\] as\? String,[\s\S]*prepareIncoming/);
});

test('native iOS answers do not start a second WebRTC media connection', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  const ios = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  assert.match(client, /if \(detail\.action === 'nativeConnected'\)[\s\S]*room\.nativeCallActive = true/);
  assert.match(client, /const iosNativeBridge = window\.webkit\?\.messageHandlers\?\.vaultlixCall;[\s\S]*if \(iosNativeBridge && room\.nativeRoomHandle && !iosAppOnMac\)/);
  assert.match(client, /iosNativeBridge\.postMessage\(\{ action: 'answer', code: room\.code \}\)/);
  assert.match(client, /if \(iosNativeBridge && room\.nativeRoomHandle && !iosAppOnMac\)[\s\S]*disconnectSignaling\(room\)[\s\S]*return;/);
  assert.match(client, /if \(iosAppOnMac && iosNativeBridge\) \{[\s\S]*room\.iosForegroundWebCall = true/);
  assert.match(ios, /if !nativeMediaCalls\.contains\(action\.callUUID\) \{[\s\S]*postAction\("answer"/);
});

test('Apple-silicon Mac calls use web media while CallKit remains the incoming surface', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  const ios = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  assert.match(client, /const iosAppOnMac = window\.__vaultlixIOSAppOnMac === true/);
  assert.match(client, /action:'prepareOutgoingAudio'/);
  assert.match(client, /iosNativeReady = !!\(room\.nativeRoomHandle && iosBridge && !iosAppOnMac\)/);
  assert.match(ios, /if !isRunningOnAppleSiliconMac,[\s\S]*prepareIncoming/);
});

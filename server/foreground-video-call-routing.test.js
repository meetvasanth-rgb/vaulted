'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('foreground mobile calls keep mute and camera on the shared live WebRTC tracks', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  const ios = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  assert.match(client, /const nativeOnlySurface = document\.hidden \|\| document\.body\.classList\.contains\('native-call-only'\)/);
  assert.match(client, /androidNativeReady = nativeOnlySurface/);
  assert.match(client, /const iosNativeReady = nativeOnlySurface/);
  assert.match(client, /window\.webkit\?\.messageHandlers\?\.vaultlixCall && document\.hidden/);
  assert.match(client, /\(document\.hidden \|\| document\.body\.classList\.contains\('native-call-only'\)\)[\s\S]*prepareIncomingCall/);
  assert.match(client, /room\.localStream\.getAudioTracks\(\)\.forEach/);
  assert.match(client, /room\.pc\.addTrack\(track, videoStream\)/);
  assert.match(ios, /UIApplication\.shared\.applicationState != \.active[\s\S]*prepareIncoming/);
});

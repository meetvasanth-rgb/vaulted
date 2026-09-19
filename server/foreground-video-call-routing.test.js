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

test('foreground iOS answers keep CallKit for audio while WebRTC sends the encrypted accept', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  const acceptStart = client.indexOf('async function acceptCall(');
  const acceptEnd = client.indexOf('function declineCall()', acceptStart);
  const accept = client.slice(acceptStart, acceptEnd);
  assert.ok(acceptStart >= 0 && acceptEnd > acceptStart);
  assert.match(accept, /room\.iosForegroundWebCall = true/);
  assert.match(accept, /nativeBridge\.postMessage\(\{ action: 'answer', code: room\.code \}\)/);
  assert.match(accept, /room\.pendingCallAccept = true/);
  assert.ok(
    accept.indexOf("nativeBridge.postMessage({ action: 'answer', code: room.code })")
      < accept.indexOf('room.pendingCallAccept = true'),
    'foreground iOS must continue into encrypted WebRTC acceptance after asking CallKit to answer',
  );
  assert.match(client, /if \(room\.iosForegroundWebCall\) \{[\s\S]*room\.nativeCallActive = false;[\s\S]*refreshNativeCallAudio\(room\)/);
});

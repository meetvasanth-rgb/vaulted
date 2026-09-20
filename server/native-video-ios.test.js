'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('native iOS calls receive video through both Unified Plan callbacks', () => {
  const engine = fs.readFileSync('mobile/ios/App/App/NativeWebRTCCallEngine.swift', 'utf8');
  assert.match(engine, /didStartReceivingOn transceiver: RTCRtpTransceiver/);
  assert.match(engine, /didAdd rtpReceiver: RTCRtpReceiver/);
  assert.match(engine, /vaultlixRemoteVideoTrack/);
});

test('native iOS call controls omit reactions without changing other clients', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  assert.match(client, /const reactionAvailable = !window\.webkit\?\.messageHandlers\?\.vaultlixCall/);
  assert.match(client, /const reactionBtnHtml = reactionAvailable \?/);
});

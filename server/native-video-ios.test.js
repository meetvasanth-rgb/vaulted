'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('native iOS calls receive video through both Unified Plan callbacks', () => {
  const engine = fs.readFileSync('mobile/ios/App/App/NativeWebRTCCallEngine.swift', 'utf8');
  assert.match(engine, /didStartReceivingOn transceiver: RTCRtpTransceiver/);
  assert.match(engine, /didAdd rtpReceiver: RTCRtpReceiver/);
  assert.match(engine, /vaultlixRemoteVideoTrack/);
  assert.match(engine, /didAdd stream: RTCMediaStream/);
  assert.match(engine, /stream\.videoTracks\.first/);
  assert.match(engine, /private var remoteVideoTrack: RTCVideoTrack\?/);
  assert.match(engine, /if remoteVideoOn \{ publishRemoteVideoTrackLocked\(\) \}/);
  assert.match(engine, /peer\?\.transceivers/);
});

test('native iOS call controls omit reactions without changing other clients', () => {
  const client = fs.readFileSync('client/index.html', 'utf8');
  assert.match(client, /const reactionAvailable = !window\.webkit\?\.messageHandlers\?\.vaultlixCall/);
  assert.match(client, /const reactionBtnHtml = reactionAvailable \?/);
});

test('native iOS camera capture is permission-aware, compatible and idempotent', () => {
  const engine = fs.readFileSync('mobile/ios/App/App/NativeWebRTCCallEngine.swift', 'utf8');
  assert.match(engine, /authorizationStatus\(for: \.video\)/);
  assert.match(engine, /requestAccess\(for: \.video\)/);
  assert.match(engine, /if videoCaptureRunning/);
  assert.match(engine, /guard !videoCaptureStarting else \{ return \}/);
  assert.match(engine, /minFrameRate <= 30 && \$0\.maxFrameRate >= 30/);
  assert.match(engine, /targetWidth: Int32 = 1280/);
  assert.doesNotMatch(engine, /supportedFormats\(for: device\)\.max/);
});

test('privacy-preserving incoming iOS calls can resolve native media controls', () => {
  const manager = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  assert.match(manager, /private func nativeMediaCall\(matching roomCode: String\)/);
  assert.match(manager, /guard nativeMediaCalls\.count == 1/);
  assert.match(manager, /setVideoFromWeb[\s\S]*nativeMediaCall\(matching: roomCode\)/);
  assert.match(manager, /switchCameraFromWeb[\s\S]*nativeMediaCall\(matching: roomCode\)/);
  assert.match(manager, /respondToVideoRequestFromWeb[\s\S]*nativeMediaCall\(matching: roomCode\)/);
});

test('native iOS direct video calls notify CallKit and use a full-screen canvas', () => {
  const scene = fs.readFileSync('mobile/ios/App/App/SceneDelegate.swift', 'utf8');
  const manager = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  const engine = fs.readFileSync('mobile/ios/App/App/NativeWebRTCCallEngine.swift', 'utf8');
  const server = fs.readFileSync('server/index.js', 'utf8');
  assert.match(scene, /nativeRemoteVideoView\.layer\.cornerRadius = 0/);
  assert.match(scene, /nativeRemoteVideoView\.frame = root\.bounds/);
  assert.match(scene, /insertSubview\(nativeRemoteVideoView, belowSubview: webView\)/);
  assert.match(scene, /bringSubviewToFront\(webView\)/);
  assert.match(manager, /action\.isVideo = video/);
  assert.match(engine, /wire\["hasVideo"\] = outgoingVideoCall/);
  assert.match(server, /hasVideo: msg2\.hasVideo === true/);
  assert.doesNotMatch(scene, /root\.bounds\.height \* 0\.48/);
});

test('native iOS video calls keep controls available and label CallKit clearly', () => {
  const scene = fs.readFileSync('mobile/ios/App/App/SceneDelegate.swift', 'utf8');
  const manager = fs.readFileSync('mobile/ios/App/App/AppDelegate.swift', 'utf8');
  assert.match(scene, /nativeVideoControlsView/);
  assert.match(scene, /toggleNativeVideoMute/);
  assert.match(scene, /cycleNativeVideoRoute/);
  assert.match(scene, /toggleNativeVideoCamera/);
  assert.match(scene, /flipNativeVideoCamera/);
  assert.match(scene, /endNativeVideoCall/);
  assert.match(scene, /bringSubviewToFront\(nativeVideoControlsView\)/);
  assert.match(manager, /func endActiveNativeCall\(\)/);
  assert.match(manager, /CXEndCallAction\(call: callID\)/);
  assert.ok(manager.includes('"VIDEO CALL · \\(caller)"'));
  assert.ok(manager.includes('"VIDEO CALL · \\(cleanName)"'));
});

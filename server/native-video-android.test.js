'use strict';

// Android native calls (in-app, background and locked all use NativeCallActivity)
// carry video, but only after both people agree to switch the call to video.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const java = 'mobile/android/app/src/main/java/com/vaultlix/app/';
const res = 'mobile/android/app/src/main/res/';

test('the signalling server relays the video request, response and state messages', () => {
  const server = read('server/index.js');
  for (const type of ['call-video-request', 'call-video-response', 'call-video-state']) {
    assert.match(server, new RegExp(`'${type}'`), `${type} must be allowlisted or the server drops it`);
  }
});

test('an incoming direct video call is identified before Android answers it', () => {
  const server = read('server/index.js');
  const messaging = read(java + 'VaultlixMessagingService.java');
  const incoming = read(java + 'IncomingCallActivity.java');
  const strings = read(res + 'values/strings.xml');
  assert.match(server, /hasVideo: msg2\.hasVideo === true/);
  assert.match(server, /hasVideo: parsed\.hasVideo \? 'true' : 'false'/);
  assert.match(messaging, /data\.get\("hasVideo"\)/);
  assert.match(messaging, /"VIDEO CALL · " \+ caller/);
  assert.match(messaging, /IncomingCallActivity\.EXTRA_VIDEO_CALL/);
  assert.match(incoming, /EXTRA_VIDEO_CALL/);
  assert.match(incoming, /native_incoming_encrypted_video_call/);
  assert.match(strings, /name="native_incoming_encrypted_video_call">Incoming encrypted video call/);
  assert.match(incoming, /videoCall \? R\.drawable\.ic_call_video : R\.drawable\.ic_call_end/);
  assert.match(incoming, /videoCall \? R\.string\.native_answer_video : R\.string\.native_answer/);
});

test('the web incoming screen keeps video identity and answer affordance', () => {
  const client = read('client/index.html');
  assert.match(client, /handleSignalMessage\(room, msg\.type, payload, msg\.inviteId, msg\.hasVideo === true\)/);
  assert.match(client, /room\.incomingVideoCall = hasVideo === true/);
  assert.match(client, /Incoming encrypted video call/);
  assert.match(client, /room\.incomingVideoCall \? CALL_VIDEO_ICON : CALL_PHONE_ICON/);
});

test('native Android carries the video-call intent through the signalling envelope', () => {
  const engine = read(java + 'NativeWebRtcCallEngine.java');
  const main = read(java + 'MainActivity.java');
  assert.match(main, /prepareOutgoing\(roomHandle, caller, inviteId, startWithVideo\)/);
  assert.match(engine, /outgoingVideoCall = videoCall/);
  assert.match(engine, /"call-invite"\.equals\(type\)\) wire\.put\("hasVideo", outgoingVideoCall\)/);
});

test('the engine negotiates video up front and gates every camera and peer picture on consent', () => {
  const engine = read(java + 'NativeWebRtcCallEngine.java');
  assert.match(engine, /DefaultVideoEncoderFactory/);
  assert.match(engine, /factory\.createVideoTrack\("vaultlix-native-video"/);
  assert.match(engine, /peer\.addTrack\(videoTrack/);
  // consent decisions live in the unit-tested NativeVideoState
  assert.match(engine, /videoState\.setRemote\(payload\.optBoolean\("on", false\)\)/);
  assert.match(engine, /on && !videoState\.canStartCamera\(\)/);
  assert.match(engine, /case "call-video-request"/);
  assert.match(engine, /case "call-video-response"/);
  // the camera is only started when granted, and released with the call
  assert.match(engine, /stopVideo\(\);\s*\n\s*if \(peer != null\) \{ peer\.close\(\)/);
  assert.match(engine, /audioSource = null; \}\s*\n\s*disposeVideo\(\);/);
  assert.match(engine, /videoState\.reset\(\)/);
});

test('the call screen asks before switching and again on the other side', () => {
  const screen = read(java + 'NativeCallActivity.java');
  assert.match(screen, /if \(!engine\.hasVideoConsent\(\)\)/);
  assert.match(screen, /engine\.requestVideo\(\)/);
  assert.match(screen, /public void onVideoRequest\(\)/);
  assert.match(screen, /engine\.respondVideo\(true\)/);
  assert.match(screen, /engine\.respondVideo\(false\)/);
  assert.match(screen, /public void onVideoResponse\(boolean accepted\)/);
  // camera permission is requested, and asks to unlock first over the keyguard
  assert.match(screen, /Manifest\.permission\.CAMERA/);
  assert.match(screen, /requestDismissKeyguard/);
});

test('direct video-call entry waits for connection and preserves peer consent', () => {
  const client = read('client/index.html');
  const main = read(java + 'MainActivity.java');
  const screen = read(java + 'NativeCallActivity.java');
  assert.match(client, /id="video-call-btn"[\s\S]*onclick="startVideoCall\(\)"/);
  assert.match(client, /data-video-call-room=/);
  assert.match(client, /startCallFromHistory\(button\.dataset\.videoCallRoom, true\)/);
  assert.match(client, /startOutgoingVideoCall\([\s\S]*room\.callInviteId/);
  assert.match(main, /startOutgoingVideoCall\([\s\S]*startOutgoingCallInternal\(roomHandle, caller, peer, inviteId, true\)/);
  assert.match(screen, /EXTRA_START_WITH_VIDEO/);
  assert.match(screen, /if \(startWithVideo && !engine\.isCameraOn\(\)\)[\s\S]*engine\.requestVideo\(\)/);
  assert.doesNotMatch(screen, /if \(startWithVideo[\s\S]{0,300}setCameraEnabled\(true\)/);
});

test('the camera pauses when the call screen is left and resumes on return', () => {
  const screen = read(java + 'NativeCallActivity.java');
  assert.match(screen, /protected void onStop\(\)[\s\S]*resumeCameraOnStart = true[\s\S]*setCameraEnabled\(false\)/);
  assert.match(screen, /protected void onStart\(\)[\s\S]*resumeCameraOnStart[\s\S]*setCameraEnabled\(true\)/);
});

test('a newer call screen keeps its renderers when an older one is destroyed', () => {
  const engine = read(java + 'NativeWebRtcCallEngine.java');
  const screen = read(java + 'NativeCallActivity.java');
  assert.match(engine, /synchronized void clearIf\(VideoSink sink\) \{ if \(target == sink\) target = null; \}/);
  assert.match(screen, /engine\.detachVideoSinks\(localView, remoteView\)/);
  assert.match(screen, /localView\.release\(\)/);
  assert.match(screen, /remoteView\.release\(\)/);
});

test('every shipped language has every video string', () => {
  const names = ['native_video', 'native_stop_video', 'native_flip_camera', 'native_video_unlock',
    'native_video_switch_title', 'native_video_switch_body', 'native_video_request_body',
    'native_switch', 'native_cancel', 'native_not_now', 'native_video_declined', 'native_video_waiting',
    'native_answer_video'];
  for (const dir of ['values', 'values-ar', 'values-hi', 'values-hy', 'values-ru', 'values-zh-rCN']) {
    const strings = read(`${res}${dir}/strings.xml`);
    for (const name of names) assert.match(strings, new RegExp(`name="${name}"`), `${dir} is missing ${name}`);
  }
  for (const icon of ['ic_call_video.xml', 'ic_call_flip.xml']) {
    assert.ok(fs.existsSync(path.join(root, res, 'drawable', icon)), `${icon} is missing`);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Android native calls use encrypted signaling and forced TURN', () => {
  const engine = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeWebRtcCallEngine.java');
  assert.match(engine, /AES\/GCM\/NoPadding/);
  assert.match(engine, /IceTransportsType\.RELAY/);
  assert.match(engine, /wss:\/\/vaultlix\.com\/ws\/signal/);
  assert.match(engine, /"nativeCall", true/);
  assert.match(engine, /call-accept/);
  assert.match(engine, /scheduleTurnRetry/);
  assert.match(engine, /send hangup room=/);
  assert.match(engine, /250, TimeUnit\.MILLISECONDS/);
});

test('Android native call credentials are device-bound and removed with a vault', () => {
  const store = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeCallRoomStore.java');
  const client = read('client/index.html');
  assert.match(store, /AndroidKeyStore/);
  assert.match(store, /setRandomizedEncryptionRequired\(true\)/);
  assert.match(client, /provisionCallRoom/);
  assert.match(client, /removeCallRoom/);
});

test('Android starts its native engine during ringing instead of after answer', () => {
  const messaging = read('mobile/android/app/src/main/java/com/vaultlix/app/VaultlixMessagingService.java');
  const incoming = read('mobile/android/app/src/main/java/com/vaultlix/app/IncomingCallActivity.java');
  assert.match(messaging, /prepareIncoming\(code\)/);
  assert.match(incoming, /NativeWebRtcCallEngine\.get\(this\)\.answer\(\)/);
  assert.match(incoming, /NativeCallActivity\.class/);
  const client = read('client/index.html');
  const main = read('mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java');
  assert.match(client, /prepareIncomingCall/);
  assert.match(client, /answerIncomingCall/);
  assert.match(main, /prepareIncomingHandle/);
  assert.match(main, /NativeCallActivity\.class/);
  assert.match(client, /startOutgoingCall\([\s\S]*room\.callPeerName/);
  assert.match(client, /if \(!room\.nativeIncomingPrepared\) renderCallOverlay\(room\)/);
  assert.match(client, /if \(!room\.nativeIncomingPrepared\) playChime\(\)/);
  assert.match(client, /if \(usesDedicatedAndroidCallUi\) hideCallOverlay\(\)/);
  assert.match(client, /if \(room\.nativeCallActive\) \{[\s\S]*hideCallOverlay\(\)/);
  assert.match(client, /if \(!usesDedicatedAndroidCallUi\) renderCallOverlay\(room\)/);
  assert.match(client, /wasNativeCall && window\.VaultlixAndroid\?\.supportsNativeWebRtc/);
  assert.match(client, /detail\.action === 'declineOrEnd'[\s\S]*room\.callState === 'active' \|\| room\.callState === 'outgoing'/);
  assert.match(incoming, /SOFT_INPUT_STATE_ALWAYS_HIDDEN/);
  assert.match(incoming, /showIncomingCall\(caller\);[\s\S]*cancelNotification\(\)/);
  const nativeActivity = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeCallActivity.java');
  assert.match(nativeActivity, /SOFT_INPUT_STATE_ALWAYS_HIDDEN/);
  assert.match(nativeActivity, /showCallEndedMoment\(\)/);
  assert.match(nativeActivity, /native_call_vanished/);
});

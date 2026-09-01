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
});

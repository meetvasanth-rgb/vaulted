'use strict';

// The in-call audio route control is Phone / Bluetooth / Speaker. Bluetooth
// appears only when the native app reports a connected headset, so app builds
// that predate it must keep the original two-way Phone/Speaker behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const client = readFileSync(join(root, 'client', 'index.html'), 'utf8');
const read = relative => readFileSync(join(root, relative), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing from client/index.html`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const context = vm.createContext({});
for (const name of ['currentAudioRoute', 'nextAudioRoute', 'applyNativeAudioRouteDetail']) {
  vm.runInContext(extractFunction(client, name), context);
}
const call = (fn, ...args) => context[fn](...args);
// Room objects are built in the sandbox so they share its prototypes.
const room = props => vm.runInContext(`(${JSON.stringify(props)})`, context);

test('without Bluetooth the control is the original Phone <-> Speaker pair', () => {
  assert.equal(call('nextAudioRoute', room({ audioRoute: null, speakerOn: false })), 'speaker');
  assert.equal(call('nextAudioRoute', room({ audioRoute: null, speakerOn: true })), 'phone');
  assert.equal(call('nextAudioRoute', room({ audioRoute: 'phone', bluetoothAvailable: false })), 'speaker');
  assert.equal(call('nextAudioRoute', room({ audioRoute: 'speaker', bluetoothAvailable: false })), 'phone');
});

test('with Bluetooth a tap goes Bluetooth -> Speaker -> Phone -> Bluetooth', () => {
  const at = audioRoute => call('nextAudioRoute', room({ audioRoute, bluetoothAvailable: true }));
  assert.equal(at('bluetooth'), 'speaker');
  assert.equal(at('speaker'), 'phone');
  assert.equal(at('phone'), 'bluetooth');
});

test('a stale Bluetooth route with no headset does not break the two-way control', () => {
  assert.equal(call('nextAudioRoute', room({ audioRoute: 'bluetooth', bluetoothAvailable: false })), 'phone');
});

test('an older app build that reports neither field keeps the two-way control', () => {
  const r = room({ speakerOn: false });
  call('applyNativeAudioRouteDetail', r, room({ available: true, speakerOn: false }));
  assert.equal(r.bluetoothAvailable, false);
  assert.equal(r.audioRoute, null);
  assert.equal(call('currentAudioRoute', r), 'phone');
});

test('a native report sets the route, Bluetooth availability and speakerOn together', () => {
  const r = room({ speakerOn: false });
  call('applyNativeAudioRouteDetail', r, room({ route: 'bluetooth', bluetoothAvailable: true }));
  assert.equal(call('currentAudioRoute', r), 'bluetooth');
  assert.equal(r.bluetoothAvailable, true);
  assert.equal(r.speakerOn, false);
  call('applyNativeAudioRouteDetail', r, room({ route: 'speaker', bluetoothAvailable: true }));
  assert.equal(r.speakerOn, true);
});

test('an unknown route value from native is ignored, not trusted', () => {
  const r = room({ speakerOn: false });
  call('applyNativeAudioRouteDetail', r, room({ route: '<img src=x onerror=alert(1)>', bluetoothAvailable: true }));
  assert.equal(r.audioRoute, null);
  assert.equal(call('currentAudioRoute', r), 'phone');
});

test('the button keeps the names the existing call test relies on', () => {
  assert.match(client, /const outgoingSpeakerBtnHtml = room\.speakerAvailable \? audioRouteButtonHtml\(room\)/);
  assert.match(client, /onclick="toggleSpeaker\(\)"/);
});

test('iOS reports the route and accepts an explicit route request', () => {
  const scene = read('mobile/ios/App/App/SceneDelegate.swift');
  const app = read('mobile/ios/App/App/AppDelegate.swift');
  assert.match(scene, /"bluetoothAvailable": manager\.isBluetoothAudioAvailable\(\)/);
  assert.match(scene, /action == "setAudioRoute"/);
  assert.match(app, /func setAudioRoute\(_ route: String/);
  // a route chosen in one call must not leak into the next
  assert.match(app, /clearPreferredAudioInput\(\)/);
});

test('Android exposes the same route API on both call bridges and asks for the Bluetooth permission', () => {
  const main = read('mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java');
  const locked = read('mobile/android/app/src/main/java/com/vaultlix/app/LockedCallActivity.java');
  for (const [name, source] of [['MainActivity', main], ['LockedCallActivity', locked]]) {
    assert.match(source, /public String getAudioRouteState\(\)/, `${name} needs getAudioRouteState`);
    assert.match(source, /public boolean setCallAudioRoute\(String route\)/, `${name} needs setCallAudioRoute`);
    assert.match(source, /public void requestBluetoothPermission\(\)/, `${name} needs requestBluetoothPermission`);
  }
  // BLUETOOTH_CONNECT was declared in the manifest but never requested.
  assert.match(main, /requestPermissions\(new String\[\] \{ Manifest\.permission\.BLUETOOTH_CONNECT \}/);
  // The lock-screen host must never prompt over the keyguard.
  assert.match(locked, /public void requestBluetoothPermission\(\) \{ \}/);
});

test('the Android native call screen offers Bluetooth and no longer forces the earpiece', () => {
  const nativeCall = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeCallActivity.java');
  assert.match(nativeCall, /new String\[\] \{ "bluetooth", "speaker", "phone" \}/);
  assert.match(nativeCall, /R\.string\.native_bluetooth/);
  assert.doesNotMatch(nativeCall, /speakerRequested/);
});

test('a foreground Android call is answered on the web screen, which has video', () => {
  const service = read('mobile/android/app/src/main/java/com/vaultlix/app/VaultlixMessagingService.java');
  const main = read('mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java');
  assert.match(service, /!MainActivity\.isAppInForeground\(\) && engine\.prepareIncoming\(code\)/);
  assert.match(main, /appInForeground = true/);
  assert.match(main, /appInForeground = false/);
});

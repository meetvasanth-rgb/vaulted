'use strict';

// Calls used to have two weak spots on both native engines: setup could sit on "Connecting
// securely…" indefinitely (Android had no deadline), and a media path that dropped mid-call
// (weak signal, Wi-Fi <-> mobile data) was never restarted — the screen looked live and the
// timer kept running over silence. Both engines now restart ICE from the caller's side, show
// "Reconnecting…", and end the call with a clear message if the path cannot be restored.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const client = read('client/index.html');
const engine = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeWebRtcCallEngine.java');
const activity = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeCallActivity.java');
const mainActivity = read('mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java');
const manifest = read('mobile/android/app/src/main/AndroidManifest.xml');
const ios = read('mobile/ios/App/App/NativeWebRTCCallEngine.swift');
const iosManager = read('mobile/ios/App/App/AppDelegate.swift');

test('Android: a dropped media path is recovered by an ICE restart, not ignored', () => {
  assert.match(engine, /state == PeerConnection\.IceConnectionState\.DISCONNECTED\) \{\s*executor\.execute\(\(\) -> beginMediaRecovery\(ICE_RESTART_GRACE_MS\)\)/);
  assert.match(engine, /if \(connectedAtMs == 0L\) reset\("connection-failed"\);\s*else beginMediaRecovery\(0L\);/);
  assert.match(engine, /constraints\.mandatory\.add\(new MediaConstraints\.KeyValuePair\("IceRestart", "true"\)\)/);
  // Only the caller offers, so two restart offers can never cross.
  assert.match(engine, /private void restartIce\(\) \{\s*if \(peer == null \|\| room == null \|\| !outgoing \|\| !answered\) return;/);
  // The deadline is anchored to the first loss, and it ends the call with its own reason.
  assert.match(engine, /scheduleRecoveryAttempt\(run, token, reconnectStartedMs, graceMs\)/);
  assert.match(engine, /reset\("connection-lost"\)/);
});

test('Android: recovery does not restart the call timer or replay "connected"', () => {
  const observer = engine.slice(engine.indexOf('public void onIceConnectionChange'), engine.indexOf('public void onSignalingChange'));
  assert.match(observer, /boolean first = connectedAtMs == 0L;/);
  assert.match(observer, /if \(first\) for \(Listener listener : listeners\) listener\.onConnected\(\);/);
  assert.match(observer, /listener\.onReconnecting\(false\)/);
});

test('Android: setup has a deadline and one mid-setup ICE restart', () => {
  assert.match(engine, /CONNECT_DEADLINE_MS = 25_000L/);
  assert.match(engine, /reset\("connection-timeout"\)/);
  assert.match(engine, /CONNECT_DEADLINE_MS \/ 2/);
  // Started on both sides: the caller when the accept arrives, the callee when it answers.
  assert.equal((engine.match(/startConnectWatchdog\(\);/g) || []).length, 2);
});

test('Android: a default-network change triggers recovery and monitoring is released with the call', () => {
  assert.match(engine, /registerDefaultNetworkCallback\(networkCallback\)/);
  assert.match(engine, /switched && connectedAtMs > 0L/);
  assert.match(engine, /stopWatchingNetworkChanges\(\);\s*recoveryRun\+\+;/);
  assert.match(manifest, /android\.permission\.ACCESS_NETWORK_STATE/);
});

test('Android: the call screen says Reconnecting and a lost or failed call explains itself', () => {
  assert.match(activity, /public void onReconnecting\(boolean reconnecting\)/);
  assert.match(activity, /timer\.setAlpha\(reconnecting \? \.45f : 1f\)/);
  assert.match(activity, /R\.string\.native_call_connect_failed : R\.string\.native_call_connection_lost/);
  assert.match(mainActivity, /nativeReconnecting" : "nativeReconnected"/);
  for (const dir of ['values', 'values-ar', 'values-hi', 'values-hy', 'values-ru', 'values-zh-rCN']) {
    const strings = read(`mobile/android/app/src/main/res/${dir}/strings.xml`);
    for (const name of ['native_reconnecting', 'native_call_connect_failed', 'native_call_connection_lost']) {
      assert.match(strings, new RegExp(`name="${name}"`), `${dir} is missing ${name}`);
    }
  }
});

test('iOS: a dropped media path is recovered by an ICE restart from the caller', () => {
  assert.match(ios, /if newState == \.disconnected \{[\s\S]{0,200}beginMediaRecoveryLocked\(after: Self\.iceRestartGrace\)/);
  assert.match(ios, /if newState == \.failed, self\.connectedOnce \{\s*self\.beginMediaRecoveryLocked\(after: 0\)/);
  assert.match(ios, /mandatoryConstraints: iceRestart \? \["IceRestart": "true"\] : nil/);
  assert.match(ios, /guard peer != nil, outgoing, answered else \{ return \}/);
  assert.match(ios, /nativeCallDidEnd\(callID: callID, action: "nativeConnectionLost"\)/);
  // A restored path must not re-announce "connected" (that would reset the web timer).
  assert.match(ios, /if self\.connectedOnce \{\s*self\.mediaPathRecoveredLocked\(\)\s*return\s*\}/);
});

test('iOS: a network switch triggers recovery, setup restarts ICE once, and everything is released on reset', () => {
  assert.match(ios, /NWPathMonitor\(\)/);
  assert.match(ios, /beginMediaRecoveryLocked\(after: 0\.5\)/);
  assert.match(ios, /setup stalled: restarting ICE/);
  const reset = ios.slice(ios.indexOf('private func resetLocked()'));
  assert.match(reset.slice(0, 600), /recoveryGeneration \+= 1\s*stopPathMonitorLocked\(\)\s*connectedOnce = false/);
});

test('iOS: the manager relays reconnecting/reconnected and treats connection loss as terminal', () => {
  assert.match(iosManager, /func nativeCallMediaDidChange\(callID: UUID, reconnecting: Bool\)/);
  assert.match(iosManager, /"nativeReconnecting" : "nativeReconnected"/);
  assert.match(iosManager, /"nativeCancelled", "nativeBusy", "nativeFailed",\s*"nativeConnectionLost"/);
  assert.match(client, /const terminalNativeActions = new Set\(\[[^\]]*'nativeConnectionLost'/);
});

test('web: the timer keeps counting but reads "Reconnecting…" while the path is down', () => {
  const start = client.indexOf('function updateCallTimerDisplay(room)');
  const source = client.slice(start, client.indexOf('\n}\n', start) + 3);
  const el = { textContent:'', classList:{ pulsing:false, toggle(name, on) { this[name] = on; } } };
  const context = vm.createContext({
    document: { getElementById: () => el },
    formatCallTime: seconds => `t${seconds}`,
    Date: { now: () => 10_000 },
  });
  vm.runInContext(source, context);
  const room = { callState:'active', callStartedAt:4_000, callReconnecting:false };
  context.updateCallTimerDisplay(room);
  assert.equal(el.textContent, 't6');
  assert.equal(el.classList.pulsing, false);
  room.callReconnecting = true;
  context.updateCallTimerDisplay(room);
  assert.equal(el.textContent, 'Reconnecting… t6');
  assert.equal(el.classList.pulsing, true);
});

test('web: reconnect events never touch the start time, and a lost call ends with a clear message', () => {
  const branch = client.slice(client.indexOf("if (detail.action === 'nativeReconnecting'"), client.indexOf("if (detail.action === 'nativeConnected')"));
  assert.doesNotMatch(branch, /callStartedAt\s*=/);
  assert.match(client, /detail\.action === 'nativeConnectionLost' && room\.callState !== 'idle'\) \{\s*room\.callReconnecting = false;\s*endCall\(room, 'The call lost its connection\.'\);/);
});

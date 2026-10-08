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
const server = read('server/index.js');

test('Android: a dropped media path is recovered by an ICE restart, not ignored', () => {
  assert.match(engine, /state == PeerConnection\.IceConnectionState\.DISCONNECTED\)[\s\S]{0,160}beginMediaRecovery\(ICE_RESTART_GRACE_MS\)/);
  assert.match(engine, /transportReady = false;/);
  assert.match(engine, /if \(connectedAtMs == 0L\) reset\("connection-failed"\);\s*else beginMediaRecovery\(0L\);/);
  assert.match(engine, /constraints\.mandatory\.add\(new MediaConstraints\.KeyValuePair\("IceRestart", "true"\)\)/);
  // Only the caller offers, so two restart offers can never cross.
  assert.match(engine, /private void restartIce\(\) \{\s*if \(peer == null \|\| room == null \|\| !outgoing \|\| !answered\) return;/);
  // The deadline is anchored to the first loss, and it ends the call with its own reason.
  assert.match(engine, /scheduleRecoveryAttempt\(run, token, reconnectStartedMs, graceMs\)/);
  assert.match(engine, /reset\("connection-lost"\)/);
  // Some OEM WebRTC builds report lost receiving before changing the ICE
  // state. That signal must also enter recovery so a silent-looking call is
  // not left running indefinitely.
  assert.match(engine, /onIceConnectionReceivingChange\(boolean receiving\)[\s\S]{0,350}beginMediaRecovery\(ICE_RESTART_GRACE_MS\)/);
  assert.match(engine, /ContinualGatheringPolicy\.GATHER_CONTINUALLY/);
  assert.match(engine, /case "call-restart-request":[\s\S]{0,500}beginMediaRecovery\(0L\)/);
  assert.match(engine, /private void requestOrRestartIce\(\)[\s\S]{0,260}sendSignal\("call-restart-request"/);
  assert.match(engine, /ICE_RESTART_GRACE_MS = 1_500L/);
});

test('Android: recovery does not restart the call timer or replay "connected"', () => {
  const observer = engine.slice(engine.indexOf('public void onIceConnectionChange'), engine.indexOf('public void onSignalingChange'));
  assert.match(observer, /if \(connectedAtMs == 0L\)[\s\S]{0,220}completeInitialConnectionIfReady\(\);/);
  assert.match(observer, /finishMediaRecovery\(\)/);
  assert.match(engine, /private void finishMediaRecovery\(\)[\s\S]{0,500}listener\.onReconnecting\(false\)/);
  assert.match(engine, /RECONNECT_UI_DELAY_MS = 900L/);
});

test('both native engines negotiate the encrypted relay path while ringing but gate media on Answer', () => {
  assert.match(engine, /config\.iceCandidatePoolSize = 1/);
  assert.match(engine, /case "call-ringing":[\s\S]{0,220}startInitialOfferIfReady\(\)/);
  assert.match(engine, /case "offer":[\s\S]{0,100}if \(outgoing\) break;/);
  assert.match(engine, /audioTrack\.setEnabled\(answered\)/);
  assert.match(engine, /private boolean completeInitialConnectionIfReady\(\) \{\s*if \(!answered \|\| !transportReady/);
  assert.match(ios, /case "call-ringing":[\s\S]{0,180}startInitialOfferIfReadyLocked\(\)/);
  assert.match(ios, /case "offer":\s*guard !outgoing else/);
  assert.match(ios, /audioTrack\?\.isEnabled = answered && !muted/);
  assert.match(ios, /guard answered, transportReady, !connectedOnce/);
});

test('server-confirmed native Answer activates the prepared caller path', () => {
  assert.match(engine, /"native-call-answering"\.equals\(type\)\) \{ markOutgoingAnswered\(\); return; \}/);
  assert.match(engine, /case "call-accept":[\s\S]{0,100}markOutgoingAnswered\(\)/);
  assert.match(ios, /type == "native-call-answering"[\s\S]{0,180}markOutgoingAnsweredLocked\(\)/);
  assert.match(ios, /case "call-accept":[\s\S]{0,100}markOutgoingAnsweredLocked\(\)/);
  assert.match(engine, /private void markOutgoingAnswered\(\)[\s\S]{0,140}if \(answered\)/);
  assert.match(ios, /private func markOutgoingAnsweredLocked\(\)[\s\S]{0,140}guard !answered/);
});

test('both native engines serialize offers and ignore duplicate answers', () => {
  assert.match(engine, /if \(peer == null \|\| offerCreationInFlight\) return/);
  assert.match(engine, /iceRestart && peer\.signalingState\(\) != PeerConnection\.SignalingState\.STABLE/);
  assert.match(engine, /peer\.signalingState\(\) != PeerConnection\.SignalingState\.HAVE_LOCAL_OFFER/);
  assert.match(engine, /if \(connectWatchdogStarted\) return/);
  assert.match(ios, /guard !offerCreationInFlight else \{ return \}/);
  assert.match(ios, /iceRestart, pc\.signalingState != \.stable/);
  assert.match(ios, /guard pc\.signalingState == \.haveLocalOffer/);
});

test('server protects Answer from ICE bursts and acknowledges encrypted acceptance', () => {
  assert.match(server, /criticalCallSignal = \['call-accept', 'call-decline', 'call-busy', 'call-hangup'\]\.includes\(msg2\.type\)/);
  assert.match(server, /rateLimited\(`sig-critical:\$\{token\}`/);
  assert.match(server, /acceptsCurrentNativeCall = msg2\.type === 'call-accept'[\s\S]{0,900}status:'active', ringingUntil:0/);
  assert.match(server, /if \(acceptsCurrentNativeCall\) \{\s*await deliverSignalToMember\(tok, \{ type:'native-call-answering' \}, \{ allOwners:true \}\)/);
});

test('both native engines replay a bounded gathered ICE set once at Answer', () => {
  assert.match(engine, /private final List<IceCandidate> localIce = new ArrayList<>\(\)/);
  assert.match(engine, /if \(localIce\.size\(\) < 32\) localIce\.add\(candidate\)/);
  assert.match(engine, /private void resendLocalCandidatesAtAnswer\(\)[\s\S]{0,450}answerCandidatesResent = true;[\s\S]{0,200}sendLocalCandidate/);
  assert.match(engine, /sendSignal\("call-accept", new JSONObject\(\)\);\s*resendLocalCandidatesAtAnswer\(\)/);
  assert.match(ios, /private var localCandidates: \[RTCIceCandidate\] = \[\]/);
  assert.match(ios, /if self\.localCandidates\.count < 32 \{ self\.localCandidates\.append\(candidate\) \}/);
  assert.match(ios, /private func resendLocalCandidatesAtAnswerLocked\(\)[\s\S]{0,400}answerCandidatesResent = true[\s\S]{0,200}localCandidates\.forEach/);
  assert.match(ios, /sendSignalLocked\(type: "call-accept", payload: \[:\]\)\s*self\.resendLocalCandidatesAtAnswerLocked\(\)/);
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
  const networkSwitch = engine.slice(engine.indexOf('if (switched && connectedAtMs > 0L)'), engine.indexOf('}', engine.indexOf('if (switched && connectedAtMs > 0L)')));
  assert.match(networkSwitch, /reconnectSignalingForNetworkChange\(\)/);
  assert.doesNotMatch(networkSwitch, /beginMediaRecovery/);
  assert.match(engine, /private void reconnectSignalingForNetworkChange\(\)[\s\S]{0,400}connectSocket\(generation\)/);
  assert.match(engine, /private void handleSocketEnded\(int run, WebSocket endedSocket\)[\s\S]{0,350}socket = null[\s\S]{0,160}reconnect\(run, 1\)/);
  assert.match(engine, /stopWatchingNetworkChanges\(\);\s*recoveryRun\+\+;/);
  assert.match(manifest, /android\.permission\.ACCESS_NETWORK_STATE/);
  assert.match(engine, /private void restartIce\(\)[\s\S]{0,600}peer\.restartIce\(\);[\s\S]{0,160}createOffer\(true\)/);
  assert.match(engine, /ICE_RESTART_RETRY_MS = 12_000L/);
  assert.match(engine, /iceConnectionState\(\) == PeerConnection\.IceConnectionState\.CHECKING/);
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

test('Android: background and route polling do not reselect the active communication device', () => {
  const main = read('mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java');
  const callScreen = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeCallActivity.java');
  assert.match(main, /if \(!NativeCallActivity\.isRunning\(\)\) enforceAudioRouteAfterWebRtcConnects\(\)/);
  assert.match(callScreen, /selected != null && selected\.getId\(\) == device\.getId\(\)[\s\S]{0,120}setCommunicationDevice\(device\)/);
});

test('iOS: a dropped media path is recovered by an ICE restart from the caller', () => {
  const disconnected = ios.slice(ios.indexOf('if newState == .disconnected'), ios.indexOf('if newState == .disconnected') + 900);
  assert.match(disconnected, /reconnectSignalingForNetworkChangeLocked\(\)[\s\S]{0,200}beginMediaRecoveryLocked\(after: Self\.iceRestartGrace\)/);
  assert.match(ios, /if newState == \.failed, self\.connectedOnce \{[\s\S]{0,180}beginMediaRecoveryLocked\(after: 0\)/);
  assert.match(ios, /mandatoryConstraints: iceRestart \? \["IceRestart": "true"\] : nil/);
  assert.match(ios, /guard let peer, outgoing, answered else \{ return \}/);
  assert.match(ios, /nativeCallDidEnd\(callID: callID, action: "nativeConnectionLost"\)/);
  // A restored path must not re-announce "connected" (that would reset the web timer).
  assert.match(ios, /if self\.connectedOnce \{\s*self\.mediaPathRecoveredLocked\(\)\s*return\s*\}/);
  assert.match(ios, /continualGatheringPolicy = \.gatherContinually/);
  assert.match(ios, /case "call-restart-request":[\s\S]{0,500}beginMediaRecoveryLocked\(after: 0\)/);
  assert.match(ios, /private func requestOrRestartIceLocked\(\)[\s\S]{0,300}sendSignalLocked\(type: "call-restart-request"/);
  assert.match(ios, /private func restartIceLocked\(\)[\s\S]{0,600}peer\.restartIce\(\)[\s\S]{0,200}createAndSendOfferLocked\(iceRestart: true\)/);
  assert.match(ios, /iceRestartRetry: TimeInterval = 12/);
  assert.match(ios, /iceConnectionState == \.checking/);
  assert.match(ios, /iceRestartGrace: TimeInterval = 1\.5/);
});

test('iOS: a network switch refreshes signaling without falsely marking healthy media as reconnecting', () => {
  assert.match(ios, /NWPathMonitor\(\)/);
  assert.match(ios, /path\.usesInterfaceType\(\.wifi\)/);
  assert.match(ios, /path\.usesInterfaceType\(\.cellular\)/);
  const networkSwitch = ios.slice(ios.indexOf('guard let previous, previous != signature'), ios.indexOf('guard let previous, previous != signature') + 1_000);
  assert.match(networkSwitch, /reconnectSignalingForNetworkChangeLocked\(\)/);
  assert.match(networkSwitch, /network changed: awaiting ICE state/);
  assert.doesNotMatch(networkSwitch, /beginMediaRecoveryLocked\(after: 0\)/);
  assert.match(ios, /private func reconnectSignalingForNetworkChangeLocked\(\)[\s\S]{0,500}connectSignalingLocked\(\)/);
  assert.match(ios, /URLSessionConfiguration\.ephemeral[\s\S]{0,220}allowsCellularAccess = true/);
  assert.match(ios, /signalingAttemptGeneration[\s\S]{0,900}signal readiness timeout/);
  assert.match(ios, /oldSession\?\.invalidateAndCancel\(\)/);
  assert.match(ios, /extension NativeWebRTCCallEngine: URLSessionWebSocketDelegate[\s\S]{0,500}didOpenWithProtocol[\s\S]{0,500}type": "auth"/);
  const connectSignal = ios.slice(ios.indexOf('private func connectSignalingLocked()'), ios.indexOf('private func receiveLocked'));
  assert.doesNotMatch(connectSignal, /sendRawLocked\(\["type": "auth"/);
  assert.match(ios, /setup stalled: restarting ICE/);
  const reset = ios.slice(ios.indexOf('private func resetLocked()'));
  assert.match(reset.slice(0, 700), /recoveryGeneration \+= 1[\s\S]{0,120}stopPathMonitorLocked\(\)\s*connectedOnce = false/);
  assert.match(ios, /reconnectUIDelay: TimeInterval = 0\.9/);
});

test('the encrypted signaling relay permits a callee to request caller-side ICE recovery', () => {
  assert.match(server, /SIGNAL_TYPE_ALLOWLIST[\s\S]{0,300}'call-restart-request'/);
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

test('iOS: late audio activation cannot regress an already-connected call to Connecting', () => {
  const start = client.indexOf("} else if (detail.action === 'audioActivated')");
  const branch = client.slice(start, client.indexOf("} else if (detail.action === 'audioDeactivated')", start));
  assert.match(branch, /if \(Number\.isFinite\(room\.callStartedAt\)\) \{[\s\S]{0,300}room\.nativeAnswerPending = false;[\s\S]{0,300}return;/);
  assert.ok(branch.indexOf('Number.isFinite(room.callStartedAt)') < branch.indexOf('room.callStartedAt = null'));
});

test('iOS: opening the app switcher does not deactivate a live call audio session', () => {
  const scene = read('mobile/ios/App/App/SceneDelegate.swift');
  assert.match(scene, /let ownedAudioSession = speechRecognitionTask != nil/);
  assert.match(scene, /if ownedAudioSession \{\s*try\? AVAudioSession\.sharedInstance\(\)\.setActive\(false/);
  assert.match(scene, /refreshActiveNativeCallAudio\(reason: "scene-resign-active"\)/);
  assert.match(scene, /refreshActiveNativeCallAudio\(reason: "scene-active"\)/);
});

test('both native engines recover when inbound audio packets stall while ICE still looks connected', () => {
  assert.match(ios, /audioFlowStallThreshold: TimeInterval = 4/);
  assert.match(ios, /statistic\.type == "inbound-rtp"/);
  assert.match(ios, /statistic\.values\["bytesReceived"\]/);
  assert.match(ios, /audio flow stalled: starting recovery[\s\S]{0,100}beginMediaRecoveryLocked\(after: 0\)/);
  assert.match(engine, /AUDIO_FLOW_STALL_MS = 4_000L/);
  assert.match(engine, /"inbound-rtp"\.equals\(stat\.getType\(\)\)/);
  assert.match(engine, /members\.get\("bytesReceived"\)/);
  assert.match(engine, /audio flow stalled: starting recovery[\s\S]{0,150}beginMediaRecovery\(0L\)/);
  assert.match(ios, /audio flow recovered[\s\S]{0,100}mediaPathRecoveredLocked\(\)/);
  assert.match(engine, /audio flow recovered[\s\S]{0,100}finishMediaRecovery\(\)/);
});

test('iOS: the relay candidate is pre-gathered while ringing, a failed TURN fetch is retried then, and timings are traced', () => {
  assert.match(ios, /config\.iceCandidatePoolSize = 1/);
  // Credentials and peer are prepared at ring time for both directions.
  assert.match(ios, /PushKit wakes us before the user answers[\s\S]{0,200}self\.fetchTurnAndCreatePeerLocked\(\)/);
  assert.match(ios, /Prepare the relay and peer while CallKit is ringing[\s\S]{0,300}self\.fetchTurnAndCreatePeerLocked\(\)/);
  const retry = ios.slice(ios.indexOf('private func scheduleTurnRetryLocked()'), ios.indexOf('private func scheduleAcceptRetryLocked()'));
  assert.doesNotMatch(retry, /\banswered\b/, 'the retry must not wait for the answer');
  assert.match(ios, /if self\.peer == nil \{ self\.turnAttempt = 0 \}/);
  assert.match(ios, /timing media ready \\\(Int\(Date\(\)\.timeIntervalSince\(answeredAt\) \* 1000\)\)ms after answer/);
  assert.match(ios, /timing gathering=/);
});

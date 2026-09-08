const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const ios = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
const android = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'NativeCallActivity.java'), 'utf8');
const androidIncoming = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'IncomingCallActivity.java'), 'utf8');
const androidMessaging = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'VaultlixMessagingService.java'), 'utf8');
const androidMain = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('locked iOS terminal call actions cannot resurrect stale call UI', () => {
  assert.match(ios, /"occurredAt": Date\(\)\.timeIntervalSince1970 \* 1000/);
  assert.match(ios, /pendingActions\.removeAll/);
  assert.match(client, /staleTerminalAction/);
  assert.match(client, /silentPresentation:true/);
});

test('iOS unanswered CallKit timeout records a missed call before native state disappears', () => {
  assert.match(ios, /let payload = self\.calls\[callID\][\s\S]*reason: \.unanswered/);
  assert.match(ios, /reason: \.unanswered[\s\S]*self\.postAction\("missed", callID: callID, payload: payload\)/);
  assert.match(client, /detail\.action === 'missed'[\s\S]*addCallSysMsg\(room, 'Missed call', eventId\)/);
});

test('missed calls survive the iOS foreground and encrypted-room restoration race', () => {
  const scene = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
  assert.match(scene, /action\["action"\][\s\S]*== "missed"[\s\S]*\[2\.0, 5\.0, 9\.0\]/);
  assert.match(client, /const pendingNativeMissedCallActions = new Map\(\)/);
  assert.match(client, /detail\.action === 'missed'[\s\S]*pendingNativeMissedCallActions\.set\(key, detail\)/);
  assert.match(client, /function replayPendingNativeMissedCalls\(room\)[\s\S]*handleNativeCallAction\(detail\)/);
  assert.match(client, /function addRoomToState\(room\)[\s\S]*replayPendingNativeMissedCalls\(room\)/);
});

test('Android call-end push preserves missed-call history until the encrypted inbox is ready', () => {
  assert.match(androidMessaging, /isCallEnd[\s\S]*missedCall[\s\S]*markPendingWebViewCallEnd[\s\S]*"Missed call"/);
  assert.match(androidMain, /"Missed call"\.equals\(pendingEnd\[1\]\)[\s\S]*postDelayed[\s\S]*5_000/);
  assert.match(androidMain, /clearUnderlyingCallState\(pendingEnd\[0\], pendingEnd\[1\]\)/);
  assert.match(server, /const wasStillRinging = Boolean\(room2\.ringingUntil\)/);
});

test('opening a conversation clears its missed-call inbox alert', () => {
  assert.match(client, /function setActiveRoom\(code(?:, \{ deferMessages = false \} = \{\})?\)[\s\S]*room\.unread = 0/);
  assert.match(client, /missed_encrypted_call'\), alert: room\.unread > 0/);
  assert.match(client, /function renderChatBody\(room\)[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*body\.scrollTop = body\.scrollHeight/);
});

test('native Android ending uses the Vaultlix sand treatment', () => {
  assert.match(android, /VANISH_BACKGROUND = Color\.rgb\(250, 245, 247\)/);
  assert.match(android, /VANISH_BURGUNDY = Color\.rgb\(104, 44, 67\)/);
  assert.match(android, /random\.nextInt\(35\) - 17/);
  assert.match(android, /\.setDuration\(850\)/);
});

test('locked Android incoming call uses the polished Vaultlix call surface', () => {
  assert.match(androidIncoming, /verticalGradient\(INK_SOFT, INK\)/);
  assert.match(androidIncoming, /native_private_identity_protected/);
  assert.match(androidIncoming, /callAction\(R\.drawable\.ic_call_end, R\.string\.native_answer, ANSWER, true\)/);
  assert.match(androidIncoming, /ring\.animate\(\)\.scaleX\(1\.08f\)/);
});

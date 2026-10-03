const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function readFunction(name, nextName) {
  const start = client.indexOf(`function ${name}(`);
  const end = client.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return client.slice(start, end).replace(/\basync\s*$/, '');
}

const context = {};
vm.createContext(context);
vm.runInContext(
  `${readFunction('unansweredCallEvent', 'addCallSysMsg')}\n` +
  `${readFunction('callEventForViewer', 'processIncomingContent')}`,
  context,
);

test('unanswered calls use a receiver-specific missed label', () => {
  const event = context.unansweredCallEvent('initiator');
  assert.equal(context.callEventForViewer(event, true).text, 'No answer');
  assert.equal(context.callEventForViewer(event, false).text, 'Missed encrypted call');
});

test('perspective remains correct when the receiver writes the shared event first', () => {
  const event = context.unansweredCallEvent('receiver');
  assert.equal(context.callEventForViewer(event, true).text, 'Missed encrypted call');
  assert.equal(context.callEventForViewer(event, false).text, 'No answer');
});

test('declined calls use labels that describe each participant action', () => {
  const initiatedByCaller = context.callOutcomeEvent('declined', 'initiator');
  assert.equal(context.callEventForViewer(initiatedByCaller, true).text, 'Call declined');
  assert.equal(context.callEventForViewer(initiatedByCaller, false).text, 'Declined call');

  const writtenByReceiver = context.callOutcomeEvent('declined', 'receiver');
  assert.equal(context.callEventForViewer(writtenByReceiver, true).text, 'Declined call');
  assert.equal(context.callEventForViewer(writtenByReceiver, false).text, 'Call declined');
});

// Hanging up before the other person answers is "No answer" for the caller and
// a "Missed call" for the callee — never a separate "cancelled" record.
test('a cancelled-before-answer call is recorded as no answer / missed, in both perspectives', () => {
  const writtenByCaller = context.callOutcomeEvent('cancelled', 'initiator');
  assert.equal(writtenByCaller.outcome, 'unanswered');
  assert.equal(context.callEventForViewer(writtenByCaller, true).text, 'No answer');
  assert.equal(context.callEventForViewer(writtenByCaller, false).text, 'Missed encrypted call');

  const writtenByReceiver = context.callOutcomeEvent('cancelled', 'receiver');
  assert.equal(context.callEventForViewer(writtenByReceiver, true).text, 'Missed encrypted call');
  assert.equal(context.callEventForViewer(writtenByReceiver, false).text, 'No answer');
});

test('records from older builds that still say cancelled are shown as no answer / missed', () => {
  const legacy = { outcome:'cancelled', authorRole:'initiator', initiatorText:'Cancelled call', receiverText:'Caller cancelled' };
  assert.equal(context.callEventForViewer(legacy, true).text, 'No answer');
  assert.equal(context.callEventForViewer(legacy, false).text, 'Missed encrypted call');
});

test('cancelled history wording is rewritten by who placed the call', () => {
  assert.equal(context.uncancelledCallText('Cancelled call', true), 'No answer');
  assert.equal(context.uncancelledCallText('Caller cancelled', false), 'Missed call');
  assert.equal(context.uncancelledCallText('Call canceled', true), 'No answer');
  assert.equal(context.uncancelledCallText('Call canceled', false), 'Missed call');
  assert.equal(context.uncancelledCallText('Call declined', true), 'Call declined');
  assert.equal(context.uncancelledCallText(null, true), null);
});

// Native hosts report the call end after the room's own call state was reset,
// so callWasOutgoing is null there. Reading the role from state alone recorded
// the caller's own "No answer" as a receiver event — an incoming arrow.
test('the wording tells which side wrote the record, independent of reset call state', () => {
  for (const text of ['No answer', 'Call declined', 'Cancelled call']) assert.equal(context.callRoleFromHistoryText(text), 'initiator', text);
  for (const text of ['Missed call', 'Missed encrypted call', 'Declined call', 'Caller cancelled']) assert.equal(context.callRoleFromHistoryText(text), 'receiver', text);
  assert.equal(context.callRoleFromHistoryText('Call canceled'), null);
  assert.equal(context.callRoleFromHistoryText(null), null);
});

test('endCall and the native call-ended bridge take the role from the wording before falling back to state', () => {
  assert.match(client, /const callRole = historyRole \|\| \(room\.callWasOutgoing === true \? 'initiator' : 'receiver'\);/);
  assert.match(client, /const nativeCallRole = historyRole \|\| \(room\.callWasOutgoing === true \? 'initiator' : 'receiver'\);/);
});

test('no web path writes a cancelled call record any more, and endCall normalises native wording', () => {
  assert.doesNotMatch(client, /endCall\([^\n]*'(?:Caller cancelled|Cancelled call)'/);
  assert.match(client, /async function endCall\(room, toastMsg, sysMsgText, toastVariant, options = \{\}\) \{\s*if \(!room\) return;[\s\S]{0,400}sysMsgText = uncancelledCallText\(sysMsgText, historyRole \? historyRole === 'initiator' : room\.callWasOutgoing === true\);/);
  assert.match(client, /historyText = uncancelledCallText\(historyText, historyRole \? historyRole === 'initiator' : room\?\.callWasOutgoing === true\);/);
});

test('the server treats a hang-up during ringing as unanswered so the callee gets a missed-call alert', () => {
  const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(server, /msg2\.terminalReason === 'cancelled' && room2\.ringingUntil \? 'unanswered' : msg2\.terminalReason/);
  assert.match(server, /\(msg2\.terminalReason === 'cancelled' \? 'unanswered' : msg2\.terminalReason\)/);
});

test('call history makes no-answer and missed-call records visible', () => {
  assert.match(client, /Encrypted call\|Missed\(\?: encrypted\)\? call\|No answer\|Call declined\|Declined call\|Caller cancelled\|Cancel/);
  assert.match(client, /else if \(!isPerspectiveCallEvent \|\| rec\.callEventViewerRole === 'receiver'\) \{\s*room\.unread\+\+/);
});

test('terminal signalling carries the outcome through web and native paths', () => {
  assert.match(client, /terminalReason/);
  assert.match(client, /nativeCancelled/);
  assert.match(client, /endNativeCall\?\.\(outcome \|\| 'ended'\)/);
});

test('declines are acknowledged and retained as reliable terminal outcomes', () => {
  const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(server, /msg2\.type === 'call-decline'[\s\S]*callOutcome = msg2\.type === 'call-decline' \? 'declined'/);
  assert.match(server, /callOutcome,\s*\n\s*}/);
  assert.match(server, /isCallEnd:true, missedCall:false, callOutcome,/);
});

test('a competing call is reported as busy instead of declined', () => {
  const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const androidActions = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'NativeCallActions.java'), 'utf8');
  const androidEngine = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'NativeWebRtcCallEngine.java'), 'utf8');
  const androidActivity = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'NativeCallActivity.java'), 'utf8');
  const androidMessaging = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'VaultlixMessagingService.java'), 'utf8');
  assert.match(server, /memberHasAnotherActiveCall\(callee, matchedRoomCode\)[\s\S]*\? 'busy' : 'declined'/);
  assert.match(server, /type:callOutcome === 'busy' \? 'native-call-busy' : 'native-call-declined'/);
  assert.match(client, /msg\.type === 'native-call-busy'[\s\S]*is on another call/);
  assert.match(client, /msg\.callOutcome === 'busy'[\s\S]*is on another call/);
  assert.match(androidActions, /declineWhileBusy[\s\S]*"busy"/);
  assert.match(androidEngine, /"native-call-busy"\.equals\(type\)[\s\S]*reset\("busy"\)/);
  assert.match(androidMessaging, /engine\.end\(false, callOutcome\)/);
  assert.match(androidActivity, /"busy"\.equals\(reason\)[\s\S]*native_peer_on_another_call/);
});

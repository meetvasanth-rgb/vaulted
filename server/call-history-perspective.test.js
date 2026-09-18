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

test('cancelled calls distinguish caller and receiver perspectives', () => {
  const writtenByCaller = context.callOutcomeEvent('cancelled', 'initiator');
  assert.equal(context.callEventForViewer(writtenByCaller, true).text, 'Cancelled call');
  assert.equal(context.callEventForViewer(writtenByCaller, false).text, 'Caller cancelled');

  const writtenByReceiver = context.callOutcomeEvent('cancelled', 'receiver');
  assert.equal(context.callEventForViewer(writtenByReceiver, true).text, 'Caller cancelled');
  assert.equal(context.callEventForViewer(writtenByReceiver, false).text, 'Cancelled call');
});

test('call history makes no-answer and missed-call records visible', () => {
  assert.match(client, /Encrypted call\|Missed\(\?: encrypted\)\? call\|No answer\|Call declined\|Declined call\|Caller cancelled\|Cancel/);
  assert.match(client, /else if \(!isPerspectiveCallEvent \|\| rec\.callEventViewerRole === 'receiver'\) room\.unread\+\+/);
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

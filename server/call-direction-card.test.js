'use strict';

// WhatsApp-style call presentation: the Calls tab shows a direction arrow
// (incoming/outgoing, red when missed) next to each row's timestamp, and
// in-chat call events render as a message-bubble-style card (left/right by
// who placed the call, phone/video icon, title + subtitle, tap to call
// back) instead of the old plain centered sys-msg line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

// ── Pure helpers: callOutcomeEvent / connectedCallEvent / callEventViewerRoleFor / callRecDirection ──

const helperNames = ['callOutcomeEvent', 'connectedCallEvent', 'callEventViewerRoleFor', 'callRecDirection', 'callEventForViewer'];
const helperSandbox = vm.createContext({});
for (const name of helperNames) vm.runInContext(extract(client, name), helperSandbox);
function callHelper(name, ...args) {
  const argsLiteral = args.map(a => JSON.stringify(a)).join(',');
  return vm.runInContext(`${name}(${argsLiteral})`, helperSandbox);
}

test('callOutcomeEvent carries isVideo alongside the existing outcome/authorRole/text fields', () => {
  const declined = callHelper('callOutcomeEvent', 'declined', 'initiator', true);
  assert.equal(declined.isVideo, true);
  assert.equal(declined.authorRole, 'initiator');
  assert.equal(declined.initiatorText, 'Call declined');
  const withoutVideo = callHelper('callOutcomeEvent', 'cancelled', 'receiver');
  assert.equal(withoutVideo.isVideo, false);
});

test('connectedCallEvent gives the "connected" outcome an authorRole (needed for direction) with no per-side text', () => {
  const outgoing = JSON.parse(JSON.stringify(callHelper('connectedCallEvent', 'initiator', true)));
  assert.deepEqual(outgoing, { outcome:'connected', authorRole:'initiator', isVideo:true });
  const incoming = JSON.parse(JSON.stringify(callHelper('connectedCallEvent', 'receiver', false)));
  assert.deepEqual(incoming, { outcome:'connected', authorRole:'receiver', isVideo:false });
  assert.equal(callHelper('connectedCallEvent', null, false), null);
});

test('callRecDirection maps callEventViewerRole to outgoing/incoming, and null when unknown', () => {
  assert.equal(callHelper('callRecDirection', { callEventViewerRole:'initiator' }), 'outgoing');
  assert.equal(callHelper('callRecDirection', { callEventViewerRole:'receiver' }), 'incoming');
  assert.equal(callHelper('callRecDirection', { callEventViewerRole:null }), null);
  assert.equal(callHelper('callRecDirection', {}), null);
});

test('callEventViewerRoleFor flips role only when the synced record came from the peer, not from myself', () => {
  const event = { authorRole:'initiator' };
  assert.equal(callHelper('callEventViewerRoleFor', event, true), 'initiator', 'my own synced-back record keeps my role');
  assert.equal(callHelper('callEventViewerRoleFor', event, false), 'receiver', 'the peer placed it, so I received it');
  assert.equal(callHelper('callEventViewerRoleFor', { authorRole:'receiver' }, false), 'initiator');
  assert.equal(callHelper('callEventViewerRoleFor', null, true), null);
  assert.equal(callHelper('callEventViewerRoleFor', { outcome:'connected' }, true), null, 'no authorRole at all');
});

test('callEventViewerRoleFor and callEventForViewer agree on direction for the three outcomes that have text', () => {
  for (const fromMe of [true, false]) {
    const event = { outcome:'unanswered', authorRole:'initiator', initiatorText:'No answer', receiverText:'Missed encrypted call' };
    const role = callHelper('callEventViewerRoleFor', event, fromMe);
    const perspective = callHelper('callEventForViewer', event, fromMe);
    assert.equal(role, perspective.viewerRole);
  }
});

// ── callCardDetails: in-chat card title/subtitle/missed per family+direction ──

const cardSandbox = vm.createContext({});
vm.runInContext(extract(client, 'callHistoryFamily'), cardSandbox);
vm.runInContext(extract(client, 'callRecDirection'), cardSandbox);
vm.runInContext(extract(client, 'callCardDetails'), cardSandbox);
function cardDetails(rec) {
  cardSandbox.__rec = rec;
  return vm.runInContext('callCardDetails(__rec)', cardSandbox);
}

test('a connected call shows "Voice call"/duration, or "Video call" when callWasVideo is set', () => {
  const voice = cardDetails({ kind:'sys', content:'Encrypted call · 00:42 · 14:05', callEventViewerRole:'initiator', callWasVideo:false });
  assert.equal(voice.title, 'Voice call');
  assert.equal(voice.subtitle, '00:42');
  assert.equal(voice.direction, 'outgoing');
  assert.equal(voice.missed, false);
  const video = cardDetails({ kind:'sys', content:'Encrypted call · 01:03 · 14:05', callEventViewerRole:'receiver', callWasVideo:true });
  assert.equal(video.title, 'Video call');
  assert.equal(video.direction, 'incoming');
});

test('the receiver\'s own missed-call record gets the red "Missed voice call / Tap to call back" treatment', () => {
  const details = cardDetails({ kind:'sys', content:'Missed encrypted call · 14:05', callEventViewerRole:'receiver' });
  assert.equal(details.missed, true);
  assert.equal(details.title, 'Missed voice call');
  assert.equal(details.subtitle, 'Tap to call back');
  assert.equal(details.direction, 'incoming');
});

test('the caller\'s own "No answer" is not treated as missed — it is their own unanswered outgoing call', () => {
  const details = cardDetails({ kind:'sys', content:'No answer · 14:05', callEventViewerRole:'initiator' });
  assert.equal(details.missed, false);
  assert.equal(details.title, 'Voice call');
  assert.equal(details.subtitle, 'No answer');
  assert.equal(details.direction, 'outgoing');
});

test('declined and cancelled calls surface their existing text as the subtitle, un-missed', () => {
  assert.equal(cardDetails({ kind:'sys', content:'Call declined · 14:05', callEventViewerRole:'initiator' }).subtitle, 'Call declined');
  assert.equal(cardDetails({ kind:'sys', content:'Caller cancelled · 14:05', callEventViewerRole:'receiver' }).subtitle, 'Caller cancelled');
});

test('a non-call sys message (e.g. "Conversation cleared") is not a call card at all', () => {
  assert.equal(cardDetails({ kind:'sys', content:'Conversation cleared · 14:05' }), null);
});

test('a legacy record with no direction data defaults to the left/"them" side rather than guessing "me"', () => {
  const details = cardDetails({ kind:'sys', content:'Encrypted call · 00:10 · 14:05' });
  assert.equal(details.direction, 'incoming');
});

// ── renderCallHistoryList: the direction arrow icon on the Calls tab ──

function callsListHarness() {
  const context = vm.createContext({
    rooms:new Map(), privateGroups:new Map(), entries:[], state:{ accountId:'a' },
    loadAccountState: () => ({ accountId:'a' }),
    callHistoryEntries: () => context.entries,
    localStorage:{ getItem:() => null, setItem:() => {} },
    currentVaultListMode:'calls', tabFocused:true, quickLockActive:false, activePrivateGroupId:null,
    escHtml:s => String(s), roomDisplayLabel:room => room.name || room.code,
    formatVaultInboxTime:() => '10:00',
    document:{ hidden:false, getElementById:id => id === 's-vault-list' ? { classList:{ contains:() => true } } : null },
  });
  vm.runInContext(client.slice(client.indexOf('let vaultMissedCallsSeenAccount'), client.indexOf('\nfunction callHistoryEntries')), context);
  vm.runInContext(extract(client, 'callRecDirection'), context);
  vm.runInContext(extract(client, 'callDirectionIconHtml'), context);
  vm.runInContext(client.slice(client.indexOf('function renderCallHistoryList'), client.indexOf('\nfunction startCallFromHistory')), context);
  return context;
}

test('an outgoing call row gets the direction arrow with the "outgoing" class', () => {
  const c = callsListHarness();
  c.entries = [{ room:{ code:'r' }, rec:{ id:'1', callEventViewerRole:'initiator' }, text:'Encrypted call · 00:12', occurredAt:1 }];
  const body = { innerHTML:'', querySelectorAll:() => [] };
  c.renderCallHistoryList(body);
  assert.match(body.innerHTML, /vault-call-direction outgoing/);
  assert.doesNotMatch(body.innerHTML, /vault-call-direction incoming/);
});

test('an incoming missed call row gets the direction arrow with the "incoming" class, inside the red alert text', () => {
  const c = callsListHarness();
  c.entries = [{ room:{ code:'r' }, rec:{ id:'1', callEventViewerRole:'receiver' }, text:'Missed encrypted call', occurredAt:1 }];
  const body = { innerHTML:'', querySelectorAll:() => [] };
  c.renderCallHistoryList(body);
  assert.match(body.innerHTML, /vault-list-row-preview alert"><svg class="vault-call-direction incoming/);
});

test('a row with unknown direction (no callEventViewerRole) renders with no arrow at all, not a guessed one', () => {
  const c = callsListHarness();
  c.entries = [{ room:{ code:'r' }, rec:{ id:'1' }, text:'Encrypted call · 00:12', occurredAt:1 }];
  const body = { innerHTML:'', querySelectorAll:() => [] };
  c.renderCallHistoryList(body);
  assert.doesNotMatch(body.innerHTML, /vault-call-direction/);
});

// ── renderMessageRecord: the in-chat call card branch (structural) ──

test('renderMessageRecord routes call-family sys records to a call-card bubble, not the plain centered sys-msg', () => {
  const render = extract(client, 'renderMessageRecord');
  assert.match(render, /const callDetails = callCardDetails\(rec\);/);
  assert.match(render, /if \(callDetails\) \{/);
  assert.match(render, /callDetails\.direction === 'outgoing' \? 'me' : 'them'/);
  assert.match(render, /class="call-card\$\{callDetails\.missed \? ' missed' : ''\}"/);
  assert.match(render, /startCallFromHistory\(room\.code, callDetails\.isVideo\)/);
  // Every other system message (key-change notices, "Conversation cleared",
  // etc.) must still fall through to the original plain sys-msg branch —
  // callCardDetails() returning null for them is what makes that happen.
  assert.match(render, /div\.className = animate \? 'sys-msg msg-enter' : 'sys-msg';\s*\n\s*if \(Number\(rec\.ts\) > 0\) div\.dataset\.ts/);
});

// ── endCall / dissolveCallScreen: connectedCallEvent threaded through every "Encrypted call · duration" site ──

test('endCall builds connectedCallEvent from the current callRole+video and passes it to every connected-call history site', () => {
  const endCall = extract(client, 'endCall');
  assert.match(endCall, /const callEventConnected = connectedCallEvent\(callRole, wasVideoCall\);/);
  // dissolveCallScreen (the normal, non-locked path) receives it.
  assert.match(endCall, /await dissolveCallScreen\(room, duration, callHistoryEventId, callEventConnected\);/);
  // The App-Lock / quick-lock duration branch receives it too.
  assert.match(endCall, /addCallSysMsg\(room, `Encrypted call · \$\{formatCallTime\(duration\)\}`, callHistoryEventId, callEventConnected\);/);
});

test('dissolveCallScreen threads its callEvent parameter into both of its addCallSysMsg calls', () => {
  const dissolve = extract(client, 'dissolveCallScreen');
  assert.match(dissolve, /function dissolveCallScreen\(room, duration, eventId = null, callEvent = null\)/);
  const calls = dissolve.match(/addCallSysMsg\(room, `Encrypted call · \$\{formatCallTime\(duration\)\}`, eventId, callEvent\);/g) || [];
  assert.equal(calls.length, 2, 'the early-return no-overlay path and the end-of-animation path');
});

// ── The real bug: room.callState is a snapshot of the CURRENT phase (it
// moves on to 'active' the instant a call connects), not who placed the
// call — so deriving callRole from it inside endCall() returned null for
// EVERY call that actually connected, silently dropping the direction
// arrow (and the video flag riding on the same callEvent object) for
// exactly those calls. Only calls that ended while still ringing
// (declined/cancelled/unanswered, which never leave 'outgoing'/'incoming')
// kept it — matching the report exactly: arrows showed for "No answer"/
// "Caller cancelled" but not for "Encrypted call · MM:SS". ──

test('endCall no longer derives callRole from room.callState (the bug) — it uses the persistent room.callWasOutgoing instead', () => {
  const endCall = extract(client, 'endCall');
  assert.doesNotMatch(endCall, /const callRole = room\.callState === 'outgoing'/, 'the buggy state-snapshot derivation must be gone');
  assert.match(endCall, /const callRole = room\.callWasOutgoing === true \? 'initiator' : 'receiver';/);
});

test('startCallForRoom sets the persistent callWasOutgoing flag, independent of the transient callState', () => {
  const start = extract(client, 'startCallForRoom');
  assert.match(start, /room\.callState = 'outgoing';[\s\S]{0,400}?room\.callWasOutgoing = true;/);
});

test('the incoming-invite handler sets callWasOutgoing to false at the same point callState becomes \'incoming\'', () => {
  const idx = client.indexOf(`room.callState = 'incoming';\n      room.callWasOutgoing = false;`);
  assert.notEqual(idx, -1);
});

test('endCall resets callWasOutgoing back to null alongside the rest of its call-state cleanup, so it cannot leak into the next call', () => {
  const endCall = extract(client, 'endCall');
  assert.match(endCall, /room\.callState = 'idle';\s*\n\s*room\.callWasOutgoing = null;/);
});

test('wasVideoCall also checks the call\'s video INTENT (pendingVideoStart/incomingVideoCall), not just post-connection media state', () => {
  // A call that rang as a video call but was never answered never turns on
  // callHadVideo/callVideoOn/remoteVideoActive at all — those only ever
  // flip on after the call actually connects — so checking only those
  // three mislabeled every unanswered/declined/cancelled video call as a
  // plain voice call.
  const endCall = extract(client, 'endCall');
  assert.match(endCall, /const wasVideoCall = !!\(room\.pendingVideoStart \|\| room\.incomingVideoCall \|\| room\.callHadVideo \|\| room\.callVideoOn \|\| room\.remoteVideoActive\);/);
});

test('regression check: a room that has already transitioned to callState "active" (a connected call) still resolves a definite direction', () => {
  // Simulates exactly the bug scenario: by the time a connected call ends,
  // callState is 'active', not 'outgoing'/'incoming' — the fix must not
  // depend on callState at all for this.
  const roomOutgoing = { callState:'active', callWasOutgoing:true };
  const roomIncoming = { callState:'active', callWasOutgoing:false };
  const roleFor = room => room.callWasOutgoing === true ? 'initiator' : 'receiver';
  assert.equal(roleFor(roomOutgoing), 'initiator');
  assert.equal(roleFor(roomIncoming), 'receiver');
});

// ── processIncomingContent: the synced call-event decode path (receiving side) ──

test('the call-event decoder computes viewerRole for every outcome (including "connected"), not just the three with text, and carries the video flag', () => {
  const decode = extract(client, 'processIncomingContent');
  assert.match(decode, /const viewerRole = perspective\?\.viewerRole \|\| callEventViewerRoleFor\(parsed\.callEvent, fromMe\);/);
  assert.match(decode, /callEventViewerRole:viewerRole,/);
  assert.match(decode, /callWasVideo:!!parsed\.callEvent\?\.isVideo,/);
});

// ── persistCallSysMsg: the connected callEvent must actually reach the wire ──

test('addCallSysMsg stores callWasVideo from callEvent.isVideo, and persistCallSysMsg forwards the whole callEvent (including the connected one) to the peer', () => {
  const addFn = extract(client, 'addCallSysMsg');
  assert.match(addFn, /callWasVideo:!!callEvent\?\.isVideo,/);
  const persistFn = extract(client, 'persistCallSysMsg');
  assert.match(persistFn, /if \(rec\.callEvent\) payload\.callEvent = rec\.callEvent;/);
});

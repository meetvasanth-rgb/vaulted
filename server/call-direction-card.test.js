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

test('a legacy record with no direction data leaves direction null (no guessed arrow) rather than defaulting to "incoming"', () => {
  // A wrong guessed arrow is worse than no arrow — the render call site's
  // own `direction === 'outgoing' ? 'me' : 'them'` still puts the bubble
  // on the left without callCardDetails needing to guess a fake direction.
  const details = cardDetails({ kind:'sys', content:'Encrypted call · 00:10 · 14:05' });
  assert.equal(details.direction, null);
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
    formatCallHistoryTimestamp:() => '10:00',
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
  const body = { innerHTML:'', querySelector:() => null, querySelectorAll:() => [] };
  c.renderCallHistoryList(body);
  assert.match(body.innerHTML, /vault-call-direction outgoing/);
  assert.doesNotMatch(body.innerHTML, /vault-call-direction incoming/);
});

test('an incoming missed call row gets the direction arrow with the "incoming" class, inside the red alert text', () => {
  const c = callsListHarness();
  c.entries = [{ room:{ code:'r' }, rec:{ id:'1', callEventViewerRole:'receiver' }, text:'Missed encrypted call', occurredAt:1 }];
  const body = { innerHTML:'', querySelector:() => null, querySelectorAll:() => [] };
  c.renderCallHistoryList(body);
  assert.match(body.innerHTML, /vault-list-row-preview alert"><svg class="vault-call-direction incoming/);
});

test('a row with unknown direction (no callEventViewerRole) renders with no arrow at all, not a guessed one', () => {
  const c = callsListHarness();
  c.entries = [{ room:{ code:'r' }, rec:{ id:'1' }, text:'Encrypted call · 00:12', occurredAt:1 }];
  const body = { innerHTML:'', querySelector:() => null, querySelectorAll:() => [] };
  c.renderCallHistoryList(body);
  assert.doesNotMatch(body.innerHTML, /vault-call-direction/);
});

// ── Delete individual calls and clear all — reuses the same
// showDeleteOptions()/deleteMessage() plumbing chat messages already use,
// so removing a call entry from the Calls tab also removes it from the
// 1:1 chat (they're the same underlying room.messages record). ──

test('renderCallHistoryList shows a "Clear all calls" button above the list, wired to confirmClearAllCalls with the current entries', () => {
  const c = callsListHarness();
  c.entries = [{ room:{ code:'r' }, rec:{ id:'1', callEventViewerRole:'initiator' }, text:'Encrypted call · 00:12', occurredAt:1 }];
  const body = { innerHTML:'', querySelector(sel) { return sel === '#vault-clear-all-calls' ? this._btn : null; }, _btn:{ onclick:null }, querySelectorAll:() => [] };
  c.renderCallHistoryList(body);
  assert.match(body.innerHTML, /vault-clear-all-calls/);
  assert.match(body.innerHTML, /Clear all calls/);
  assert.equal(typeof body._btn.onclick, 'function');
});

test('each Calls tab row carries data-msg-id and is long-press-wired to delete that visible call, for me only', () => {
  const render = extract(client, 'renderCallHistoryList');
  assert.match(render, /data-msg-id="\$\{escHtml\(rec\.id \|\| ''\)\}"/);
  assert.match(render, /attachLongPress\(el, entry\.rec\.id, \(\) => showDeleteOptions\(entry\.room, entry\.rec\.id, false\)\);/);
});

test('confirmClearAllCalls records a cutoff for every room, including rooms whose older calls are not loaded yet', () => {
  const fn = extract(client, 'confirmClearAllCalls');
  assert.match(fn, /for \(const room of rooms\.values\(\)\) \{/);
  assert.match(fn, /room\.callHistoryClearedAt = Math\.max\(Number\(room\.callHistoryClearedAt\) \|\| 0, clearedAt\);/);
  assert.match(fn, /persistDeleteLedger\(room\);/);
  assert.match(fn, /if \(ids\.length\) await deleteMessage\(room, ids, false\);/);
});

test('callHistoryRecordIds expands one visible call row to every hidden and suppressed duplicate id', () => {
  const context = vm.createContext({ CALL_HISTORY_DEDUPE_WINDOW_MS:12000 });
  vm.runInContext(extract(client, 'callHistoryFamily'), context);
  vm.runInContext(extract(client, 'isSameCallHistoryRecord'), context);
  vm.runInContext(extract(client, 'rememberCallHistoryAlias'), context);
  vm.runInContext(extract(client, 'callHistoryRecordIds'), context);
  context.room = { messages:[
    { id:'call-event-shared', callHistoryAliasIds:['server-peer-copy'], kind:'sys', content:'Encrypted call · 00:10 · 14:05', ts:100000 },
    { id:'sys-call-native-fallback', kind:'sys', content:'Encrypted call · 00:11 · 14:05', ts:104000 },
    { id:'other-call', kind:'sys', content:'Encrypted call · 00:07 · 14:20', ts:900000 },
    { id:'chat-message', kind:'text', content:'hello', ts:104000 },
  ] };
  context.visible = context.room.messages[0];
  const ids = vm.runInContext('callHistoryRecordIds(room, visible)', context);
  assert.deepEqual(Array.from(ids), ['call-event-shared', 'server-peer-copy', 'sys-call-native-fallback']);
});

test('deleteMessage expands a local call deletion before removing records or writing the ledger', () => {
  const fn = extract(client, 'deleteMessage');
  assert.match(fn, /const requestedIds = Array\.isArray\(msgIdOrIds\) \? msgIdOrIds : \[msgIdOrIds\];/);
  assert.match(fn, /const expanded = !forEveryone && callHistoryFamily\(record\) \? callHistoryRecordIds\(room, record\) : \[msgId\];/);
  assert.match(fn, /for \(const id of expanded\.length \? expanded : \[msgId\]\) if \(!ids\.includes\(id\)\) ids\.push\(id\);/);
  assert.match(fn, /const callDeletionKey = callHistoryDeletionKey\(record\);/);
  assert.match(fn, /for \(const key of callDeletionKeys\) room\.deleteLedger\.set\(key, deletedAt\);/);
});

test('a deleted call fingerprint also suppresses a hidden peer copy with a different message id', () => {
  const context = vm.createContext({ CALL_HISTORY_DEDUPE_WINDOW_MS:12000 });
  vm.runInContext(extract(client, 'callHistoryFamily'), context);
  vm.runInContext(extract(client, 'callHistoryDeletionKey'), context);
  vm.runInContext(extract(client, 'callHistoryRecordDeleted'), context);
  context.visible = { id:'local-id', kind:'sys', content:'Encrypted call · 00:10 · 14:05', ts:100000 };
  context.hidden = { id:'peer-id', kind:'sys', content:'Encrypted call · 00:11 · 14:05', ts:108000 };
  context.room = { callHistoryClearedAt:0, deleteLedger:new Map([[context.callHistoryDeletionKey(context.visible), Date.now()]]) };
  assert.equal(vm.runInContext('callHistoryRecordDeleted(room, hidden)', context), true);
});

test('the clear-all cutoff suppresses older call records while allowing later calls', () => {
  const context = vm.createContext({ CALL_HISTORY_DEDUPE_WINDOW_MS:12000 });
  vm.runInContext(extract(client, 'callHistoryFamily'), context);
  vm.runInContext(extract(client, 'callHistoryRecordDeleted'), context);
  context.room = { callHistoryClearedAt:200000, deleteLedger:new Map() };
  context.oldCall = { id:'old', kind:'sys', content:'Missed encrypted call · 14:05', ts:150000 };
  context.newCall = { id:'new', kind:'sys', content:'Encrypted call · 00:10 · 14:10', ts:250000 };
  assert.equal(vm.runInContext('callHistoryRecordDeleted(room, oldCall)', context), true);
  assert.equal(vm.runInContext('callHistoryRecordDeleted(room, newCall)', context), false);
});

test('restored call duplicates retain the suppressed server id as a deletion alias', () => {
  const decode = extract(client, 'processIncomingContent');
  assert.match(decode, /const duplicate = room\.messages\.find\(existing => isSameCallHistoryRecord\(existing, callRecord\)\);/);
  assert.match(decode, /rememberCallHistoryAlias\(duplicate, msgId\);/);
  const restore = extract(client, 'applyRestoredHistory');
  assert.match(restore, /const duplicate = room\.messages\.find\(existing => isSameCallHistoryRecord\(existing, rec\)\);/);
  assert.match(restore, /rememberCallHistoryAlias\(duplicate, msg\.id\);/);
});

test('the in-chat call card carries data-msg-id, so a deletion can find and fade its DOM element if that chat happens to be open', () => {
  const render = extract(client, 'renderMessageRecord');
  assert.match(render, /div\.className = `msg call-msg \$\{callDetails\.direction === 'outgoing' \? 'me' : 'them'\}\$\{animate \? ' msg-enter' : ''\}`;\s*\n\s*div\.dataset\.msgId = rec\.id;/);
});

test('call cards display their event timestamp below the duration or call result', () => {
  const render = extract(client, 'renderMessageRecord');
  assert.match(render, /class="msg-meta call-card-meta"/);
  assert.match(render, /class="msg-time" title="\$\{escHtml\(formatFullDateTime\(rec\.ts\)\)\}">\$\{escHtml\(messageTimeLabel\(rec\)\)\}<\/span>/);
});

test('Calls tab rows retain the clock time as well as the relative day', () => {
  const render = extract(client, 'renderCallHistoryList');
  assert.match(render, /formatCallHistoryTimestamp\(occurredAt\)/);
  const formatter = extract(client, 'formatCallHistoryTimestamp');
  assert.match(formatter, /const clock = date\.toLocaleTimeString/);
  assert.match(formatter, /return `\$\{day\} · \$\{clock\}`;/);
});

// ── Bug: deleting an individual call from the Calls tab silently did
// nothing visible — removeMessageRecord() only fades the DOM row when the
// deleted room is the currently-open CHAT screen (room.code ===
// activeRoomCode), which is never true when the delete happened from the
// Calls tab itself. showDeleteOptions() must re-render the vault list
// itself when it's the active tab, not just rely on removeMessageRecord's
// own chat-only DOM update. ──

test('showDeleteOptions re-renders the vault list after a confirmed delete, so a Calls tab deletion is actually visible', () => {
  const fn = extract(client, 'showDeleteOptions');
  assert.match(fn, /const confirmDelete = async \(forEveryone\) => \{/);
  assert.match(fn, /await deleteMessage\(room, ids, forEveryone\);/);
  assert.match(fn, /if \(currentVaultListMode === 'calls'\) renderVaultList\(\);/);
});

// ── Bug: "Clear all calls" (and any individual delete) appeared to work
// immediately, but every deleted call reappeared after fully reopening
// the app. Root cause: startup restores each room's session — including
// its local-only deleteLedger — sequentially, awaiting a real /api/join
// network round-trip per room one at a time; that can take real time
// across several rooms. The Calls tab's own eager-restore-every-room
// trigger (restoreRoomHistoryInBackground, added earlier this session)
// does not wait for that slow loop — opening the Calls tab shortly after
// launch (an entirely normal thing to do) could re-fetch a room's full
// history before that room's turn in the slow loop ever came up, while
// its deleteLedger was still makeRoom()'s empty default, silently
// resurrecting every previously deleted message in it — not just calls.
// Fixed by loading deleteLedger in the earlier, fully-synchronous, purely
// local hydration pass instead, before any restore can possibly race
// ahead of it. ──

test('deleteLedger is loaded in the first synchronous per-room hydration pass, not only in the slow per-room network-restore loop', () => {
  const idx = client.indexOf("for (const code of idx) {\n      const session = loadRoomSession(code);");
  assert.notEqual(idx, -1, 'the first (synchronous) hydration loop');
  const loopEnd = client.indexOf('\n    }', idx);
  const firstLoop = client.slice(idx, loopEnd);
  assert.match(firstLoop, /room\.deleteLedger = new Map\(Object\.entries\(session\.deleteLedger \|\| \{\}\)\.map\(\(\[k, v\]\) => \[k, Number\(v\)\]\)\);/);
  // The later, slow per-room loop's own assignment is left in place as a
  // harmless no-op safety net — not required to be removed by this fix.
});

test('addCallSysMsg also checks the delete ledger directly, so a queued native call-end notification cannot resurrect an already-deleted call', () => {
  const fn = extract(client, 'addCallSysMsg');
  assert.match(fn, /if \(callHistoryRecordDeleted\(room, rec\)\) return;/);
});

test('call-history clear cutoff is persisted, restored synchronously, and merged across account copies', () => {
  const persist = extract(client, 'persistDeleteLedger');
  assert.match(persist, /existing\.callHistoryClearedAt = Math\.max/);
  const importBundle = extract(client, 'importAccountBundle');
  assert.match(importBundle, /const callHistoryClearedAt = Math\.max/);
  assert.match(client, /callHistoryClearedAt:session\.callHistoryClearedAt/);
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
  assert.match(endCall, /const callRole = historyRole \|\| \(room\.callWasOutgoing === true \? 'initiator' : 'receiver'\);/);
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

// ── pendingVideoStart is a "hasn't started yet" flag, cleared the instant
// the call connects (beginPendingVideoStart) — so for a call that DID
// connect, wasVideoCall could only still see it via callHadVideo/
// callVideoOn/remoteVideoActive. Those are only ever set by iOS's own
// vaultlix:native-video-state event (SceneDelegate.swift); Android's
// dedicated native call screen owns video entirely on the native side and
// never dispatches an Android equivalent, so a connected Android video
// call had no JS-visible record of ever being one by the time it ended —
// "in iOS it's all fine [but Android video still shows as voice]".

test('beginPendingVideoStart records callHadVideo before clearing pendingVideoStart, so the fact survives past call-connect on every platform', () => {
  const fn = extract(client, 'beginPendingVideoStart');
  const clearIdx = fn.indexOf('room.pendingVideoStart = false;');
  const recordIdx = fn.indexOf('room.callHadVideo = true;');
  const androidEarlyReturnIdx = fn.indexOf("if (room.nativeCallActive && window.VaultlixAndroid?.supportsNativeWebRtc?.()) return;");
  assert.notEqual(clearIdx, -1);
  assert.notEqual(recordIdx, -1);
  assert.notEqual(androidEarlyReturnIdx, -1);
  // Must run for every platform, including Android's native early return —
  // not just the iOS/browser toggleCamera() path below it.
  assert.ok(recordIdx > clearIdx && recordIdx < androidEarlyReturnIdx,
    'callHadVideo must be set before the Android-native early return, not after it');
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

// ── vaultlixNativeCallEnded: Android's dedicated call activity bridge ──
// bypasses endCall() entirely whenever this device's own callState already
// reset to 'idle' by the time the native host reports back (the common
// case for a call handled by the separate keyguard-safe WebView) — so
// endCall()'s callRole/wasVideoCall fix never applied to it, and every
// call ending through this specific path kept showing as incoming/voice
// regardless of what it actually was, exactly matching the "all calls
// show the down arrow of incoming only" and "video call shown as voice"
// reports.

test('the vaultlixNativeCallEnded idle-fallback branch builds a real callEvent from callWasOutgoing/video-intent instead of passing null', () => {
  const start = client.indexOf('window.vaultlixNativeCallEnded = function(roomCode, historyText = \'\') {');
  assert.notEqual(start, -1);
  const end = client.indexOf('\n};', start);
  const fn = client.slice(start, end);
  assert.match(fn, /const nativeCallRole = historyRole \|\| \(room\.callWasOutgoing === true \? 'initiator' : 'receiver'\);/);
  assert.match(fn, /const nativeWasVideo = !!\(room\.pendingVideoStart \|\| room\.incomingVideoCall \|\| room\.callHadVideo \|\| room\.callVideoOn \|\| room\.remoteVideoActive\);/);
  assert.match(fn, /const nativeCallEvent = nativeOutcome\s*\n\s*\? callOutcomeEvent\(nativeOutcome, nativeCallRole, nativeWasVideo\)\s*\n\s*: connectedCallEvent\(nativeCallRole, nativeWasVideo\);/);
  assert.match(fn, /addCallSysMsg\(room, historyText, room\.lastCallHistoryEventId \|\| null, nativeCallEvent\);/);
  // Must also clean up after itself — this path bypasses endCall's own
  // reset entirely, so nothing else clears callWasOutgoing for it.
  assert.match(fn, /room\.callWasOutgoing = null;/);
});

// ── Color scheme: green outgoing, orange incoming, red only when missed
// (per explicit user feedback across two rounds) ──

test('the direction arrow is green outgoing, orange incoming, and red only for missed', () => {
  assert.match(client, /\.vault-call-direction\.outgoing\{stroke:var\(--green\)\}/);
  assert.match(client, /\.vault-call-direction\.incoming\{stroke:#D9822B\}/);
  assert.match(client, /\.vault-call-direction\.missed\{stroke:#C0293F\}/);
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

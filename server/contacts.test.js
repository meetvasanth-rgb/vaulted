'use strict';

// Private phone book (Contacts). A contact is a saved Vaultlix number + nickname — no
// messages, no keys — kept device-side under its own per-account localStorage key
// (never through persistRoom). Accepting a request saves the person; deleting a chat
// can also remove the contact; messaging a contact with no open chat re-sends a normal
// connection request, which the other person's app accepts automatically when the
// sender is in their contacts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFn(name) {
  const start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const asyncStart = client.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(asyncStart, i + 1);
  }
  throw new Error('unbalanced');
}

const BLOCK_START = '// ── CONTACTS (private phone book)';
const BLOCK_END = 'async function refreshConnectionRequests()';
const block = client.slice(client.indexOf(BLOCK_START), client.indexOf(BLOCK_END));
assert.ok(block.length > 2000, 'contacts block present');

const ME = '2000000001';
const A = '2111111111', B = '2222222222', C = '2333333333';
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ account = { accountId:'acc1', privateNumber:ME }, rooms = [], vaultListActive = true } = {}) {
  const storage = new Map();
  const roomMap = new Map(rooms.map(room => [room.code, { messages:[], ...room }]));
  const events = { accept:[], sent:[], rendered:[] };
  let context;
  context = vm.createContext({
    localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)) },
    document: { addEventListener: () => {}, getElementById: id => id === 's-vault-list' ? { classList:{ contains:name => name === 'active' && vaultListActive } } : null },
    loadAccountState: () => account,
    rooms: roomMap, storage, events, console, URL,
    isChatHidden: code => code === 'hidden-room',
    roomDisplayLabel: room => room.peerName || '',
    hiddenChatsUnlocked: false,
    pendingIncomingConnections: [], pendingConnectionAcceptance: null,
    acceptConnectionRequest: async id => { events.accept.push(id); },
    isRoomVisible: () => true, renderMessageRecord: (room, rec) => events.rendered.push(rec.id),
    formatMsgTime: () => '10:00',
    encryptTextMsg: async (room, text) => `enc:${text}`,
    api: async (route, body) => { events.sent.push([route, body]); return context.apiAnswer ? context.apiAnswer(route, body) : { ok:true }; },
    renderContactsPage: () => {}, renderVaultList: () => {}, delay: async () => {},
    removeRoomFromState: code => roomMap.delete(code),
  });
  vm.runInContext([
    extractFn('normalizePrivateNumber'), extractFn('formatPrivateNumber'), extractFn('roomForPrivateNumber'),
    extractFn('peerIdentityFromConnection'), extractFn('safeProfileImageUri'),
  ].map(source => source).join('\n'), context);
  vm.runInContext(block, context);
  return context;
}

const run = (context, code) => vm.runInContext(code, context);
const read = (context, key = 'vaultlix_contacts:acc1') => JSON.parse(context.storage.get(key) || 'null');

test('contacts are stored per account under their own key, with read-modify-write', () => {
  const ctx = harness();
  assert.equal(run(ctx, `addContact('${A}', 'Alice')`), true);
  assert.deepEqual(plain(read(ctx).list.map(contact => [contact.number, contact.name])), [[A, 'Alice']]);
  assert.equal(run(ctx, `addContact('${A}', 'Alice')`), false, 'adding twice does not duplicate');
  assert.equal(read(ctx).list.length, 1);
  const other = harness({ account:{ accountId:'acc2', privateNumber:'2000000002' } });
  assert.equal(run(other, 'readContactsStore().list.length'), 0, 'another account starts empty');
  assert.match(client, /const CONTACTS_KEY_PREFIX = 'vaultlix_contacts:';/);
  assert.doesNotMatch(block, /persistRoom\(/, 'contacts never go through persistRoom');
});

test('invalid numbers are rejected, names are cleaned, and the list is capped', () => {
  const ctx = harness();
  assert.equal(run(ctx, "addContact('12', 'x')"), false);
  assert.equal(run(ctx, "addContact('', 'x')"), false);
  run(ctx, `addContact('${A}', '   Alice    Wonderland   ')`);
  assert.equal(read(ctx).list[0].name, 'Alice Wonderland');
  run(ctx, `renameContact('${A}', '${'n'.repeat(80)}')`);
  assert.equal(read(ctx).list[0].nickname.length, 40);
  run(ctx, "CONTACTS_MAX; updateContactsStore(store => { for (let i = 0; i < CONTACTS_MAX; i++) store.list.push({ number:String(2100000000 + i), name:'', nickname:'', addedAt:0, favorite:false, hidden:false }); })");
  assert.equal(run(ctx, `addContact('${B}', 'Overflow')`), false);
});

test('rename, favourite, hidden and remove only touch that contact', () => {
  const ctx = harness();
  run(ctx, `addContact('${A}', 'Alice'); addContact('${B}', 'Bob')`);
  run(ctx, `renameContact('${A}', 'Ally'); setContactFavorite('${A}', true); setContactHidden('${B}', true)`);
  const list = read(ctx).list;
  assert.equal(list.find(c => c.number === A).nickname, 'Ally');
  assert.equal(list.find(c => c.number === A).favorite, true);
  assert.equal(list.find(c => c.number === B).hidden, true);
  assert.equal(run(ctx, `contactDisplayName(getContact('${A}'))`), 'Ally', 'nickname wins');
  run(ctx, `removeContact('${A}')`);
  assert.deepEqual(plain(read(ctx).list.map(c => c.number)), [B]);
  assert.equal(run(ctx, `isContact('${A}')`), false);
});

test('a hidden contact is not visible until hidden chats are unlocked', () => {
  const ctx = harness();
  run(ctx, `addContact('${A}', 'Alice'); setContactHidden('${A}', true)`);
  assert.equal(run(ctx, `contactIsVisible(getContact('${A}'))`), false);
  run(ctx, 'hiddenChatsUnlocked = true');
  assert.equal(run(ctx, `contactIsVisible(getContact('${A}'))`), true);
});

test('a contact whose chat is hidden is created hidden', () => {
  const ctx = harness({ rooms:[{ code:'hidden-room', peerPrivateNumber:A, peerName:'Alice' }] });
  run(ctx, `addContact('${A}', 'Alice')`);
  assert.equal(read(ctx).list[0].hidden, true);
});

const accepted = (id, peer, code) => ({
  id, status:'accepted', direction:'outgoing', inviteUrl:`https://vaultlix.com/join/${code}`,
  senderPrivateNumber:ME, recipientPrivateNumber:peer, recipientDisplayName:`P${peer.slice(-2)}`,
});

test('first run saves everyone you already chat with; a removed contact does not come back', () => {
  const ctx = harness({ rooms:[{ code:'r-a', peerPrivateNumber:A, peerName:'Alice' }, { code:'r-b', peerPrivateNumber:B, peerName:'Bob' }] });
  const requests = [accepted('q1', A, 'r-a'), accepted('q2', B, 'r-b')];
  run(ctx, `contactsSyncFromRequests(${JSON.stringify(requests)}, loadAccountState())`);
  assert.deepEqual(plain(read(ctx).list.map(c => c.number).sort()), [A, B]);
  assert.equal(read(ctx).migrated, true);
  run(ctx, `removeContact('${A}')`);
  run(ctx, `contactsSyncFromRequests(${JSON.stringify(requests)}, loadAccountState())`);
  assert.equal(run(ctx, `isContact('${A}')`), false, 'removal sticks across refreshes');
});

test('accepting a new request later saves the person, once per request', () => {
  const ctx = harness({ rooms:[{ code:'r-a', peerPrivateNumber:A, peerName:'Alice' }] });
  run(ctx, `contactsSyncFromRequests(${JSON.stringify([accepted('q1', A, 'r-a')])}, loadAccountState())`);
  run(ctx, `removeContact('${A}')`);
  // The same person reconnects: a NEW accepted request id for a new room.
  run(ctx, "rooms.set('r-a2', { code:'r-a2', messages:[], peerPrivateNumber:'" + A + "', peerName:'Alice' })");
  const again = [accepted('q1', A, 'r-a'), accepted('q3', A, 'r-a2')];
  run(ctx, `contactsSyncFromRequests(${JSON.stringify(again)}, loadAccountState())`);
  assert.equal(run(ctx, `isContact('${A}')`), true);
  run(ctx, `removeContact('${A}')`);
  run(ctx, `contactsSyncFromRequests(${JSON.stringify(again)}, loadAccountState())`);
  assert.equal(run(ctx, `isContact('${A}')`), false, 'q3 was already handled');
});

test('an accepted request whose room is not on this device saves nothing yet', () => {
  const ctx = harness({ rooms:[{ code:'r-a', peerPrivateNumber:A, peerName:'Alice' }] });
  run(ctx, `contactsSyncFromRequests(${JSON.stringify([accepted('q1', A, 'r-a')])}, loadAccountState())`);
  run(ctx, `contactsSyncFromRequests(${JSON.stringify([accepted('q9', C, 'r-gone')])}, loadAccountState())`);
  assert.equal(run(ctx, `isContact('${C}')`), false);
  assert.ok(!read(ctx).seen.includes('q9'), 'left unhandled so it is added when the room appears');
});

test('before the rooms are loaded the first run waits instead of marking everything handled', () => {
  const ctx = harness({ rooms:[] });
  run(ctx, `contactsSyncFromRequests(${JSON.stringify([accepted('q1', A, 'r-a')])}, loadAccountState())`);
  assert.equal(read(ctx).migrated, false);
  assert.deepEqual(plain(read(ctx).seen), []);
  const empty = harness({ rooms:[] });
  run(empty, 'contactsSyncFromRequests([], loadAccountState())');
  assert.equal(read(empty).migrated, true, 'a brand-new account has nothing to wait for');
});

const incoming = (id, peer) => ({ id, status:'pending', direction:'incoming', senderPrivateNumber:peer, senderDisplayName:`Name${peer.slice(-2)}`, recipientPrivateNumber:ME });

test('a request from a contact with no open chat is accepted automatically, with the reopen notice armed', async () => {
  const ctx = harness();
  run(ctx, `addContact('${A}', 'Alice')`);
  run(ctx, `pendingIncomingConnections = ${JSON.stringify([incoming('req-1', A)])}`);
  await run(ctx, 'maybeAutoAcceptContactRequests()');
  assert.deepEqual(plain(ctx.events.accept), ['req-1']);
  assert.equal(run(ctx, 'contactReopenPending'), null, 'cleared once the accept finished');
});

test('the reopen details are available while the accept runs', async () => {
  const ctx = harness();
  run(ctx, `addContact('${A}', 'Alice')`);
  let seen = null;
  ctx.acceptConnectionRequest = async id => { seen = plain(run(ctx, 'contactReopenPending')); };
  run(ctx, `pendingIncomingConnections = ${JSON.stringify([incoming('req-1', A)])}`);
  await run(ctx, 'maybeAutoAcceptContactRequests()');
  assert.equal(seen.requestId, 'req-1');
  assert.equal(seen.number, A);
  assert.equal(seen.name, 'Name11');
});

test('strangers, people who removed you, existing chats and other screens never auto-accept', async () => {
  const stranger = harness();
  run(stranger, `pendingIncomingConnections = ${JSON.stringify([incoming('req-1', B)])}`);
  await run(stranger, 'maybeAutoAcceptContactRequests()');
  assert.equal(stranger.events.accept.length, 0, 'not a contact -> a normal request');

  const withChat = harness({ rooms:[{ code:'r-a', token:'tok', peerPrivateNumber:A }] });
  run(withChat, `addContact('${A}', 'Alice'); pendingIncomingConnections = ${JSON.stringify([incoming('req-2', A)])}`);
  await run(withChat, 'maybeAutoAcceptContactRequests()');
  assert.equal(withChat.events.accept.length, 0, 'a request while the chat is still alive is a secure reconnection and needs consent');
  assert.equal(withChat.rooms.has('r-a'), true, 'a live chat is never dropped');

  const elsewhere = harness({ vaultListActive:false });
  run(elsewhere, `addContact('${A}', 'Alice'); pendingIncomingConnections = ${JSON.stringify([incoming('req-3', A)])}`);
  await run(elsewhere, 'maybeAutoAcceptContactRequests()');
  assert.equal(elsewhere.events.accept.length, 0, 'never pulls the person out of what they are doing');

  const removed = harness();
  run(removed, `addContact('${A}', 'Alice'); removeContact('${A}'); pendingIncomingConnections = ${JSON.stringify([incoming('req-4', A)])}`);
  await run(removed, 'maybeAutoAcceptContactRequests()');
  assert.equal(removed.events.accept.length, 0, 'removing the contact switches it off');

  const busy = harness();
  run(busy, `addContact('${A}', 'Alice'); pendingConnectionAcceptance = 'other'; pendingIncomingConnections = ${JSON.stringify([incoming('req-5', A)])}`);
  await run(busy, 'maybeAutoAcceptContactRequests()');
  assert.equal(busy.events.accept.length, 0, 'one acceptance at a time');
});

test('only one auto-accept runs at a time', async () => {
  const ctx = harness();
  run(ctx, `addContact('${A}', 'Alice')`);
  let release; const gate = new Promise(resolve => { release = resolve; });
  ctx.acceptConnectionRequest = async id => { ctx.events.accept.push(id); await gate; };
  run(ctx, `pendingIncomingConnections = ${JSON.stringify([incoming('req-1', A)])}`);
  const first = run(ctx, 'maybeAutoAcceptContactRequests()');
  await run(ctx, 'maybeAutoAcceptContactRequests()');
  release(); await first;
  assert.deepEqual(plain(ctx.events.accept), ['req-1']);
});

test('the reopened chat gets a visible notice, sent encrypted once the key exists', async () => {
  const ctx = harness();
  const room = { code:'new-room', token:'tok', messages:[], seenMsgIds:new Set(), sharedKey:null };
  ctx.room = room;
  run(ctx, "queueContactReopenNotice(room, { name:'Alice' })");
  assert.equal(room.messages.length, 1);
  assert.match(room.messages[0].content, /^Alice reopened this chat · /);
  assert.equal(room.messages[0].contactEvent, true);
  assert.equal(room.messages[0].kind, 'sys');
  assert.equal(ctx.events.rendered.length, 1);
  await run(ctx, 'flushContactReopenNotice(room)');
  assert.equal(ctx.events.sent.length, 0, 'nothing is sent before the shared key exists');
  room.sharedKey = {};
  await run(ctx, 'flushContactReopenNotice(room)');
  assert.equal(ctx.events.sent.length, 1);
  const [route, body] = plain(ctx.events.sent[0]);
  assert.equal(route, '/api/send');
  assert.equal(body.msgId, room.messages[0].id, 'same id, so the peer and the later poll do not duplicate it');
  assert.equal(body.suppressNotification, true);
  assert.match(body.content, /"contactEvent":"reopened"/);
  assert.equal(room.pendingContactNotice, null);
});

test('a notice that fails to send is kept for the next poll', async () => {
  const ctx = harness();
  ctx.api = async () => { throw new Error('offline'); };
  const room = { code:'r', token:'t', messages:[], seenMsgIds:new Set(), sharedKey:{}, pendingContactNotice:{ id:'n1', actorName:'Alice' } };
  ctx.room = room;
  await run(ctx, 'flushContactReopenNotice(room)');
  assert.deepEqual(plain(room.pendingContactNotice), { id:'n1', actorName:'Alice' });
});

test('the other side sees the notice as their own action, and notices are visible records', () => {
  const branch = client.slice(client.indexOf("if (parsed.contactEvent === 'reopened') {"), client.indexOf('const callRecord = {', client.indexOf("if (parsed.contactEvent === 'reopened') {")));
  assert.match(branch, /fromMe \? `\$\{actor\} reopened this chat · \$\{time\}` : `You reopened this chat · \$\{time\}`/);
  assert.match(branch, /contactEvent:true/);
  assert.match(client, /if \(rec\.timerEvent === true \|\| rec\.contactEvent === true\) return true;/);
});

test('the notice is queued for the room the automatic accept creates, and flushed on poll', () => {
  assert.match(client, /if \(mode === 'connection' && contactReopenPending && contactReopenPending\.requestId === pendingConnectionAcceptance\) \{\s*queueContactReopenNotice\(room, contactReopenPending\);/);
  assert.match(client, /if \(room\.pendingContactNotice && room\.sharedKey\) flushContactReopenNotice\(room\)\.catch\(\(\) => \{\}\);/);
});

test('delete chat offers "also remove contact" only for a contact, otherwise the plain confirm', async () => {
  const noContact = harness();
  let confirmed = 0;
  noContact.confirm = () => { confirmed++; return true; };
  noContact.i18n = () => 'Erase this conversation for both people?';
  run(noContact, extractFn('askCloseEraseChoice'));
  noContact.room = { peerPrivateNumber:B };
  assert.equal(await run(noContact, 'askCloseEraseChoice(room)'), 'chat');
  assert.equal(confirmed, 1);
  noContact.confirm = () => false;
  assert.equal(await run(noContact, 'askCloseEraseChoice(room)'), null);

  assert.match(client, /<button type="button" class="contact-sheet-btn danger" data-choice="chat">Delete chat<\/button>/);
  assert.match(client, /data-choice="contact">Delete chat and remove contact<\/button>/);
});

test('closing a chat removes the contact only when that choice was made', () => {
  const fn = extractFn('closeActiveRoom');
  assert.match(fn, /const eraseChoice = await askCloseEraseChoice\(room\);\s*if \(!eraseChoice\) return;/);
  assert.match(fn, /const erasedPeerNumber = room\.peerPrivateNumber;/);
  assert.match(fn, /if \(eraseChoice === 'contact'\) removeContact\(erasedPeerNumber\);/);
  assert.doesNotMatch(fn, /if \(!confirm\(i18n\('close_erase_confirm'\)\)\) return;/);
});

test('hiding a chat hides its contact; unhiding shows it again', () => {
  assert.match(extractFn('hideChat'), /setContactHidden\(room\.peerPrivateNumber, true\);/);
  assert.match(extractFn('unhideChat'), /if \(room\) setContactHidden\(room\.peerPrivateNumber, false\);/);
  assert.match(extractFn('refreshHiddenChatsViews'), /renderContactsPageIfOpen\(\);/);
});

test('request handling saves contacts and runs the automatic accept; the inbox retries it', () => {
  const refresh = extractFn('refreshConnectionRequests');
  assert.match(refresh, /await reconcileConversationPeerIdentities\(result\.requests, state\);\s*contactsSyncFromRequests\(result\.requests, state\);/);
  assert.match(refresh, /maybeAutoAcceptContactRequests\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(extractFn('openVaultInbox'), /maybeAutoAcceptContactRequests\(\)\.catch\(\(\) => \{\}\);/);
});

test('the Chats header opens Contacts, which has its own screen with search and back', () => {
  assert.match(client, /onclick="openContacts\(\)" title="Contacts" aria-label="Open contacts"/);
  assert.match(client, /<div id="s-contacts" class="screen">/);
  assert.match(client, /id="contacts-search"[^>]*oninput="filterContacts\(this\.value\)"/);
  assert.match(client, /onclick="closeContacts\(\)" aria-label="Back"/);
  assert.match(extractFn('openContacts'), /showScreen\('s-contacts'\);\s*renderContactsPage\(\);/);
});

test('messaging a contact opens the existing chat, or reuses the normal connection request', () => {
  const fn = extractFn('openContactChat');
  assert.match(fn, /const existing = roomForPrivateNumber\(normalized\);\s*if \(existing\) \{ openConversationAfterPaint\(existing\.code\); return; \}/);
  assert.match(fn, /api\('\/api\/connections\/request', \{ accountId:state\.accountId, sessionToken:state\.sessionToken, privateNumber:normalized \}\)/);
  assert.match(fn, /replaceExisting:true/);
  assert.match(fn, /restoreConnectedConversationFromBackup\(result, normalized\)/);
  assert.match(fn, /openConnectionRequest\(result\.requestId\)/);
});

test('the contact page offers message, calls, nickname, favourite and remove', () => {
  const sheet = extractFn('openContactSheet');
  for (const act of ['message', 'call', 'video', 'rename', 'favorite', 'remove', 'close']) assert.match(sheet, new RegExp(`data-act="${act}"`), act);
  const actions = extractFn('contactSheetAction');
  assert.match(actions, /startCallFromHistory\(room\.code, action === 'video'\)/);
  assert.match(actions, /removeContact\(number\);/);
});

test('the list is grouped (favourites first, then A-Z), searchable by name or number, with an empty state', () => {
  const fn = extractFn('renderContactsPage');
  assert.match(fn, /Favourites/);
  assert.match(fn, /localeCompare/);
  assert.match(fn, /contact\.number\.includes\(digits\)/);
  assert.match(fn, /No contacts yet/);
  assert.match(fn, /filter\(contactIsVisible\)/);
});

// The person erased the chat to reopen it from Contacts. The other phone often still holds
// the room (it needs two "room gone" answers before dropping one), which made the reopen
// look like a secure reconnection and left it waiting for a manual accept.
test('a stale local room (erased on the server) does not block the automatic accept', async () => {
  const ctx = harness({ rooms:[{ code:'r-a', token:'tok', lastSeq:7, peerPrivateNumber:A }] });
  ctx.apiAnswer = route => route === '/api/poll' ? { roomGone:true } : { ok:true };
  run(ctx, `addContact('${A}', 'Alice'); pendingIncomingConnections = ${JSON.stringify([incoming('req-1', A)])}`);
  await run(ctx, 'maybeAutoAcceptContactRequests()');
  assert.deepEqual(plain(ctx.events.accept), ['req-1']);
  assert.equal(ctx.rooms.has('r-a'), false, 'the stale room is dropped first');
  assert.equal(ctx.events.sent.filter(([route]) => route === '/api/poll').length, 2, 'asked twice before trusting "gone"');
});

test('one "gone" answer is not enough, and any error counts as not gone', async () => {
  const flaky = harness({ rooms:[{ code:'r-a', token:'tok', peerPrivateNumber:A }] });
  let answers = [{ roomGone:true }, { ok:true }];
  flaky.apiAnswer = () => answers.shift();
  run(flaky, `addContact('${A}', 'Alice'); pendingIncomingConnections = ${JSON.stringify([incoming('req-1', A)])}`);
  await run(flaky, 'maybeAutoAcceptContactRequests()');
  assert.equal(flaky.events.accept.length, 0);
  assert.equal(flaky.rooms.has('r-a'), true);

  const failing = harness({ rooms:[{ code:'r-a', token:'tok', peerPrivateNumber:A }] });
  failing.apiAnswer = () => { throw new Error('offline'); };
  run(failing, `addContact('${A}', 'Alice'); pendingIncomingConnections = ${JSON.stringify([incoming('req-1', A)])}`);
  await run(failing, 'maybeAutoAcceptContactRequests()');
  assert.equal(failing.events.accept.length, 0);
  assert.equal(failing.rooms.has('r-a'), true);
});

test('returning to the app refreshes the requests, which also runs the automatic accept', () => {
  assert.match(client, /if \(loadAccountState\(\)\) refreshConnectionRequests\(\)\.catch\(\(\) => \{\}\); \/\/ also runs the contacts auto-accept/);
  assert.match(client, /Chat request sent to \$\{label\}\. It opens by itself when their app is open\./);
});

// After accepting a reopened chat the phone showed the person twice: the new room and the
// old, already-erased one it had not dropped yet.
test('after accepting, an erased old room for the same person is dropped; live rooms and other people are not', async () => {
  const ctx = harness({ rooms:[
    { code:'old', token:'t1', peerPrivateNumber:A },
    { code:'new', token:'t2', peerPrivateNumber:A },
    { code:'other', token:'t3', peerPrivateNumber:B },
    { code:'alive', token:'t4', peerPrivateNumber:A },
  ] });
  ctx.apiAnswer = (route, body) => route === '/api/poll' && body.code === 'old' ? { roomGone:true } : { ok:true };
  await run(ctx, "dropStaleRoomsForPeer(rooms.get('new'))");
  assert.deepEqual([...ctx.rooms.keys()].sort(), ['alive', 'new', 'other']);
});

test('the stale-room cleanup runs only after a successful accept, and never throws into the accept flow', () => {
  assert.match(client, /else toast\('Private conversation created — the requester can now join'\);\s*dropStaleRoomsForPeer\(room\)\.catch\(\(\) => \{\}\);/);
  assert.match(extractFn('dropStaleRoomsForPeer'), /if \(!\(await localRoomIsGone\(other\)\)\) continue;/);
});

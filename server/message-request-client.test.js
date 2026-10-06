'use strict';

// Message requests, client side: the inbox key lifecycle, the encryption of the intro
// messages (they must be readable only with the receiver's private inbox key and must
// match what the server validates), and how requests, accept and the new chat show them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function extractFn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const asyncStart = source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(asyncStart, i + 1);
  }
  throw new Error('unbalanced');
}

const BLOCK = client.slice(client.indexOf('// ── MESSAGE REQUESTS (inbox key + intro messages)'), client.indexOf('async function refreshConnectionRequests()'));
assert.ok(BLOCK.length > 4000, 'message request block present');
const plain = value => JSON.parse(JSON.stringify(value));

function serverValidators() {
  const context = vm.createContext({});
  vm.runInContext(['validB64Url', 'normalizeInboxKey', 'normalizeIntroMessage'].map(name => extractFn(server, name)).join('\n') + '\nconst REQUEST_INTRO_MAX = 3;', context);
  return context;
}

function harness({ state = { accountId:'acc1', sessionToken:'tok', masterKey:'MK' }, answers = {}, safetyBlocks = false } = {}) {
  const storage = new Map();
  const calls = [];
  const slots = [];
  const context = vm.createContext({
    crypto:webcrypto, TextEncoder, TextDecoder, atob, btoa, console, Date, Math, Uint8Array,
    localStorage:{ getItem:key => storage.has(key) ? storage.get(key) : null, setItem:(key, value) => storage.set(key, String(value)) },
    storage, calls, slots,
    loadAccountState:() => state,
    escapeHtml:value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
    api:async (route, body) => { calls.push([route, plain(body)]); const answer = answers[route]; return typeof answer === 'function' ? answer(body) : (answer || { ok:true }); },
    aesDecryptJson:async (key, envelope) => envelope,
    syncAnonymousAccount:async () => { calls.push(['sync']); },
    pendingIncomingConnections:[],
    document:{ querySelectorAll:selector => selector === '[data-request-intro]' ? slots : [] },
    window:{ VaultlixContentSafety:{ check:text => ({ blocked:safetyBlocks && /bad/.test(text) }) } },
    formatMsgTime:() => '10:00', isRoomVisible:() => true, renderMessageRecord:() => {},
    encryptTextMsg:async (room, text) => `enc:${text}`,
    setTimeout, clearTimeout,
  });
  context.plain = plain;
  vm.runInContext([extractFn(client, 'bytesToBase64'), extractFn(client, 'base64UrlToBytes'), extractFn(client, 'bytesToBase64UrlCompact'), extractFn(client, 'cleanContactText')].join('\n'), context);
  vm.runInContext(BLOCK, context);
  return context;
}

const run = (ctx, code) => vm.runInContext(code, ctx);

test('an intro message round-trips with the receiver\'s inbox key and fits the server\'s validation', async () => {
  const ctx = harness();
  const record = await run(ctx, 'generateInboxKeyRecord()');
  assert.equal(run(ctx, 'validInboxKeyRecord').call(null, plain(record)), true);
  const { normalizeIntroMessage, normalizeInboxKey } = serverValidators();
  assert.ok(normalizeInboxKey(plain(record.pubJwk)), 'the public key has the shape the server stores');
  ctx.recipient = plain(record.pubJwk);
  ctx.priv = plain(record.privJwk);
  for (const text of ['Hi', 'It\'s me from the café — remember? 😀', 'x'.repeat(300)]) {
    ctx.text = text;
    const message = plain(await run(ctx, 'encryptIntroMessage(recipient, text)'));
    assert.ok(normalizeIntroMessage(message), `server accepts the shape for "${text.slice(0, 12)}…"`);
    ctx.message = message;
    assert.equal(await run(ctx, 'decryptIntroMessage(priv, message)'), text);
  }
});

test('only the right private key opens a message, tampering is detected, and each message is unique', async () => {
  const ctx = harness();
  const owner = await run(ctx, 'generateInboxKeyRecord()');
  const stranger = await run(ctx, 'generateInboxKeyRecord()');
  ctx.recipient = plain(owner.pubJwk);
  ctx.ownerPriv = plain(owner.privJwk);
  ctx.strangerPriv = plain(stranger.privJwk);
  ctx.message = plain(await run(ctx, "encryptIntroMessage(recipient, 'secret hello')"));
  await assert.rejects(run(ctx, 'decryptIntroMessage(strangerPriv, message)'));
  ctx.tampered = { ...ctx.message, ct:ctx.message.ct.slice(0, -2) + (ctx.message.ct.endsWith('AA') ? 'BB' : 'AA') };
  await assert.rejects(run(ctx, 'decryptIntroMessage(ownerPriv, tampered)'));
  ctx.second = plain(await run(ctx, "encryptIntroMessage(recipient, 'secret hello')"));
  assert.notEqual(ctx.second.ct, ctx.message.ct);
  assert.notEqual(ctx.second.iv, ctx.message.iv);
  assert.notDeepEqual(ctx.second.epk, ctx.message.epk, 'a fresh ephemeral key every time');
  assert.doesNotMatch(JSON.stringify(ctx.message), /secret hello/);
});

test('text longer than the limit is cut before it is encrypted', async () => {
  const ctx = harness();
  const key = await run(ctx, 'generateInboxKeyRecord()');
  ctx.recipient = plain(key.pubJwk); ctx.priv = plain(key.privJwk);
  ctx.message = plain(await run(ctx, "encryptIntroMessage(recipient, 'y'.repeat(900))"));
  assert.equal((await run(ctx, 'decryptIntroMessage(priv, message)')).length, 300);
});

function freshKeyAnswers() { return {}; }

test('a new account creates an inbox key, publishes it, saves the private half, and syncs the bundle', async () => {
  const ctx = harness({ answers:{ '/api/account/inbox-key': body => body.publicKey ? { ok:true, accepted:true, inboxKey:body.publicKey } : { ok:true, inboxKey:null } } });
  const record = await run(ctx, 'ensureInboxKey()');
  assert.ok(record && record.privJwk.d);
  const stored = JSON.parse(ctx.storage.get('vaultlix_inbox_key:acc1'));
  assert.equal(stored.privJwk.d, record.privJwk.d);
  const publish = ctx.calls.find(([route, body]) => route === '/api/account/inbox-key' && body.publicKey);
  assert.deepEqual(plain(publish[1].publicKey), plain(record.pubJwk));
  assert.equal(publish[1].replace, false, 'nothing to replace on a new account');
  assert.ok(ctx.calls.some(([route]) => route === 'sync'), 'the bundle now carries the private half');
});

test('when this device already holds the published key nothing is sent again', async () => {
  const first = harness({ answers:{ '/api/account/inbox-key': body => body.publicKey ? { ok:true, accepted:true, inboxKey:body.publicKey } : { ok:true, inboxKey:null } } });
  const record = await run(first, 'ensureInboxKey()');
  const second = harness({ answers:{ '/api/account/inbox-key': () => ({ ok:true, inboxKey:plain(record.pubJwk) }) } });
  second.storage.set('vaultlix_inbox_key:acc1', JSON.stringify(plain(record)));
  assert.ok(await run(second, 'ensureInboxKey()'));
  assert.equal(second.calls.filter(([route, body]) => body && body.publicKey).length, 0);
  await run(second, 'ensureInboxKey()');
  assert.equal(second.calls.filter(([route]) => route === '/api/account/inbox-key').length, 1, 'remembered for the session');
});

test('a second device adopts the published key from the encrypted bundle instead of replacing it', async () => {
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  const device = harness({ answers:{
    '/api/account/inbox-key': () => ({ ok:true, inboxKey:record.pubJwk }),
    '/api/account/fetch': () => ({ ok:true, bundle:{ v:1, inbox:record } }),
  } });
  const adopted = await run(device, 'ensureInboxKey()');
  assert.equal(adopted.privJwk.d, record.privJwk.d);
  assert.equal(device.calls.filter(([route, body]) => route === '/api/account/inbox-key' && body && body.publicKey).length, 0, 'nothing replaced');
});

test('a device that cannot recover the matching private half replaces the published key', async () => {
  const origin = harness();
  const other = plain(await run(origin, 'generateInboxKeyRecord()'));
  const device = harness({ answers:{
    '/api/account/inbox-key': body => body.publicKey ? { ok:true, accepted:true, inboxKey:body.publicKey } : { ok:true, inboxKey:other.pubJwk },
    '/api/account/fetch': () => ({ ok:true, bundle:{ v:1 } }),
  } });
  const record = await run(device, 'ensureInboxKey()');
  const publish = device.calls.find(([route, body]) => route === '/api/account/inbox-key' && body.publicKey);
  assert.equal(publish[1].replace, true);
  assert.notEqual(record.pubJwk.x, other.pubJwk.x);
});

test('inbox key set-up never throws into the caller and shares one run', async () => {
  const failing = harness({ answers:{ '/api/account/inbox-key': () => { throw new Error('offline'); } } });
  assert.equal(await run(failing, 'ensureInboxKey()'), null);
  const rejected = harness({ answers:{ '/api/account/inbox-key': body => body.publicKey ? { ok:true, accepted:false } : { ok:true, inboxKey:null } } });
  assert.equal(await run(rejected, 'ensureInboxKey()'), null);
  const none = harness({ state:null });
  assert.equal(await run(none, 'ensureInboxKey()'), null);
  const shared = harness({ answers:{ '/api/account/inbox-key': body => body.publicKey ? { ok:true, accepted:true, inboxKey:body.publicKey } : { ok:true, inboxKey:null } } });
  const [a, b] = await Promise.all([run(shared, 'ensureInboxKey()'), run(shared, 'ensureInboxKey()')]);
  assert.equal(a.pubJwk.x, b.pubJwk.x);
  assert.equal(shared.calls.filter(([route, body]) => body && body.publicKey).length, 1);
});

test('the private half is stored per account and a damaged record is ignored', async () => {
  const ctx = harness();
  assert.equal(run(ctx, 'inboxKeyStorageKey({ accountId:"abc" })'), 'vaultlix_inbox_key:abc');
  assert.equal(run(ctx, 'loadLocalInboxKey()'), null);
  ctx.storage.set('vaultlix_inbox_key:acc1', '{"pubJwk":{"x":"short"}}');
  assert.equal(run(ctx, 'loadLocalInboxKey()'), null);
  ctx.storage.set('vaultlix_inbox_key:acc1', 'not json');
  assert.equal(run(ctx, 'loadLocalInboxKey()'), null);
});

test('the bundle carries the inbox key and a restored bundle only fills a missing local key', () => {
  assert.match(client, /const inbox = accountId && accountId === loadAccountState\(\)\?\.accountId \? loadLocalInboxKey\(\) : null;/);
  assert.match(client, /groups, \.\.\.\(inbox \? \{ inbox \} : \{\}\), achievements:/);
  assert.match(client, /if \(validInboxKeyRecord\(bundle\.inbox\) && !loadLocalInboxKey\(\{ accountId \}\)\) saveLocalInboxKey\(bundle\.inbox, \{ accountId \}\);/);
});

test('sending: no text means no message, blocked text is refused, an unsupported recipient falls back', async () => {
  const ctx = harness({ safetyBlocks:true, answers:{ '/api/connections/prepare': () => ({ ok:true, inboxKey:null, introMax:3 }) } });
  assert.deepEqual(plain(await run(ctx, "prepareRequestIntro('2345678901', '   ')")), { intro:null });
  assert.equal(ctx.calls.length, 0, 'no network call for an empty message');
  assert.match((await run(ctx, "prepareRequestIntro('2345678901', 'bad words')")).error, /cannot be shared/);
  assert.deepEqual(plain(await run(ctx, "prepareRequestIntro('2345678901', 'hello')")), { intro:null, unsupported:true });
  const refused = harness({ answers:{ '/api/connections/prepare': () => ({ error:'This person cannot be contacted.' }) } });
  assert.equal((await run(refused, "prepareRequestIntro('2345678901', 'hello')")).error, 'This person cannot be contacted.');
  const signedOut = harness({ state:null });
  assert.match((await run(signedOut, "prepareRequestIntro('2345678901', 'hello')")).error, /Sign in/);
});

test('sending: the message is encrypted to the recipient\'s published key', async () => {
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  const ctx = harness({ answers:{ '/api/connections/prepare': () => ({ ok:true, inboxKey:record.pubJwk, introMax:3 }) } });
  const prepared = plain(await run(ctx, "prepareRequestIntro('2345678901', '  hello there  ')"));
  assert.ok(prepared.intro.epk && prepared.intro.iv && prepared.intro.ct);
  origin.priv = record.privJwk; origin.message = prepared.intro;
  assert.equal(await run(origin, 'decryptIntroMessage(priv, message)'), 'hello there', 'trimmed, and readable only with the recipient\'s key');
  assert.deepEqual(ctx.calls.map(([route]) => route), ['/api/connections/prepare']);
  assert.doesNotMatch(JSON.stringify(ctx.calls), /hello there/, 'plaintext never leaves the device');
});

test('a request card shows the decrypted messages, and unreadable or filtered ones safely', async () => {
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  const sender = harness();
  sender.recipient = record.pubJwk;
  const good = plain(await run(sender, "encryptIntroMessage(recipient, 'Hello <b>there</b>')"));
  const bad = plain(await run(sender, "encryptIntroMessage(recipient, 'bad words here')"));
  const other = plain(await run(origin, 'generateInboxKeyRecord()'));
  sender.recipient = other.pubJwk;
  const foreign = plain(await run(sender, "encryptIntroMessage(recipient, 'meant for someone else')"));
  const ctx = harness({ safetyBlocks:true });
  ctx.storage.set('vaultlix_inbox_key:acc1', JSON.stringify(record));
  const slot = { dataset:{ requestIntro:'r1' }, isConnected:true, innerHTML:'' };
  ctx.slots.push(slot);
  ctx.pendingIncomingConnections.push({ id:'r1', intro:[good, bad, foreign] });
  await run(ctx, 'hydrateRequestIntros()');
  assert.match(slot.innerHTML, /Hello &lt;b&gt;there&lt;\/b&gt;/, 'text is escaped');
  assert.doesNotMatch(slot.innerHTML, /<b>/);
  assert.match(slot.innerHTML, /Hidden by the safety filter/);
  assert.match(slot.innerHTML, /Message unavailable/);
  assert.equal(run(ctx, 'introTextCache.has("r1")'), true);
});

test('without the private key the messages are unavailable and are not cached as unreadable', async () => {
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  origin.recipient = record.pubJwk;
  const message = plain(await run(origin, "encryptIntroMessage(recipient, 'hi')"));
  const ctx = harness();
  ctx.request = { id:'r2', intro:[message] };
  assert.deepEqual(plain(await run(ctx, 'decryptRequestIntros(request)')), [null]);
  assert.equal(run(ctx, 'introTextCache.has("r2")'), false, 'retried once the key arrives');
});

test('a request with no messages has no slot; one with messages has one', () => {
  const ctx = harness();
  assert.equal(run(ctx, 'requestIntroSlot({ id:"x", intro:[] })'), '');
  assert.equal(run(ctx, 'requestIntroSlot({ id:"x" })'), '');
  assert.match(run(ctx, 'requestIntroSlot({ id:"x", intro:[{}] })'), /data-request-intro="x"/);
});

test('the accepter sees what was said as notices, sent into the chat once the key exists', async () => {
  const ctx = harness();
  const room = { code:'r', token:'t', messages:[], seenMsgIds:new Set(), sharedKey:null };
  ctx.room = room;
  run(ctx, "queueIntroNotices(room, { name:'Mrmask', texts:['Hello', 'Are you there?', 'Third', 'Fourth'] })");
  assert.equal(room.messages.length, 3, 'three at most');
  const skipped = { code:'r2', token:'t', messages:[], seenMsgIds:new Set(), sharedKey:null };
  ctx.skipped = skipped;
  run(ctx, "queueIntroNotices(skipped, { name:'Mrmask', texts:['One', null, 'Two'] })");
  assert.equal(skipped.messages.length, 2, 'unreadable ones are skipped');
  assert.match(room.messages[0].content, /^Mrmask said: “Hello” · /);
  assert.ok(room.messages.every(rec => rec.kind === 'sys' && rec.contactEvent === true));
  await run(ctx, 'flushIntroNotices(room)');
  assert.equal(ctx.calls.length, 0, 'nothing is sent before the shared key exists');
  room.sharedKey = {};
  await run(ctx, 'flushIntroNotices(room)');
  const sends = ctx.calls.filter(([route]) => route === '/api/send');
  assert.equal(sends.length, 3);
  assert.equal(sends[0][1].msgId, room.messages[0].id);
  assert.equal(sends[0][1].suppressNotification, true);
  assert.match(sends[0][1].content, /"contactEvent":"intro"/);
  assert.equal(room.pendingIntroNotices.length, 0);
});

test('a notice that fails to send is kept for the next poll', async () => {
  const ctx = harness({ answers:{ '/api/send': () => { throw new Error('offline'); } } });
  const room = { code:'r', token:'t', messages:[], seenMsgIds:new Set(), sharedKey:{} };
  ctx.room = room;
  run(ctx, "queueIntroNotices(room, { name:'Mrmask', texts:['Hello'] })");
  await run(ctx, 'flushIntroNotices(room)');
  assert.equal(room.pendingIntroNotices.length, 1);
});

test('the receiving side shows an intro notice only to the person who accepted', () => {
  const start = client.indexOf("if (parsed.contactEvent === 'intro') {");
  const branch = client.slice(start, client.indexOf("if (parsed.contactEvent === 'reopened') {", start));
  assert.match(branch, /if \(!fromMe\) return null;/);
  assert.match(branch, /content:`\$\{actor\} said: “\$\{said\}” · \$\{time\}`/);
  assert.match(branch, /slice\(0, INTRO_MAX_CHARS\)/);
});

test('accepting captures the messages and the new chat queues them; polling flushes them', () => {
  assert.match(extractFn(client, 'acceptConnectionRequest'), /pendingIntroNotice = \{ requestId, name:peer\.displayName \|\| formatPrivateNumber\(peer\.privateNumber\), texts:\(await decryptRequestIntros\(request\)\)\.filter\(Boolean\) \};/);
  assert.match(client, /if \(mode === 'connection' && pendingIntroNotice && pendingIntroNotice\.requestId === pendingConnectionAcceptance\) \{\s*queueIntroNotices\(room, pendingIntroNotice\);\s*pendingIntroNotice = null;/);
  assert.match(client, /if \(room\.pendingIntroNotices\?\.length && room\.sharedKey\) flushIntroNotices\(room\)\.catch\(\(\) => \{\}\);/);
});

test('both ways of sending a request ask for the optional message first, then encrypt it', () => {
  const contact = extractFn(client, 'openContactChat');
  assert.match(contact, /const target = await fetchRequestTarget\(normalized\);\s*if \(target\.error\) \{ toast\(target\.error\); return; \}\s*const introText = await promptRequestMessage\(label, \{ supported:!!target\.inboxKey \}\);\s*if \(introText === null\) return;\s*const prepared = await prepareRequestIntro\(normalized, introText, target\);/);
  assert.match(contact, /replaceExisting:true, \.\.\.\(prepared\.intro \? \{ intro:prepared\.intro \} : \{\}\)/);
  const profile = extractFn(client, 'requestPrivateVault');
  assert.match(profile, /const target = await fetchRequestTarget\(activePublicProfile\.privateNumber\);\s*if \(target\.error\) \{ toast\(target\.error\); return; \}\s*const introText = await promptRequestMessage\([^;]*\{ supported:!!target\.inboxKey \}\);\s*if \(introText === null\) return;/);
  assert.match(profile, /\.\.\.\(prepared\.intro \? \{ intro:prepared\.intro \} : \{\}\)/);
  assert.match(profile, /replaceExisting:true,\s*\.\.\.\(prepared\.intro \? \{ intro:prepared\.intro \} : \{\}\)/);
});

test('the dialog is optional: send, send without a message, or cancel', () => {
  const dialog = extractFn(client, 'promptRequestMessage');
  assert.match(dialog, /data-choice="send">Send request/);
  assert.match(dialog, /data-choice="plain">Send without a message/);
  assert.match(dialog, /data-choice="">Cancel/);
  assert.match(dialog, /maxlength="\$\{INTRO_MAX_CHARS\}"/);
});

test('request cards in the chat list and the account panel carry a slot, filled after rendering', () => {
  assert.match(client, /\$\{requestIntroSlot\(request\)\}<div class="vault-list-request-actions">/);
  assert.match(client, /\$\{requestIntroSlot\(r\)\}<button class="account-primary"/);
  assert.match(client, /body\.innerHTML = html;\s*hydrateRequestIntros\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(client, /list\.innerHTML = `\$\{incomingHtml\}\$\{outgoingHtml\}`;\s*hydrateRequestIntros\(\)\.catch\(\(\) => \{\}\);/);
});

test('the inbox key is ensured whenever requests are refreshed', () => {
  assert.match(extractFn(client, 'refreshConnectionRequests'), /ensureInboxKey\(\)\.catch\(\(\) => \{\}\);\s*await reconcileConversationPeerIdentities/);
});

// Video report: tapping "Connect privately" seemed to do nothing. The message dialog opened
// BEHIND the Quick Connect panel (z-index 12000), so only the panel was visible, and the
// message the person then typed (after closing the panel) went to someone whose app had
// not published an inbox key, so only a plain request arrived.
test('the message dialog sits above the Quick Connect panel instead of hiding behind it', () => {
  const panelZ = Number(/\.account-overlay\{position:fixed;inset:0;z-index:(\d+)/.exec(client)[1]);
  const dialogZ = Number(/#request-message-overlay\{z-index:(\d+)\}/.exec(client)[1]);
  assert.ok(dialogZ > panelZ, `dialog z-index ${dialogZ} must exceed the panel's ${panelZ}`);
});

test('whether the person can receive a message is checked before the dialog, and the dialog says so when they cannot', async () => {
  const none = harness({ answers:{ '/api/connections/prepare': () => ({ ok:true, inboxKey:null, introMax:3 }) } });
  assert.deepEqual(plain(await run(none, "fetchRequestTarget('2345678901')")), { inboxKey:null });
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  const some = harness({ answers:{ '/api/connections/prepare': () => ({ ok:true, inboxKey:record.pubJwk, introMax:3 }) } });
  assert.deepEqual(plain(await run(some, "fetchRequestTarget('2345678901')")), { inboxKey:record.pubJwk });
  const refused = harness({ answers:{ '/api/connections/prepare': () => ({ error:'This person cannot be contacted.' }) } });
  assert.equal((await run(refused, "fetchRequestTarget('2345678901')")).error, 'This person cannot be contacted.');
  assert.equal((await run(harness({ state:null }), "fetchRequestTarget('2345678901')")).error, 'Sign in to send a request.');
  const dialog = extractFn(client, 'promptRequestMessage');
  assert.match(dialog, /function promptRequestMessage\(label, \{ supported = true, remaining = 0 \} = \{\}\)/);
  assert.match(dialog, /has not opened the latest Vaultlix yet, so a message cannot go with the request/);
  const unsupportedPart = dialog.slice(dialog.indexOf('has not opened the latest'));
  assert.doesNotMatch(unsupportedPart.slice(0, unsupportedPart.indexOf('</div>`')), /request-message-input/, 'no text box when a message cannot be sent');
});

test('a prefetched target is reused, so the lookup happens once per request', async () => {
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  const ctx = harness();
  ctx.target = { inboxKey:record.pubJwk };
  const prepared = plain(await run(ctx, "prepareRequestIntro('2345678901', 'hello', target)"));
  assert.ok(prepared.intro.ct);
  assert.equal(ctx.calls.length, 0, 'no second network call');
  ctx.noKey = { inboxKey:null };
  assert.deepEqual(plain(await run(ctx, "prepareRequestIntro('2345678901', 'hello', noKey)")), { intro:null, unsupported:true });
});

// ── Phase 3: follow-up messages, the privacy choice, and the profile code ──────────────

function phase3Harness({ pending = [], answers = {}, prompts = [], state = { accountId:'acc1', sessionToken:'tok', masterKey:'MK' } } = {}) {
  const ctx = harness({ answers, state });
  ctx.pendingOutgoingConnections = pending;
  ctx.toasts = [];
  ctx.toast = message => ctx.toasts.push(message);
  ctx.renderCount = 0;
  ctx.renderVaultList = () => { ctx.renderCount++; };
  ctx.refreshConnectionRequests = async () => { ctx.calls.push(['refresh']); };
  ctx.normalizePrivateNumber = value => String(value || '').replace(/\D/g, '');
  ctx.formatPrivateNumber = value => `fmt-${value}`;
  ctx.promptQueue = prompts;
  ctx.promptRequestMessage = async (label, options) => { ctx.promptArgs = [label, options]; return ctx.promptQueue.shift(); };
  return ctx;
}

test('an outgoing request shows how many messages were sent and offers another until three', () => {
  const ctx = phase3Harness();
  assert.match(run(ctx, 'outgoingIntroHtml({ id:"q1", introCount:0 })'), /Add a message/);
  assert.doesNotMatch(run(ctx, 'outgoingIntroHtml({ id:"q1", introCount:0 })'), /messages sent/);
  const one = run(ctx, 'outgoingIntroHtml({ id:"q1", introCount:1 })');
  assert.match(one, /1 of 3 messages sent/);
  assert.match(one, /Send another message/);
  assert.match(one, /sendRequestFollowUp\('q1'\)/);
  const full = run(ctx, 'outgoingIntroHtml({ id:"q1", introCount:3 })');
  assert.match(full, /3 of 3 messages sent/);
  assert.match(full, /Waiting for a reply/);
  assert.doesNotMatch(full, /sendRequestFollowUp/, 'no button once the limit is reached');
});

test('a follow-up message is encrypted to the recipient and added to the same request', async () => {
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  const request = { id:'q1', recipientPrivateNumber:'3456789012', recipientDisplayName:'Bob', introCount:1 };
  const ctx = phase3Harness({
    pending:[request], prompts:['Are you there?'],
    answers:{
      '/api/connections/prepare': () => ({ ok:true, inboxKey:record.pubJwk, introMax:3 }),
      '/api/connections/request': () => ({ ok:true, requestId:'q1', status:'pending', introCount:2 }),
    },
  });
  await run(ctx, "sendRequestFollowUp('q1')");
  assert.deepEqual(plain(ctx.promptArgs[1]), { supported:true, remaining:2 });
  const sent = ctx.calls.find(([route]) => route === '/api/connections/request');
  assert.equal(sent[1].privateNumber, '3456789012');
  assert.ok(sent[1].intro.ct);
  assert.doesNotMatch(JSON.stringify(ctx.calls), /Are you there/, 'plaintext never leaves the device');
  assert.equal(request.introCount, 2);
  assert.ok(ctx.renderCount >= 1);
  assert.deepEqual(ctx.toasts, ['Message sent']);
  origin.priv = record.privJwk; origin.message = sent[1].intro;
  assert.equal(await run(origin, 'decryptIntroMessage(priv, message)'), 'Are you there?');
});

test('the third follow-up says the sender is now waiting; a fourth never reaches the dialog', async () => {
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  const request = { id:'q1', recipientPrivateNumber:'3456789012', recipientDisplayName:'Bob', introCount:2 };
  const ctx = phase3Harness({ pending:[request], prompts:['Last one'], answers:{
    '/api/connections/prepare': () => ({ ok:true, inboxKey:record.pubJwk }),
    '/api/connections/request': () => ({ ok:true, status:'pending', introCount:3 }),
  } });
  await run(ctx, "sendRequestFollowUp('q1')");
  assert.deepEqual(ctx.toasts, ['Message sent. Now waiting for a reply.']);
  const callsBefore = ctx.calls.length;
  await run(ctx, "sendRequestFollowUp('q1')");
  assert.equal(ctx.calls.length, callsBefore, 'no network call at three');
  assert.match(ctx.toasts.at(-1), /3 messages until they reply/);
});

test('follow-up: cancelling or an empty message sends nothing; a server refusal is shown', async () => {
  const origin = harness();
  const record = plain(await run(origin, 'generateInboxKeyRecord()'));
  const base = { '/api/connections/prepare': () => ({ ok:true, inboxKey:record.pubJwk }) };
  for (const answer of [null, '', '   ']) {
    const request = { id:'q1', recipientPrivateNumber:'3456789012', introCount:0 };
    const ctx = phase3Harness({ pending:[request], prompts:[answer], answers:base });
    await run(ctx, "sendRequestFollowUp('q1')");
    assert.equal(ctx.calls.filter(([route]) => route === '/api/connections/request').length, 0, JSON.stringify(answer));
    assert.equal(request.introCount, 0);
  }
  const refused = { id:'q1', recipientPrivateNumber:'3456789012', introCount:1 };
  const ctx = phase3Harness({ pending:[refused], prompts:['hello'], answers:{ ...base, '/api/connections/request': () => ({ error:'You can send 3 messages until they reply.' }) } });
  await run(ctx, "sendRequestFollowUp('q1')");
  assert.deepEqual(ctx.toasts, ['You can send 3 messages until they reply.']);
  assert.equal(refused.introCount, 1, 'the count is unchanged');
});

test('follow-up: a recipient without an inbox key cannot receive messages, and a refused lookup is shown', async () => {
  const request = { id:'q1', recipientPrivateNumber:'3456789012', recipientDisplayName:'Bob', introCount:0 };
  const none = phase3Harness({ pending:[request], prompts:['x'], answers:{ '/api/connections/prepare': () => ({ ok:true, inboxKey:null }) } });
  await run(none, "sendRequestFollowUp('q1')");
  assert.match(none.toasts[0], /Bob has not opened the latest Vaultlix yet/);
  assert.equal(none.promptArgs, undefined, 'the dialog is not shown');
  const refused = phase3Harness({ pending:[request], answers:{ '/api/connections/prepare': () => ({ error:'This person cannot be contacted.' }) } });
  await run(refused, "sendRequestFollowUp('q1')");
  assert.deepEqual(refused.toasts, ['This person cannot be contacted.']);
});

test('the follow-up dialog shows how many are left and has no "send without a message" choice', () => {
  const dialog = extractFn(client, 'promptRequestMessage');
  assert.match(dialog, /supported && remaining/);
  assert.match(dialog, /\$\{remaining\} of \$\{INTRO_MAX_MESSAGES\} left until/);
  const followUp = dialog.slice(dialog.indexOf('supported && remaining'), dialog.indexOf(': supported'));
  assert.match(followUp, /data-choice="send">Send message/);
  assert.doesNotMatch(followUp, /Send without a message/);
});

test('the outgoing card on the Chats list carries the count and the add button', () => {
  assert.match(client, /Connection request sent · awaiting acceptance<\/div>\$\{outgoingIntroHtml\(request\)\}<\/div>/);
});

test('the privacy choice is cached per account, defaults to anyone, and lists three options', () => {
  const ctx = phase3Harness();
  assert.equal(run(ctx, 'cachedRequestPolicy()'), 'anyone');
  ctx.storage.set('vaultlix_request_policy:acc1', 'none');
  assert.equal(run(ctx, 'cachedRequestPolicy()'), 'none');
  ctx.storage.set('vaultlix_request_policy:acc1', 'qr');
  assert.equal(run(ctx, 'cachedRequestPolicy()'), 'anyone', 'the removed QR-only choice reads as anyone');
  ctx.storage.set('vaultlix_request_policy:acc1', 'bogus');
  assert.equal(run(ctx, 'cachedRequestPolicy()'), 'anyone');
  assert.deepEqual(plain(run(ctx, 'Object.keys(REQUEST_POLICY_LABELS)')), ['anyone', 'none']);
  assert.equal(run(ctx, 'REQUEST_POLICY_LABELS.anyone'), 'Anyone with my number');
  assert.equal(run(ctx, 'REQUEST_POLICY_LABELS.none'), 'No one for now');
});

test('the Settings row sits in Privacy & Security and the status refreshes when Settings opens', () => {
  assert.match(client, /id="settings-request-policy-row" onclick="openRequestPolicySheet\(\)"/);
  assert.match(client, /privacy:\['settings-app-lock-row','settings-request-policy-row','settings-hidden-chats-row','settings-locker-row'\]/);
  assert.match(extractFn(client, 'loadSettingsState'), /refreshRequestPolicyStatus\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(extractFn(client, 'openRequestPolicySheet'), /api\('\/api\/account\/request-policy', \{ accountId:state\.accountId, sessionToken:state\.sessionToken, policy \}\)/);
});

test('no QR-only setting or profile code is sent or kept on the client any more', () => {
  assert.doesNotMatch(client, /requestShareCode/);
  assert.doesNotMatch(extractFn(client, 'fetchRequestTarget'), /shareCode/);
  assert.doesNotMatch(extractFn(client, 'requestPrivateVault'), /shareCode/);
  assert.doesNotMatch(client, /QR code or link only/);
});

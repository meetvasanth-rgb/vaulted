'use strict';

// Message requests (received, with their messages, and sent) live on their own Requests
// page. The Chats list only shows real chats, plus one row that opens the page.

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

const escapeHtml = value => String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function harness({ incoming = [], outgoing = [], pageActive = false, state = { accountId:'a' }, hidden = false } = {}) {
  const nodes = new Map([['requests-body', { innerHTML:'' }]]);
  const storage = new Map();
  const context = vm.createContext({
    pendingIncomingConnections:incoming, pendingOutgoingConnections:outgoing, pendingConnectionFocusId:null,
    escapeHtml, escHtml:escapeHtml, i18n:key => ({ connection_request_text:'Wants to start a private conversation', accept:'Accept', decline:'Decline' }[key] || key),
    connectionRequestAvatarCard:() => '<span class="avatar"></span>', requestIntroSlot:request => request.intro ? `<div data-request-intro="${request.id}"></div>` : '',
    outgoingIntroHtml:() => '<div class="outgoing-meta"></div>', formatPrivateNumber:value => `fmt-${value}`,
    hydrateRequestIntros:async () => { context.hydrated = (context.hydrated || 0) + 1; }, scrollToFocusedConnectionRequest:() => { context.scrolled = true; },
    localStorage:{ getItem:key => storage.has(key) ? storage.get(key) : null, setItem:(key, value) => storage.set(key, String(value)) }, storage,
    updateVaultNavigationBadges:() => { context.badgesUpdated = (context.badgesUpdated || 0) + 1; },
    document:{ hidden, getElementById:id => id === 's-requests' ? { classList:{ contains:name => name === 'active' && pageActive } } : nodes.get(id) || null },
    loadAccountState:() => state, openAccountPanel:() => { context.panel = true; }, showScreen:id => { context.screen = id; }, nodes,
  });
  vm.runInContext("const REQUESTS_SEEN_KEY_PREFIX = 'vaultlix_requests_seen:';\n" + ['requestsSeenKey', 'readRequestsSeen', 'requestMessageCount', 'unseenIncomingRequests', 'unseenIncomingRequestCount', 'markRequestsSeen',
    'incomingRequestCardHtml', 'outgoingRequestCardHtml', 'requestsRowHtml', 'openRequests', 'closeRequests', 'renderRequestsPageIfOpen', 'renderRequestsPage'].map(extractFn).join('\n'), context);
  return context;
}

const incoming = (id, name = 'Mrmask') => ({ id, senderDisplayName:name, senderPrivateNumber:'9710698547' });
const outgoing = (id, name = 'Sam') => ({ id, recipientDisplayName:name, recipientPrivateNumber:'7796515353' });
const run = (ctx, code) => vm.runInContext(code, ctx);

test('the Chats list has no row when there are no requests', () => {
  assert.equal(run(harness(), 'requestsRowHtml()'), '');
});

test('received requests show one row with the count and the first names', () => {
  const html = run(harness({ incoming:[incoming('a', 'Mrmask'), incoming('b', 'Sam'), incoming('c', 'Third')] }), 'requestsRowHtml()');
  assert.match(html, /onclick="openRequests\(\)"/);
  assert.match(html, /<strong>Message requests<\/strong>/);
  assert.match(html, /3 new · Mrmask, Sam/);
  assert.match(html, /<span class="vault-requests-badge">3<\/span>/);
  assert.doesNotMatch(html, /Third/, 'only the first two names');
});

test('only sent requests show a quieter row with no badge', () => {
  const html = run(harness({ outgoing:[outgoing('o1'), outgoing('o2')] }), 'requestsRowHtml()');
  assert.match(html, /2 sent · waiting for a reply/);
  assert.doesNotMatch(html, /vault-requests-badge/);
});

test('received and sent requests share the row, names are escaped, and large counts cap', () => {
  const mixed = run(harness({ incoming:[incoming('a', '<b>x</b>')], outgoing:[outgoing('o1')] }), 'requestsRowHtml()');
  assert.match(mixed, /1 new · &lt;b&gt;x&lt;\/b&gt; · 1 sent/);
  const many = run(harness({ incoming:Array.from({ length:120 }, (_, i) => incoming(`i${i}`)) }), 'requestsRowHtml()');
  assert.match(many, /vault-requests-badge">99\+</);
});

test('the Requests page lists Received and Sent sections with the same cards as before', () => {
  const ctx = harness({ incoming:[{ ...incoming('a'), intro:[{}] }], outgoing:[outgoing('o1')] });
  run(ctx, 'renderRequestsPage()');
  const html = ctx.nodes.get('requests-body').innerHTML;
  assert.match(html, /Received<\/div>/);
  assert.match(html, /Sent<\/div>/);
  assert.match(html, /data-connection-request-id="a"/);
  assert.match(html, /acceptConnectionRequest\('a'\)/);
  assert.match(html, /rejectConnectionRequest\('a'\)/);
  assert.match(html, /data-request-intro="a"/, 'the message slot is on the page');
  assert.match(html, /Connection request sent · awaiting acceptance/);
  assert.match(html, /outgoing-meta/, 'the sent card keeps its message count and add button');
  assert.equal(ctx.hydrated, 1, 'messages are decrypted after rendering');
  assert.equal(ctx.scrolled, true);
});

test('an empty Requests page explains itself', () => {
  const ctx = harness();
  run(ctx, 'renderRequestsPage()');
  assert.match(ctx.nodes.get('requests-body').innerHTML, /No requests/);
});

test('only an open page is redrawn when requests change', () => {
  const closed = harness({ incoming:[incoming('a')], pageActive:false });
  run(closed, 'renderRequestsPageIfOpen()');
  assert.equal(closed.nodes.get('requests-body').innerHTML, '');
  const open = harness({ incoming:[incoming('a')], pageActive:true });
  run(open, 'renderRequestsPageIfOpen()');
  assert.match(open.nodes.get('requests-body').innerHTML, /data-connection-request-id="a"/);
});

test('opening needs an account, and closing returns to Chats and forgets the focused request', () => {
  const signedOut = harness({ state:null });
  run(signedOut, 'openRequests()');
  assert.equal(signedOut.panel, true);
  assert.equal(signedOut.screen, undefined);
  const ctx = harness();
  run(ctx, 'openRequests()');
  assert.equal(ctx.screen, 's-requests');
  run(ctx, "pendingConnectionFocusId = 'x'; closeRequests()");
  assert.equal(ctx.screen, 's-vault-list');
  assert.equal(run(ctx, 'pendingConnectionFocusId'), null);
});

test('the chat list renders only the row, not the cards, and stays in step with an open page', () => {
  const list = extractFn('renderVaultList');
  assert.match(list, /let html = searchQuery \? '' : requestsRowHtml\(\);/);
  assert.doesNotMatch(list, /vault-list-request/);
  assert.match(list, /if \(!body\) return;\s*renderRequestsPageIfOpen\(\);/);
});

test('notification taps and "request waiting" navigation open the Requests page with that request in view', () => {
  const open = extractFn('openConnectionRequest');
  assert.match(open, /showScreen\('s-requests'\);\s*renderRequestsPage\(\);\s*await refreshConnectionRequests\(\);\s*scrollToFocusedConnectionRequest\(\);/);
  assert.doesNotMatch(open, /showScreen\('s-vault-list'\)/);
  assert.match(extractFn('refreshConnectionRequests'), /renderRequestsPageIfOpen\(\);/);
});

test('the page exists with a back button and a body, and a request count rides on the Chats badge', () => {
  assert.match(client, /<div id="s-requests" class="screen">/);
  assert.match(client, /onclick="closeRequests\(\)" aria-label="Back"/);
  assert.match(client, /<div class="contacts-body" id="requests-body"><\/div>/);
  assert.match(extractFn('vaultNavigationCounts'), /messages \+= unseenIncomingRequestCount\(\);/);
});

// Report: the count stayed at 1 after the messages had been read. "New" now means "not yet shown
// on the Requests page"; the request itself stays on the page until it is answered.
test('opening the Requests page marks what it shows as seen, which clears the new count', () => {
  const ctx = harness({ incoming:[incoming('a'), incoming('b')], pageActive:true });
  assert.equal(run(ctx, 'unseenIncomingRequestCount()'), 2);
  assert.match(run(ctx, 'requestsRowHtml()'), /2 new · /);
  run(ctx, 'renderRequestsPage()');
  assert.equal(run(ctx, 'unseenIncomingRequestCount()'), 0);
  assert.equal(ctx.badgesUpdated, 1, 'the Chats badge is refreshed');
  const row = run(ctx, 'requestsRowHtml()');
  assert.match(row, /2 waiting · Mrmask, Mrmask/);
  assert.doesNotMatch(row, /vault-requests-badge/, 'no red badge once seen');
  assert.match(row, /aria-label="Requests, 0 new"/);
  assert.equal(ctx.nodes.get('requests-body').innerHTML.includes('data-connection-request-id="a"'), true, 'the request is still on the page');
});

test('a request that gains another message becomes new again', () => {
  const request = { ...incoming('a'), intro:[{}] };
  const ctx = harness({ incoming:[request], pageActive:true });
  run(ctx, 'renderRequestsPage()');
  assert.equal(run(ctx, 'unseenIncomingRequestCount()'), 0);
  ctx.pendingIncomingConnections[0] = { ...incoming('a'), intro:[{}, {}] };
  assert.equal(run(ctx, 'unseenIncomingRequestCount()'), 1, 'a second message is new');
  run(ctx, 'renderRequestsPage()');
  assert.equal(run(ctx, 'unseenIncomingRequestCount()'), 0);
});

test('a brand-new request is new, and answered requests are forgotten', () => {
  const ctx = harness({ incoming:[incoming('a')], pageActive:true });
  run(ctx, 'renderRequestsPage()');
  ctx.pendingIncomingConnections.push(incoming('b'));
  assert.equal(run(ctx, 'unseenIncomingRequestCount()'), 1, 'only the new one');
  ctx.pendingIncomingConnections.splice(0, 1);
  run(ctx, 'renderRequestsPage()');
  assert.deepEqual(Object.keys(JSON.parse(ctx.storage.get('vaultlix_requests_seen:a'))), ['b'], 'the answered request is dropped from the list');
});

test('nothing is marked seen while the app is in the background or signed out', () => {
  const hidden = harness({ incoming:[incoming('a')], pageActive:true, hidden:true });
  run(hidden, 'renderRequestsPage()');
  assert.equal(run(hidden, 'unseenIncomingRequestCount()'), 1);
  const signedOut = harness({ incoming:[incoming('a')], state:null });
  assert.equal(run(signedOut, 'unseenIncomingRequestCount()'), 0);
  assert.equal(run(signedOut, 'markRequestsSeen()'), false);
});

test('seen state is per account, in its own key, and a damaged value is ignored', () => {
  const ctx = harness({ incoming:[incoming('a')], pageActive:true });
  run(ctx, 'renderRequestsPage()');
  assert.deepEqual(JSON.parse(ctx.storage.get('vaultlix_requests_seen:a')), { a:0 });
  ctx.storage.set('vaultlix_requests_seen:a', 'not json');
  assert.equal(run(ctx, 'unseenIncomingRequestCount()'), 1);
  ctx.storage.set('vaultlix_requests_seen:a', '[1,2]');
  assert.equal(run(ctx, 'unseenIncomingRequestCount()'), 1);
  assert.match(client, /const REQUESTS_SEEN_KEY_PREFIX = 'vaultlix_requests_seen:';/);
  assert.doesNotMatch(extractFn('markRequestsSeen'), /persistRoom\(/);
});

test('the page marks requests seen only after it has rendered them', () => {
  assert.match(extractFn('renderRequestsPage'), /scrollToFocusedConnectionRequest\(\);\s*\/\/ Seeing them clears[^\n]*\n\s*if \(markRequestsSeen\(\)\) updateVaultNavigationBadges\(\);/);
});

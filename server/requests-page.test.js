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

function harness({ incoming = [], outgoing = [], pageActive = false, state = { accountId:'a' } } = {}) {
  const nodes = new Map([['requests-body', { innerHTML:'' }]]);
  const context = vm.createContext({
    pendingIncomingConnections:incoming, pendingOutgoingConnections:outgoing, pendingConnectionFocusId:null,
    escapeHtml, escHtml:escapeHtml, i18n:key => ({ connection_request_text:'Wants to start a private conversation', accept:'Accept', decline:'Decline' }[key] || key),
    connectionRequestAvatarCard:() => '<span class="avatar"></span>', requestIntroSlot:request => request.intro ? `<div data-request-intro="${request.id}"></div>` : '',
    outgoingIntroHtml:() => '<div class="outgoing-meta"></div>', formatPrivateNumber:value => `fmt-${value}`,
    hydrateRequestIntros:async () => { context.hydrated = (context.hydrated || 0) + 1; }, scrollToFocusedConnectionRequest:() => { context.scrolled = true; },
    document:{ getElementById:id => id === 's-requests' ? { classList:{ contains:name => name === 'active' && pageActive } } : nodes.get(id) || null },
    loadAccountState:() => state, openAccountPanel:() => { context.panel = true; }, showScreen:id => { context.screen = id; }, nodes,
  });
  vm.runInContext(['incomingRequestCardHtml', 'outgoingRequestCardHtml', 'requestsRowHtml', 'openRequests', 'closeRequests', 'renderRequestsPageIfOpen', 'renderRequestsPage'].map(extractFn).join('\n'), context);
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
  assert.match(extractFn('vaultNavigationCounts'), /messages \+= pendingIncomingConnections\.length;/);
});

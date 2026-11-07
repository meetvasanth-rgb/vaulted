'use strict';

// Until someone has a first connection, the inbox keeps a card at the top: share your number or its QR.
// "Later" hides it for two days, then it returns.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFunction(name, prefix = 'function') {
  const start = client.indexOf(`${prefix} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

function harness({ state = { accountId:'acc1', privateNumber:'2345678901', displayName:'Vasanth' }, rooms = 0, groups = 0, outgoing = 0, stored = {}, share = async () => true, recipientName = '' } = {}) {
  const store = new Map(Object.entries(stored));
  const shared = [], copied = [], toasts = [];
  let created = 0;
  const context = vm.createContext({
    loadAccountState: () => state,
    rooms:{ size:rooms }, privateGroups:{ size:groups }, pendingOutgoingConnections:{ length:outgoing },
    localStorage: { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value) },
    renderVaultList: () => { context.rendered = (context.rendered || 0) + 1; },
    openSystemShare: async text => { shared.push(text); return share(text); },
    sharePrivateInvitationWithQr: async (_state, _invitation, text) => { shared.push(text); return share(text); },
    requestInviteRecipientName: async () => recipientName,
    createPrivateInvitation: async () => { created++; return { url:'https://vaultlix.com/invite/K6AKTD', code:'K6AKTD', expiresAt:Date.now() + 86400000 }; },
    loadFirstConnectionWaiting: () => null,
    clearFirstConnectionWaiting: () => {},
    saveFirstConnectionWaiting: () => {},
    recordActivationEvent: () => {},
    navigator:{ clipboard:{ writeText: async text => { copied.push(text); } } },
    toast: message => toasts.push(message), showOwnPrivateNumberQr: () => {},
    Date, Number, String,
  });
  const source = "const INVITE_CARD_KEY_PREFIX = 'vaultlix_invite_card:'; const INVITE_CARD_SNOOZE_MS = 2 * 24 * 60 * 60 * 1000; let inviteCardShareInFlight = false;\n"
    + ['inviteShareText', 'inviteCardKey', 'inviteCardSnoozed', 'snoozeInviteCard', 'inviteCardHtml'].map(name => extractFunction(name)).join('\n')
    + '\n' + extractFunction('shareInviteFromCard', 'async function');
  vm.runInContext(source, context);
  return { context, store, shared, copied, toasts, created:() => created };
}

test('an account with no chats is shown the invite card, with share, QR and later', () => {
  const html = harness().context.inviteCardHtml();
  assert.match(html, /Connect with your first person/);
  assert.match(html, /onclick="shareInviteFromCard\(\)">Create invitation</);
  assert.match(html, /onclick="showInviteQrFromCard\(\)">Show QR</);
  assert.match(html, /onclick="snoozeInviteCard\(\)">Later</);
});

test('it goes away as soon as there is a first connection or group, and when signed out', () => {
  assert.equal(harness({ rooms:1 }).context.inviteCardHtml(), '');
  assert.equal(harness({ groups:1 }).context.inviteCardHtml(), '');
  assert.equal(harness({ state:null }).context.inviteCardHtml(), '');
  assert.equal(harness({ state:{ accountId:'acc1' } }).context.inviteCardHtml(), '', 'no private number yet');
});

test('while a request is waiting it says so, and still offers to invite someone else', () => {
  const html = harness({ outgoing:1 }).context.inviteCardHtml();
  assert.match(html, /Your invitation is on its way/);
  assert.match(html, /Share the invitation again/);
  assert.match(html, /Create invitation/);
});

test('"Later" hides it for two days, per account, in its own key, then it comes back', () => {
  const h = harness();
  const before = Date.now();
  h.context.snoozeInviteCard();
  const until = Number(h.store.get('vaultlix_invite_card:acc1'));
  assert.ok(until >= before + 2 * 24 * 60 * 60 * 1000 - 5 && until <= Date.now() + 2 * 24 * 60 * 60 * 1000 + 5);
  assert.equal(h.context.rendered, 1);
  assert.equal(h.context.inviteCardHtml(), '');
  // Past the snooze it returns; another account on the device is unaffected.
  assert.match(harness({ stored:{ 'vaultlix_invite_card:acc1':String(Date.now() - 1) } }).context.inviteCardHtml(), /Create invitation/);
  assert.match(harness({ state:{ accountId:'acc2', privateNumber:'3456789012', displayName:'B' }, stored:{ 'vaultlix_invite_card:acc1':String(Date.now() + 99999) } }).context.inviteCardHtml(), /Create invitation/);
});

test('share opens the system share sheet with the invitation QR card, falling back to copying its text', async () => {
  const shared = harness();
  await shared.context.shareInviteFromCard();
  assert.deepEqual(shared.shared, ['Vasanth invited you to connect on Vaultlix. This one-time invitation expires in 24 hours: https://vaultlix.com/invite/K6AKTD']);
  assert.deepEqual(shared.copied, []);
  const fallback = harness({ share: async () => false });
  await fallback.context.shareInviteFromCard();
  assert.equal(fallback.copied.length, 1);
  assert.deepEqual(fallback.toasts, ['Invitation copied — send it in any messaging app']);
  const cancelled = harness({ share: async () => { const error = new Error('x'); error.name = 'AbortError'; throw error; } });
  await cancelled.context.shareInviteFromCard();
  assert.deepEqual(cancelled.toasts, [], 'closing the share sheet is not an error');
});

test('the optional recipient name personalizes only the outgoing text, and cancelling creates no invitation', async () => {
  const named = harness({ recipientName:'Sam' });
  await named.context.shareInviteFromCard();
  assert.equal(named.created(), 1);
  assert.deepEqual(named.shared, ['Hi Sam, Vasanth invited you to connect on Vaultlix. This one-time invitation expires in 24 hours: https://vaultlix.com/invite/K6AKTD']);

  const cancelled = harness({ recipientName:null });
  await cancelled.context.shareInviteFromCard();
  assert.equal(cancelled.created(), 0);
  assert.deepEqual(cancelled.shared, []);
});

test('the one-time guide uses the same invitation text, and the card heads the inbox including the empty state', () => {
  assert.match(client, /const text = inviteShareText\(state, friendName, invitation\.url\);/);
  assert.equal(harness().context.inviteShareText({ displayName:'V', privateNumber:'2345678901' }, 'Sam', 'https://vaultlix.com/invite/K6AKTD'), 'Hi Sam, V invited you to connect on Vaultlix. This one-time invitation expires in 24 hours: https://vaultlix.com/invite/K6AKTD');
  assert.match(client, /let html = searchQuery \? '' : inviteCardHtml\(\) \+ avatarOfferHtml\(\) \+ dailyLookNudgeHtml\(\) \+ requestsRowHtml\(\);/);
  assert.match(client, /\$\{vaultSearchActive \? '' : inviteCardHtml\(\) \+ avatarOfferHtml\(\)\}<div class="vault-list-empty">/);
});

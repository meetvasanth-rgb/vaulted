'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');

function harness() {
  const storage = new Map();
  const state = { accountId: 'a' };
  const context = vm.createContext({
    rooms: new Map(), privateGroups: new Map(), entries: [], state,
    loadAccountState: () => state.accountId ? state : null,
    callHistoryEntries: () => context.entries,
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    scheduleAccountSync: () => {},
    currentVaultListMode: 'calls', tabFocused: true, quickLockActive: false, activePrivateGroupId: null,
    escHtml: s => String(s),
    roomDisplayLabel: room => room.name || room.code,
    formatVaultInboxTime: () => '10:00',
    formatCallHistoryTimestamp: () => '10:00',
    document: {
      hidden: false,
      getElementById: id => id === 's-vault-list' ? { classList: { contains: () => true } } : null,
    },
  });
  // Covers missedCallSeenState, missedCallBadgeEntries, vaultNavigationCounts,
  // markVaultMissedCallsViewed, updateVaultNavigationBadges and
  // setVaultListMode — stops short of the real callHistoryEntries, whose
  // function declaration would otherwise overwrite the stub above the
  // moment this script runs (it's a plain global assignment, same scope).
  vm.runInContext(html.slice(html.indexOf('let vaultMissedCallsSeenAccount'), html.indexOf('\nfunction callHistoryEntries')), context);
  // renderCallHistoryList's direction arrow reads callRecDirection() and
  // callDirectionIconHtml() — small pure functions, extracted for real
  // rather than stubbed. They sit back to back in the source.
  vm.runInContext(html.slice(html.indexOf('function callRecDirection'), html.indexOf('\nfunction addCallSysMsg')), context);
  // renderCallHistoryList alone, run after the stub is safely the only
  // callHistoryEntries in scope.
  vm.runInContext(html.slice(html.indexOf('function renderCallHistoryList'), html.indexOf('\nfunction startCallFromHistory')), context);
  return { context, storage, state };
}

function missedEntry(id, room = 'r') {
  return { room: { code: room }, rec: { id, callEventViewerRole: 'receiver' }, text: 'Missed encrypted call', occurredAt: 123 };
}

function fakeBody() {
  return { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
}

test('a genuinely missed, unviewed call renders with the highlight class and dot', () => {
  const { context: c } = harness();
  c.entries = [missedEntry('1')];
  const body = fakeBody();
  c.renderCallHistoryList(body);
  assert.match(body.innerHTML, /vault-call-row missed-unseen/);
});

test('once viewed (markVaultMissedCallsViewed has run), the same call no longer highlights on re-render', () => {
  const { context: c } = harness();
  c.entries = [missedEntry('1')];
  c.markVaultMissedCallsViewed(); // simulates having already opened the calls tab once
  const body = fakeBody();
  c.renderCallHistoryList(body);
  assert.doesNotMatch(body.innerHTML, /missed-unseen/);
  // The generic "missed" styling still applies regardless of seen state.
  assert.match(body.innerHTML, /vault-list-row-preview alert/);
});

test('a call this device placed that went unanswered ("No answer") never highlights, even though it is also unseen', () => {
  const { context: c } = harness();
  c.entries = [{ room: { code: 'r' }, rec: { id: '1', callEventViewerRole: 'initiator' }, text: 'No answer', occurredAt: 123 }];
  const body = fakeBody();
  c.renderCallHistoryList(body);
  assert.doesNotMatch(body.innerHTML, /missed-unseen/);
});

test('a normal completed call (not missed) never highlights', () => {
  const { context: c } = harness();
  c.entries = [{ room: { code: 'r' }, rec: { id: '1', callEventViewerRole: 'receiver' }, text: 'Encrypted call · 00:42', occurredAt: 123 }];
  const body = fakeBody();
  c.renderCallHistoryList(body);
  assert.doesNotMatch(body.innerHTML, /missed-unseen/);
  assert.doesNotMatch(body.innerHTML, /vault-list-row-preview alert/);
});

test('rendering the list on its own never marks calls as seen — only opening the calls tab does', () => {
  const { context: c } = harness();
  c.entries = [missedEntry('1')];
  const body = fakeBody();
  c.renderCallHistoryList(body);
  c.renderCallHistoryList(body); // a second render (e.g. a poll refresh) without markVaultMissedCallsViewed running
  assert.match(body.innerHTML, /missed-unseen/, 'still highlighted — nothing acknowledged it yet');
});

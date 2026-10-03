'use strict';

// The inbox header's magnifying-glass button used to be wired to
// openNewConnection() ("Add new Vaultlix number") instead of any search —
// a real bug report: the icon promises search, the click opens a different
// flow entirely. The "Add your friend" capability it used to expose is kept
// (the bottom vault-list-actions "+" button already calls the same
// openNewConnection(), so nothing is lost by repurposing the top button),
// and the top button now toggles an in-header search input that filters the
// rendered inbox rows by display name / group name / private number.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('the top inbox header button no longer opens "Add new Vaultlix number" — it toggles search', () => {
  const headerStart = client.indexOf('<div class="vault-list-hdr">');
  const headerEnd = client.indexOf('</div>\n  </div>', headerStart);
  const header = client.slice(headerStart, headerEnd);
  assert.match(header, /id="vault-search-toggle" onclick="toggleVaultSearch\(\)"/);
  assert.doesNotMatch(header.slice(0, header.indexOf('vault-search-toggle')), /openNewConnection/);
});

test('"Add your friend" is still reachable from the bottom inbox action bar', () => {
  assert.match(client, /class="vault-list-action" type="button" onclick="openNewConnection\(\)" aria-label="Add your friend"/);
});

test('toggleVaultSearch, openVaultSearch, closeVaultSearch and filterVaultList are all defined and wired to the DOM', () => {
  assert.match(client, /function toggleVaultSearch\(\) \{/);
  assert.match(client, /function openVaultSearch\(\) \{/);
  assert.match(client, /function closeVaultSearch\(\) \{/);
  assert.match(client, /function filterVaultList\(value\) \{/);
  assert.match(client, /oninput="filterVaultList\(this\.value\)"/);
});

test('closing search clears the query and switching to the Calls tab auto-closes an open search', () => {
  const closeFn = client.slice(client.indexOf('function closeVaultSearch() {'), client.indexOf('\n}', client.indexOf('function closeVaultSearch() {')) + 2);
  assert.match(closeFn, /vaultSearchQuery = '';/);
  assert.match(closeFn, /renderVaultList\(\);/);
  assert.match(client, /function setVaultListMode\(mode\) \{[\s\S]{0,200}if \(currentVaultListMode === 'calls' && vaultSearchActive\) closeVaultSearch\(\);/);
});

// Functional check of the actual filter predicate, extracted and run
// directly against hand-picked room/group fixtures — the structural checks
// above only confirm the wiring exists, not that the matching logic works.
function extractFilterLogic() {
  const start = client.indexOf('const searchQuery = vaultSearchActive ? vaultSearchQuery : \'\';');
  const end = client.indexOf('if (searchQuery && filteredEntries.length === 0)', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return client.slice(start, end);
}

function filteredIds({ privateGroups, rooms, query }) {
  // filterVaultList() lowercases/trims the raw input before it ever reaches
  // this logic (vaultSearchQuery = value.trim().toLowerCase()) — mirror
  // that here rather than feeding the raw query straight in.
  const context = {
    roomConcealed: () => false, hiddenChatsUnlocked: false,
    privateGroups, rooms, vaultSearchActive: true, vaultSearchQuery: query.trim().toLowerCase(),
    vaultLastActivity: () => 0,
    syncAchievementActivityFromMessages: () => {},
    roomDisplayLabel: room => room.peerDisplayName || '',
    formatPrivateNumber: value => value || '',
    statusHiddenIds: () => new Set(),
    statusFeed: [],
    normalizePrivateNumber: value => value,
    pendingIncomingConnections: [], pendingOutgoingConnections: [],
    requestHtml: '', outgoingRequestHtml: '',
    result: null,
  };
  vm.createContext(context);
  vm.runInContext(extractFilterLogic() +
    "\nresult = JSON.stringify(filteredEntries.map(entry => entry.kind === 'group' ? entry.group.id : entry.room.code));",
    context);
  return JSON.parse(context.result);
}

test('functional: search matches a room by display name, case-insensitively', () => {
  const rooms = new Map([
    ['room-victor', { code:'room-victor', peerDisplayName:'Victor' }],
    ['room-chottu', { code:'room-chottu', peerDisplayName:'Chottu' }],
  ]);
  assert.deepEqual(filteredIds({ privateGroups:new Map(), rooms, query:'vic' }), ['room-victor']);
  assert.deepEqual(filteredIds({ privateGroups:new Map(), rooms, query:'VICTOR' }), ['room-victor']);
});

test('functional: search matches a group by name, and an empty query returns everything unfiltered', () => {
  const privateGroups = new Map([['g1', { id:'g1', name:'Weekend Trip' }]]);
  const rooms = new Map([['room-a', { code:'room-a', peerDisplayName:'Alex' }]]);
  assert.deepEqual(filteredIds({ privateGroups, rooms, query:'weekend' }), ['g1']);
  assert.deepEqual(filteredIds({ privateGroups, rooms, query:'' }).sort(), ['g1', 'room-a'].sort());
});

test('functional: a query matching nothing returns an empty list rather than falling back to the full inbox', () => {
  const rooms = new Map([['room-a', { code:'room-a', peerDisplayName:'Alex' }]]);
  assert.deepEqual(filteredIds({ privateGroups:new Map(), rooms, query:'nobody-has-this-name' }), []);
});

test('functional: a room also matches by its peer private number, not just display name', () => {
  const rooms = new Map([['room-a', { code:'room-a', peerDisplayName:'Alex', peerPrivateNumber:'VX-7731' }]]);
  assert.deepEqual(filteredIds({ privateGroups:new Map(), rooms, query:'7731' }), ['room-a']);
});

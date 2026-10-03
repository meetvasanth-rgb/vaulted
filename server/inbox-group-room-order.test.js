const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

// Extracts exactly the merge-and-sort block from renderVaultList — not the
// whole function, which needs a real DOM — so this actually runs the
// ordering logic rather than trusting a read-through of the source.
function extractMergeSortBlock() {
  const start = client.indexOf('const groupEntries = [...privateGroups.values()]');
  const end = client.indexOf('.sort((a, b) => b.sortKey - a.sortKey);', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return client.slice(start, end + '.sort((a, b) => b.sortKey - a.sortKey);'.length);
}

function orderedIds({ privateGroups, rooms, activityByRoom }) {
  const context = {
    roomConcealed: () => false,
    privateGroups, rooms,
    vaultLastActivity: room => activityByRoom.get(room),
    syncAchievementActivityFromMessages: () => {},
    result: null,
  };
  vm.createContext(context);
  // Map to plain id strings inside the same vm context that produced the
  // array, then JSON round-trip on the way out — comparing a vm-realm
  // array's structure directly against a main-realm array literal can trip
  // node:assert's reference-equality check even when the values match.
  vm.runInContext(extractMergeSortBlock() +
    "\nresult = JSON.stringify(orderedEntries.map(entry => entry.kind === 'group' ? entry.group.id : entry.room.code));",
    context);
  return JSON.parse(context.result);
}

test('groups and 1:1 rooms interleave by their own last-activity timestamp, newest first', () => {
  const privateGroups = new Map([
    ['g-stale', { id:'g-stale', name:'Old group', updatedAt: 1000 }],
    ['g-fresh', { id:'g-fresh', name:'Fresh group', updatedAt: 5000 }],
  ]);
  const roomA = { code:'room-a' }, roomB = { code:'room-b' };
  const rooms = new Map([['room-a', roomA], ['room-b', roomB]]);
  const activityByRoom = new Map([[roomA, 4000], [roomB, 500]]);

  assert.deepEqual(orderedIds({ privateGroups, rooms, activityByRoom }),
    ['g-fresh', 'room-a', 'g-stale', 'room-b']);
});

test('a group with no messages yet sorts below any active room, not pinned above it', () => {
  const privateGroups = new Map([['g-new', { id:'g-new', name:'Just created' }]]); // no updatedAt
  const room = { code:'room-active' };
  const rooms = new Map([['room-active', room]]);
  const activityByRoom = new Map([[room, 999]]);

  assert.deepEqual(orderedIds({ privateGroups, rooms, activityByRoom }),
    ['room-active', 'g-new']);
});

test('renderVaultList no longer renders every group before the room loop unconditionally', () => {
  const start = client.indexOf('function renderVaultList()');
  const end = client.indexOf('\nfunction ', start + 1);
  const body = client.slice(start, end);
  assert.doesNotMatch(body, /for \(const group of orderedGroups\)/);
  assert.doesNotMatch(body, /for \(const room of orderedRooms\)/);
  // The render loop iterates filteredEntries now (orderedEntries narrowed by
  // an active inbox search query) — unfiltered when no search is active, so
  // this is still exactly the same ordering as before, just filterable.
  assert.match(body, /const filteredEntries = searchQuery[\s\S]{0,400}: orderedEntries;/);
  assert.match(body, /for \(const entry of filteredEntries\)/);
});

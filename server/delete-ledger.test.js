'use strict';

// "Delete for me" is remembered on the device (the server still holds the
// message), so the ledger of deletions must outlive the server's own history
// and must never be lost when account sync picks another copy of a conversation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

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

const sandbox = vm.createContext({ Object, Number, Date, Math, Array });
vm.runInContext(`const DELETE_LEDGER_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; const DELETE_LEDGER_MAX_ENTRIES = 5000;`, sandbox);
for (const name of ['mergeDeleteLedgers', 'pruneDeleteLedger']) vm.runInContext(extract(client, name), sandbox);
const run = expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, sandbox));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 2_000_000_000_000;

test('a deletion made 49 hours ago is still remembered (it used to be forgotten after 48)', () => {
  const ledger = { m1:NOW - 49 * 3600 * 1000, m2:NOW - 30 * DAY };
  assert.deepEqual(run(`pruneDeleteLedger(${JSON.stringify(ledger)}, ${NOW})`), ledger);
});

test('only deletions older than a year are dropped', () => {
  const ledger = { fresh:NOW - DAY, old:NOW - 366 * DAY };
  assert.deepEqual(run(`pruneDeleteLedger(${JSON.stringify(ledger)}, ${NOW})`), { fresh:NOW - DAY });
});

test('the ledger is capped at 5000 entries, keeping the newest', () => {
  const ledger = {};
  for (let i = 0; i < 5200; i++) ledger[`m${i}`] = NOW - i * 1000;
  const pruned = run(`pruneDeleteLedger(${JSON.stringify(ledger)}, ${NOW})`);
  assert.equal(Object.keys(pruned).length, 5000);
  assert.ok('m0' in pruned && 'm4999' in pruned);
  assert.equal('m5199' in pruned, false);
});

test('merging keeps a deletion recorded on either side, and the later time for the same message', () => {
  const merged = run(`mergeDeleteLedgers({ a:1000, b:2000 }, { b:3000, c:4000 })`);
  assert.deepEqual(merged, { a:1000, b:3000, c:4000 });
});

test('merging tolerates missing, null and junk entries', () => {
  assert.deepEqual(run('mergeDeleteLedgers(undefined, null, "x", { ok:5, bad:"nope", "":9 })'), { ok:5 });
  assert.deepEqual(run('mergeDeleteLedgers()'), {});
});

test('account sync merges the two copies\' ledgers instead of picking one', () => {
  assert.match(client, /const deleteLedger = pruneDeleteLedger\(mergeDeleteLedgers\(current\?\.deleteLedger, ownedSession\.deleteLedger\)\);/);
  assert.match(client, /merged\.set\(session\.code, \{ \.\.\.selected, ownerAccountId:accountId, deleteLedger \}\);/);
});

test('saving the ledger merges with what is already stored, so nothing recorded elsewhere is lost', () => {
  assert.match(client, /existing\.deleteLedger = pruneDeleteLedger\(mergeDeleteLedgers\(existing\.deleteLedger, Object\.fromEntries\(room\.deleteLedger\)\)\);/);
  assert.doesNotMatch(client, /48 \* 60 \* 60 \* 1000/);
});

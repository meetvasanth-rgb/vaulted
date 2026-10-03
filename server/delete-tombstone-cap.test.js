'use strict';

// "Delete for everyone" never reached the peer in any conversation that already
// held 100 messages. The PostgreSQL load path rebuilds room.msgs from the 100
// newest live messages plus the deletion tombstones, then kept only the last
// 100 entries of the merged list — tombstones have no `seq`, so they sorted to
// the front and were the first thing cut. Every mutating request (the peer's
// /api/poll included) reloads the room that way, so the peer's poll saw no
// `deletions` at all and the message stayed on their screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function extract(name) {
  const start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = server.indexOf('{', server.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}' && --depth === 0) return server.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

const withRetainedTombstones = vm.runInNewContext(`(${extract('withRetainedTombstones')})`, {});
const plain = value => JSON.parse(JSON.stringify(value));
const live = count => Array.from({ length:count }, (_, index) => ({ id:`m${index + 1}`, seq:index + 1, type:'message', content:'x' }));
const tombstone = (id, deletionSeq) => ({ id, type:'message', content:null, deleted:true, deletionSeq });

test('a tombstone survives even when the conversation already holds a full 100 live messages', () => {
  const result = plain(withRetainedTombstones(live(100), [tombstone('gone', 1)]));
  assert.ok(result.some(message => message.id === 'gone' && message.deleted), 'tombstone was dropped');
  assert.equal(result.filter(message => !message.deleted).length, 100);
});

test('only the newest 100 live messages are kept, in sequence order, after the tombstones', () => {
  const result = plain(withRetainedTombstones(live(130).reverse(), [tombstone('a', 1), tombstone('b', 2)]));
  assert.deepEqual(result.slice(0, 2).map(message => message.id), ['a', 'b']);
  const liveSeqs = result.slice(2).map(message => message.seq);
  assert.equal(liveSeqs.length, 100);
  assert.equal(liveSeqs[0], 31);
  assert.equal(liveSeqs[99], 130);
});

test('a message that is both live and tombstoned is not duplicated, and no tombstones is fine', () => {
  const result = plain(withRetainedTombstones(live(3), [tombstone('m2', 5)]));
  assert.equal(result.filter(message => message.id === 'm2').length, 1);
  assert.equal(plain(withRetainedTombstones(live(3), undefined)).length, 3);
});

test('both PostgreSQL load paths use the helper instead of slicing the merged list', () => {
  assert.doesNotMatch(server, /\.\.\.tombstones\]/);
  assert.equal((server.match(/withRetainedTombstones\(/g) || []).length, 3); // definition + two load paths
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');

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

test('a server reaction snapshot restores both this device and its peer', () => {
  const context = vm.createContext({});
  vm.runInContext(extract(client, 'applyReactionSnapshot'), context);
  const rec = { reactionMine:null, reactionTheirs:null };
  context.rec = rec;
  context.reactions = { mine:'👍', peerHash:'❤️' };
  vm.runInContext("applyReactionSnapshot(rec, reactions, 'mine')", context);
  assert.equal(rec.reactionMine, '👍');
  assert.equal(rec.reactionTheirs, '❤️');

  context.reactions = { peerHash:'😂' };
  vm.runInContext("applyReactionSnapshot(rec, reactions, 'mine')", context);
  assert.equal(rec.reactionMine, null, 'an authoritative removal clears my old reaction');
  assert.equal(rec.reactionTheirs, '😂');
});

test('history, attachment placeholders, new messages and live deltas all apply reaction snapshots', () => {
  const uses = client.match(/applyReactionSnapshot\(/g) || [];
  assert.ok(uses.length >= 6, 'every direct-message restore and sync path should share the snapshot merge');
  assert.match(client, /applyReactionSnapshot\(rec, msg\.reactions, room\.token\)/);
  assert.match(client, /applyReactionSnapshot\(placeholder, msg\.reactions, room\.token\)/);
  assert.match(client, /applyReactionSnapshot\(rec, u\.reactions, room\.token\)/);
});

test('a failed optimistic reaction rolls back instead of disappearing later', () => {
  const send = extract(client, 'sendReaction');
  assert.match(send, /const previous = rec\.reactionMine/);
  assert.match(send, /rec\.reactionMine = previous/);
  assert.match(send, /Couldn\\'t save reaction\. Please try again\./);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectGroupMessages } = require('./group-page');

const msgs = n => Array.from({ length:n }, (_, i) => ({ id:`m${i + 1}`, createdAt:(i + 1) * 10 }));
const ids = page => page.selected.map(message => message.id);

test('a normal poll returns what is newer than the cursor', () => {
  assert.deepEqual(ids(selectGroupMessages(msgs(5), 0, { after:30 })), ['m4', 'm5']);
});

test('the newest messages win when there are more than the limit', () => {
  const page = selectGroupMessages(msgs(10), 0, { limit:3 });
  assert.deepEqual(ids(page), ['m8', 'm9', 'm10']);
  assert.equal(page.hasOlder, true);
});

test('nothing from before the member joined is ever returned or counted', () => {
  const page = selectGroupMessages(msgs(10), 55, {});
  assert.deepEqual(ids(page), ['m6', 'm7', 'm8', 'm9', 'm10']);
  assert.equal(page.hasOlder, false);
  const older = selectGroupMessages(msgs(10), 55, { before:60 });
  assert.deepEqual(ids(older), []);
  assert.equal(older.hasOlder, false);
});

test('paging back: messages before the given time, newest of them first in the page', () => {
  const page = selectGroupMessages(msgs(10), 0, { before:71, limit:3 }); // before m8
  assert.deepEqual(ids(page), ['m5', 'm6', 'm7']);
  assert.equal(page.hasOlder, true);
  const last = selectGroupMessages(msgs(10), 0, { before:31, limit:5 });
  assert.deepEqual(ids(last), ['m1', 'm2', 'm3']);
  assert.equal(last.hasOlder, false);
});

test('a poll that returns nothing new can still say whether older ones exist', () => {
  const all = msgs(10);
  const none = selectGroupMessages(all, 0, { after:100, oldest:50 });
  assert.deepEqual(ids(none), []);
  assert.equal(none.hasOlder, true);
  assert.equal(selectGroupMessages(all, 0, { after:100, oldest:10 }).hasOlder, false);
  assert.equal(selectGroupMessages([], 0, { after:0, oldest:0 }).hasOlder, false);
});

test('bad input falls back to safe values', () => {
  assert.equal(selectGroupMessages(msgs(300), 0, { limit:'x' }).selected.length, 200);
  assert.equal(selectGroupMessages(msgs(300), 0, { limit:9999 }).selected.length, 200);
  assert.equal(selectGroupMessages(msgs(3), 'nope', { after:'nope', before:'nope' }).selected.length, 3);
  assert.deepEqual(selectGroupMessages(null, 0, {}).selected, []);
});

test('the route uses it and returns hasOlder', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
  assert.match(source, /selectGroupMessages\(group\.messages, joinedAt, \{ after, before:d\.before, limit:d\.limit, oldest:d\.oldest \}\)/);
  assert.match(source, /hasOlder:page\.hasOlder/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '../client/groups.js'), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  let cursor = source.indexOf('{', start);
  let depth = 0;
  for (; cursor < source.length; cursor++) {
    if (source[cursor] === '{') depth++;
    else if (source[cursor] === '}' && --depth === 0) return source.slice(start, cursor + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const suggestionSource = functionSource(client, 'smartReplySuggestions');
const context = {};
vm.createContext(context);
vm.runInContext(`${suggestionSource}; this.suggest = smartReplySuggestions;`, context);

test('smart replies are short, useful and chosen from the decrypted message on this device', () => {
  assert.deepEqual([...context.suggest('Thanks for helping me')], ['You’re welcome!', 'Anytime 😊', 'No problem!']);
  assert.deepEqual([...context.suggest('Can you come tonight?')], ['Yes, I’ll be there.', 'Not sure yet.', 'I’ll let you know.']);
  assert.deepEqual([...context.suggest('Happy Diwali!')], ['Happy Diwali! 🪔', 'Thank you! 😊', 'Same to you!']);
  assert.ok(context.suggest('Let us meet for coffee').length <= 3);
});

test('smart replies avoid links, long messages and sensitive codes', () => {
  assert.deepEqual([...context.suggest('https://vaultlix.com/invite/ABC123')], []);
  assert.deepEqual([...context.suggest('My OTP is 123456')], []);
  assert.deepEqual([...context.suggest('x'.repeat(281))], []);
});

test('suggestion generation is local and never calls a server or external model', () => {
  assert.doesNotMatch(suggestionSource, /\b(?:fetch|api|OpenAI|XMLHttpRequest)\b/);
  assert.match(client, /message is never sent to Vaultlix, OpenAI or an OS service/);
});

test('one-to-one and private-group chats both expose the same accessible suggestion rail', () => {
  assert.match(client, /id="smart-reply-rail" aria-label="Suggested replies" hidden/);
  assert.match(client, /id="group-smart-reply-rail" aria-label="Suggested replies" hidden/);
  assert.match(client, /updateDirectSmartReplies\(room\)/);
  assert.match(groups, /updatePrivateGroupSmartReplies\(group\)/);
  assert.match(groups, /renderSmartReplyRail\('group-smart-reply-rail', 'group-message-input', smartReplySuggestions\(text\), true\)/);
});

test('tapping a suggestion fills the composer for review and never sends automatically', () => {
  const fillSource = functionSource(client, 'fillSmartReply');
  assert.match(fillSource, /input\.value = String\(text \|\| ''\)/);
  assert.match(fillSource, /input\.focus/);
  assert.doesNotMatch(fillSource, /sendMsg|sendPrivateGroupMessage|\.click\(/);
});

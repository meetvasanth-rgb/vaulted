'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '../client/groups.js'), 'utf8');

test('chat composers do not render or generate automatic reply suggestions', () => {
  for (const source of [client, groups]) {
    assert.doesNotMatch(source, /smartReply|smart-reply|Suggested replies/i);
  }
  assert.match(client, /id="msg-input"/);
  assert.match(client, /id="group-message-input"/);
});

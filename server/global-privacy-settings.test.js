'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('global Privacy and Security never targets an active conversation', () => {
  assert.match(client, /conversationSafetyVisible = !!room && settingsContextMode === 'chat' && category === 'chats'/);
  assert.doesNotMatch(client, /privacy_security_subtitle:'App lock, blocking/);
});

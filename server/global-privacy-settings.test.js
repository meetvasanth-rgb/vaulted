'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('global Privacy and Security never targets an active conversation', () => {
  assert.match(client, /conversationChatsVisible = !!room && settingsContextMode === 'chat' && category === 'chats'/);
  assert.match(client, /const conversationSafetyVisible = conversationChatsVisible/);
  assert.doesNotMatch(client, /privacy_security_subtitle:'App lock, blocking/);
});

test('global Chats is general guidance and never displays an arbitrary active contact', () => {
  assert.match(client, /id="settings-chats-section"/);
  assert.match(client, /globalChatsVisible = settingsContextMode === 'general' && category === 'chats'/);
  assert.match(client, /settings-room-section'\)\.style\.display = conversationChatsVisible \? '' : 'none'/);
  assert.match(client, /Participant numbers appear only inside their own conversation settings/);
});

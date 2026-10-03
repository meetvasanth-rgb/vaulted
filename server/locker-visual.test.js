'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('Locker setup, unlock and vault use the Vaultlix card system', () => {
  assert.match(client, /id="locker-setup-form"[^>]*class="app-lock-sheet locker-sheet"|class="app-lock-sheet locker-sheet" id="locker-setup-form"/);
  assert.match(client, /class="locker-kicker">Private on this device/);
  assert.match(client, /class="locker-kicker">Encrypted locally/);
  assert.match(client, /class="locker-brand-mark"/);
  assert.match(client, /\.locker-sheet\{[^}]*linear-gradient[^}]*#FBF5F7/);
  assert.match(client, /\.locker-brand-mark\{[^}]*background:#682C43/);
  assert.match(client, /class="app-lock-actions locker-actions"/);
  assert.match(client, /class="primary-action"[^>]*>Add note</);
});

test('App Lock stays plain while Hidden chats intentionally shares the trusted Locker card system', () => {
  assert.match(client, /id="app-lock-setup-form"[^>]*class="app-lock-sheet"|class="app-lock-sheet" id="app-lock-setup-form"/);
  assert.doesNotMatch(client, /id="app-lock-setup-form"[^>]*locker-sheet|locker-sheet[^>]*id="app-lock-setup-form"/);
  assert.match(client, /id="hidden-chats-form"[^>]*locker-sheet hidden-chats-sheet|locker-sheet hidden-chats-sheet[^>]*id="hidden-chats-form"/);
  assert.match(client, /\.hidden-chats-sheet\{[^}]*'Inter'/);
  assert.match(client, /id="hidden-chats-kicker">Private on this device/);
  assert.match(client, /#locker-setup-overlay,#locker-unlock-overlay,#locker-vault-overlay/);
});

test('Locker Notes use the Vaultlix typography, spacing and card treatment', () => {
  assert.match(client, /\.locker-note-heading-input\{[^}]*'Manrope'/);
  assert.match(client, /\.locker-note-body-input\{[^}]*background:#fff[^}]*border-radius/);
  assert.match(client, /\.locker-fullscreen-head\{[^}]*background:#fff[^}]*border-bottom/);
  assert.match(client, /\.locker-fullscreen-delete\{[^}]*background:#FFF1F3/);
});

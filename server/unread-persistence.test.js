'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'client', 'sw.js'), 'utf8');

test('the Android unread fix ships in a fresh app-shell cache', () => {
  assert.match(worker, /vaultlix-app-shell-v127/);
});

test('direct-chat unread state survives restart and clears only when viewed', () => {
  assert.match(client, /unread: Math\.max\(0, Number\(unread\) \|\| 0\)/);
  assert.match(client, /unreadSystemCount: Math\.max\(0, Number\(unreadSystemCount\) \|\| 0\)/);
  assert.match(client, /existing\.unread = Math\.max\(0, Number\(room\.unread\) \|\| 0\)/);
  assert.match(client, /existing\.unreadSystemCount = Math\.max\(0, Number\(room\.unreadSystemCount\) \|\| 0\)/);
  assert.match(client, /makeRoom\(\{[^\n]+unread:session\.unread, unreadSystemCount:session\.unreadSystemCount/);
  assert.match(client, /function setActiveRoom[\s\S]{0,600}room\.unread = 0; room\.unreadSystemCount = 0;[\s\S]{0,240}persistRoomSeq\(room\)/);
  assert.match(client, /lastReadSeq:Math\.max\(0, Number\(room\.lastReadSeq\) \|\| 0\)/);
  assert.match(client, /lastReadSeq:session\.lastReadSeq === undefined \? session\.lastSeq : session\.lastReadSeq/);
  assert.match(client, /unreadStateVersion:session\.unreadStateVersion \|\| 0/);
  assert.match(client, /unreadMigrationCutoffAt:session\.savedAt/);
});

test('successful full restore rebuilds unread counts from server read receipts', () => {
  assert.match(client, /msg\.type !== 'message' \|\| msg\.from === room\.token \|\| msg\.readAt/);
  assert.match(client, /room\.unread = restoredUnread/);
  assert.match(client, /room\.unreadSystemCount = restoredUnreadSystemCount/);
  assert.match(client, /Number\(msg\.seq\) <= \(Number\(room\.lastReadSeq\) \|\| 0\)/);
  assert.match(client, /if \(room\.unreadMigrationPending\)[\s\S]{0,1200}room\.unreadStateVersion = 2/);
  assert.match(client, /legacyReadBaseline[\s\S]{0,400}Number\(msg\.ts\)[\s\S]{0,400}Number\(msg\.seq\)/);
  assert.match(client, /if \(unreadChanged\) persistRoomSeq\(room\)/);
});

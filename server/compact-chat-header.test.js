'use strict';

// The "Encrypted" and "Timer" bars used to take a full row above the messages.
// They now share the line under the contact's name, as in Signal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extract(name) {
  const start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

const chat = client.slice(client.indexOf('<div id="s-chat"'), client.indexOf('<div class="chat-body" id="chat-body">'));

test('there is no bar of its own above the messages any more', () => {
  assert.doesNotMatch(chat, /class="chat-tools"/);
});

test('presence, the lock and the timer share one line in the header, under the name', () => {
  const header = chat.slice(chat.indexOf('<div class="chat-hdr">'), chat.indexOf('<div class="conversation-menu"'));
  const sub = header.slice(header.indexOf('<div class="chat-hdr-sub">'), header.indexOf('<!-- Primary call actions'));
  for (const marker of ['id="chat-presence"', 'class="e2e-bar"', 'class="timer-bar"', 'id="timer-bar-select"']) assert.ok(sub.includes(marker), marker);
  assert.ok(header.indexOf('vaultlix-identity-line') < header.indexOf('chat-hdr-sub'), 'it sits under the name');
});

test('the existing wiring still finds its elements', () => {
  assert.match(client, /document\.querySelector\('\.e2e-bar'\)/);
  assert.match(client, /getElementById\('timer-bar-select'\)/);
  assert.match(chat, /onclick="showVerifyPanel\(\)"/);
  assert.match(chat, /onchange="changeRoomTimer\(this\.value\)" aria-label="Disappearing messages"/);
});

test('the lock shows only its icon when all is well; a warning still shows its words', () => {
  assert.match(client, /#s-chat \.chat-hdr-sub \.e2e-bar:not\(\.pending\) span\{display:none\}/);
  assert.match(client, /#s-chat \.chat-hdr-sub \.e2e-bar\.pending\{color:/);
});

test('the timer is a small clock with a short length; the real select sits invisibly over it', () => {
  const short = seconds => vm.runInNewContext(`${extract('timerShortLabel')}; timerShortLabel(${seconds})`, { Number, Math });
  assert.equal(short(0), '');
  assert.equal(short(60), '1m');
  assert.equal(short(300), '5m');
  assert.equal(short(1800), '30m');
  assert.equal(short(3600), '1h');
  assert.equal(short(28800), '8h');
  assert.equal(short(86400), '1d');
  assert.equal(short(604800), '7d');
  assert.equal(short(undefined), '');
  assert.match(client, /#s-chat \.chat-hdr-sub \.timer-bar-controls::after\{content:attr\(data-short\)/);
  assert.match(client, /#s-chat \.chat-hdr-sub #timer-bar-select\{position:absolute!important;[^}]*opacity:0!important/);
});

test('the chip is refreshed whenever the timer is read or changed', () => {
  assert.match(extract('updateTimerBar'), /showTimerChip\(Number\(value\)\)/);
  assert.match(client, /room\.deleteTimerSeconds = seconds; \/\/ optimistic[^\n]*\n\s*showTimerChip\(seconds\);/);
});

test('the line under the name never draws its items over each other', () => {
  const block = client.slice(client.lastIndexOf('<style>'));
  assert.match(block, /#s-chat \.chat-hdr-sub\{overflow:hidden\}/);
  // On a phone the green dot alone says "online"; the word only returns where there is room.
  assert.match(block, /#s-chat \.chat-hdr-sub #chat-presence-label\{display:none\}/);
  assert.match(block, /@media\(min-width:560px\)\{#s-chat \.chat-hdr-sub #chat-presence-label\{display:inline/);
  assert.match(block, /#s-chat \.chat-hdr-sub \.e2e-bar,#s-chat \.chat-hdr-sub \.timer-bar\{flex:0 0 auto\}/);
  assert.match(chat, /id="chat-presence" title="Online" aria-label="Online" hidden/);
});

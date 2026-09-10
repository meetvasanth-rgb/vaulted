'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const chatHeader = client.slice(
  client.indexOf('<div id="s-chat" class="screen">'),
  client.indexOf('<button class="cross-vault-banner"')
);
const conversationSettings = client.slice(
  client.indexOf('id="settings-peer-number-actions"'),
  client.indexOf('id="persistent-suggestion-section"')
);

test('conversation header uses a back control and removes the repeated subtitle', () => {
  assert.match(chatHeader, /title="Back to conversations"/);
  assert.match(chatHeader, /<path d="m15 18-6-6 6-6"\/>/);
  assert.doesNotMatch(chatHeader, />Home<\/span>/);
  assert.doesNotMatch(chatHeader, />Private conversation<\/span>/);
});

test('conversation header shows presence only while the peer is online', () => {
  assert.match(chatHeader, /class="chat-hdr-presence" id="chat-presence" hidden/);
  assert.match(chatHeader, /id="status-dot"/);
  assert.match(chatHeader, /id="chat-presence-label">Online<\/span>/);
  assert.match(client, /if \(presence\) presence\.hidden = !online/);
  assert.doesNotMatch(chatHeader, />Offline<\/span>/);
});

test('conversation actions live in one accessible menu', () => {
  assert.match(chatHeader, /id="conversation-menu-btn"[^>]*aria-expanded="false"/);
  assert.match(chatHeader, /id="conversation-menu" role="menu"/);
  assert.match(chatHeader, />Conversation settings<\/span>/);
  assert.match(chatHeader, />Clear chat<\/span>/);
  assert.match(chatHeader, />Leave conversation<\/span>/);
  assert.match(chatHeader, />Delete conversation<\/span>/);
  assert.doesNotMatch(chatHeader, /class="settings-btn"/);
  assert.doesNotMatch(chatHeader, /class="leave-btn"/);
  assert.doesNotMatch(chatHeader, /class="destroy-btn"/);
});

test('expanded conversation actions overlay messages without changing conversation layout', () => {
  assert.match(client, /#s-chat\{position:relative;/);
  assert.match(client, /#s-chat \.chat-hdr\{\s*position:relative;z-index:41;/);
  assert.match(client, /#s-chat \.conversation-menu\{position:absolute;z-index:40;top:calc\(72px \+ env\(safe-area-inset-top\)\);left:12px;right:12px;/);
  assert.doesNotMatch(client, /#s-chat \.conversation-menu\{position:relative;/);
  assert.ok(
    chatHeader.indexOf('</div>\n  <div class="conversation-menu"') >
      chatHeader.indexOf('class="chat-hdr-actions"'),
    'the overlaid menu should remain a sibling immediately after the header'
  );
});

test('clear chat is available from the header menu only', () => {
  assert.match(client, /function clearConversationFromMenu\(\)/);
  assert.match(client, /function clearConversationFromMenu\(\) \{[\s\S]*?handleClearChat\(\);[\s\S]*?\}/);
  assert.doesNotMatch(conversationSettings, /handleClearChat\(\)/);
  assert.doesNotMatch(conversationSettings, />Clear chat<\/div>/);
});

test('conversation menu closes on navigation, outside tap and Escape', () => {
  assert.match(client, /function closeConversationMenu\(\)/);
  assert.match(client, /if \(!e\.target\.closest\('\.chat-hdr-actions'\)\) closeConversationMenu\(\)/);
  assert.match(client, /if \(e\.key !== 'Escape'\) return;[\s\S]*?closeConversationMenu\(\)/);
  assert.match(client, /function openVaultInbox\(\) \{\s*closeConversationMenu\(\);/);
});

test('duplicate encrypted call records are coalesced by content and event time', () => {
  assert.match(client, /const CALL_HISTORY_DEDUPE_WINDOW_MS = 12000/);
  assert.match(client, /function isDuplicateCallHistoryRecord\(room, candidate\)/);
  assert.match(client, /return isDuplicateCallHistoryRecord\(room, callRecord\) \? null : callRecord/);
  assert.match(client, /for \(const rec of uniqueVisibleConversationRecords\(room\.messages\)\)/);
  assert.match(client, /const visibleMessages = uniqueVisibleConversationRecords\(room\.messages\)/);
});

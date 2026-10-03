'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  let start = html.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist`);
  if (html.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let cursor = html.indexOf('(', start);
  let depth = 0;
  for (; cursor < html.length; cursor++) {
    if (html[cursor] === '(') depth++;
    else if (html[cursor] === ')' && --depth === 0) break;
  }
  cursor = html.indexOf('{', cursor);
  depth = 0;
  for (; cursor < html.length; cursor++) {
    if (html[cursor] === '{') depth++;
    else if (html[cursor] === '}' && --depth === 0) return html.slice(start, cursor + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function hiddenChatContext() {
  const store = new Map();
  const context = {
    crypto:webcrypto, TextEncoder, Uint8Array, JSON, btoa, atob,
    loadAccountState:() => ({ accountId:'account-a' }),
    localStorage:{
      getItem:key => store.get(key) ?? null,
      setItem:(key, value) => store.set(key, String(value)),
    },
    store,
  };
  vm.createContext(context);
  vm.runInContext("const HIDDEN_CHAT_CONFIG_PREFIX = 'vaultlix_private_visibility_v1:'; const HIDDEN_CHAT_PBKDF2_ITERATIONS = 210000;", context);
  for (const name of ['base64UrlToBytes', 'bytesToBase64', 'bytesToBase64UrlCompact', 'equalBytes', 'hiddenChatConfigKey',
    'loadHiddenChatConfig', 'saveHiddenChatConfig', 'hiddenChatRoomTag', 'hiddenChatIsHidden',
    'hiddenChatVerifier', 'verifyHiddenChatSecret']) vm.runInContext(extractFunction(name), context);
  return context;
}

test('hidden-chat secret is verified locally without storing the secret or room code', async () => {
  const ctx = hiddenChatContext();
  const secret = 'orchid-4821';
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const config = {
    version:1,
    iterations:210000,
    salt:ctx.bytesToBase64UrlCompact(salt),
    verifier:ctx.bytesToBase64UrlCompact(await ctx.hiddenChatVerifier(secret, salt)),
    secretLength:secret.length,
    tagSalt:ctx.bytesToBase64UrlCompact(webcrypto.getRandomValues(new Uint8Array(16))),
    tags:[],
  };
  config.tags.push(ctx.hiddenChatRoomTag('private-room-123', config));
  assert.equal(ctx.saveHiddenChatConfig(config), true);
  assert.equal(await ctx.verifyHiddenChatSecret(secret), true);
  assert.equal(await ctx.verifyHiddenChatSecret('wrong-code!'), false);
  assert.equal(ctx.hiddenChatIsHidden('private-room-123'), true);
  assert.equal(ctx.hiddenChatIsHidden('another-room'), false);
  const persisted = [...ctx.store.values()].join('');
  assert.doesNotMatch(persisted, /orchid-4821|private-room-123/);
});

test('hidden chats have no persistent reveal control and are excluded from secondary surfaces', () => {
  const menu = html.slice(html.indexOf('id="conversation-menu"'), html.indexOf('</div>', html.indexOf('id="conversation-menu"')));
  assert.match(menu, /id="hidden-chat-menu-action"/);
  assert.doesNotMatch(menu, /eye/i);
  assert.match(html, /type it exactly into the normal Chats search/);
  assert.match(html, /function callHistoryEntries[\s\S]*?if \(hiddenChatIsHidden\(room\)\) continue;/);
  assert.match(html, /function vaultNavigationCounts[\s\S]*?!hiddenChatIsHidden\(room\)/);
  assert.match(html, /function renderStatusPage[\s\S]*?hiddenChatPeerIsHidden/);
  assert.match(html, /function showForwardAttachmentPicker[\s\S]*?!hiddenChatIsHidden\(room\)/);
  assert.match(groups, /openCreateGroup[\s\S]*?!hiddenChatIsHidden\(room\)/);
  assert.match(groups, /groupAddCandidates[\s\S]*?!hiddenChatIsHidden\(room\)/);
});

test('hidden access closes on inbox navigation or backgrounding and direct notification routing is blocked', () => {
  assert.match(html, /function openVaultInbox\(\) \{[\s\S]{0,180}lockHiddenChats\(\);/);
  assert.match(html, /document\.addEventListener\('visibilitychange',[\s\S]{0,120}lockHiddenChats\(\{ leaveConversation:true \}\);/);
  assert.match(html, /function switchToRoomByCode\(code\)[\s\S]{0,180}if \(!hiddenChatCanOpen\(room\)\) return false;/);
  assert.match(html, /function openConversationAfterPaint\(code\)[\s\S]{0,180}if \(!hiddenChatCanOpen\(code\)\)/);
});

test('Locker and Notes use the Vaultlix typography, palette and controls', () => {
  assert.match(html, /\.locker-sheet\{[^}]*linear-gradient[^}]*#FBF5F7/);
  assert.match(html, /\.locker-brand-mark\{[^}]*background:#682C43/);
  assert.match(html, /\.locker-note-heading-input\{[^}]*'Manrope'/);
  assert.match(html, /\.locker-note-body-input\{[^}]*background:#fff[^}]*border-radius/);
  assert.match(html, /class="app-lock-actions locker-actions"/);
  assert.match(html, /class="primary-action"[^>]*>Add note</);
});

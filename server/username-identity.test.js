'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('public Private Number is separate from the private random account id', () => {
  assert.match(client, /function randomAccountId\(\)/);
  assert.match(server, /const privateNumbers = new Map\(\)/);
  assert.match(server, /version: 2, privateNumber, displayName/);
  assert.match(server, /function generatePrivateNumberCandidate\(category = 'standard'\)/);
  assert.match(server, /\^\[2-9\]\[0-9\]\{9\}\$/);
});

test('Private Number profiles and authenticated connection requests are exposed', () => {
  assert.match(server, /path\.startsWith\('\/api\/profile\/'\)/);
  assert.match(server, /path === '\/api\/connections\/request'/);
  assert.match(server, /path === '\/api\/connections\/respond'/);
  assert.match(client, /Connect privately/);
  assert.match(client, /Accept connection/);
});

test('signed-in settings support username changes and encrypted device recovery-code storage', () => {
  assert.match(server, /path === '\/api\/account\/profile'/);
  assert.match(server, /account\.displayName = displayName/);
  assert.match(client, /id="account-profile-display-name"/);
  assert.match(client, /updateAccountUsername\(event\)/);
  assert.match(client, /id="settings-profile-controls"[\s\S]*id="account-profile-form"/);
  assert.doesNotMatch(client, /id="settings-account-row" onclick="openAccountPanel/);
  assert.match(client, /profile:\['settings-account-row','settings-profile-controls'\]/);
  assert.match(client, /function populateAccountProfileSettings\(state = loadAccountState\(\)\)/);
  assert.match(client, /recoveryCodeWrap:await aesEncryptJson\(masterKey/);
  assert.match(client, /saveRecoveryCodeOnDevice\(event\)/);
  assert.match(client, /api\('\/api\/account\/recovery-bundle'/);
  assert.doesNotMatch(server, /account\.recoveryCode\s*=/);
});

test('username changes propagate to accepted peers and live conversations', () => {
  assert.match(server, /request\.senderAccountId === d\.accountId[\s\S]*request\.senderDisplayName = displayName/);
  assert.match(server, /request\.recipientAccountId === d\.accountId[\s\S]*request\.recipientDisplayName = displayName/);
  assert.match(server, /memberEntry\[1\]\.name = displayName/);
  assert.match(server, /postgresStore\.upsertConversationMember\(roomCode/);
  assert.match(server, /publishInboxRoom\(roomCode, 'profile'\)/);
  assert.match(client, /room\.peerName !== previousPeerName[\s\S]*await persistRoom\(room\)/);
});

test('accepted connections retain the peer Private Number inside conversation details', () => {
  assert.match(client, /function peerIdentityFromConnection\(request, state = loadAccountState\(\)\)/);
  assert.match(client, /senderNumber !== selfNumber/);
  assert.match(client, /recipientNumber !== selfNumber/);
  assert.match(client, /await reconcileConversationPeerIdentities\(result\.requests, state\)/);
  assert.match(client, /function conversationPeerPrivateNumber\(room = getActiveRoom\(\)\)/);
  assert.match(client, /privateNumber && privateNumber !== selfNumber/);
  assert.match(client, /peerPrivateNumber: room\.peerPrivateNumber \|\| null/);
  assert.match(client, /peerPrivateNumber:session\.peerPrivateNumber/);
  assert.match(client, /id="conversation-profile-private-number"/);
  assert.match(client, /Copy private number/);
  assert.match(client, /Share private number/);
  assert.match(client, /Save both your private number and recovery code\./);
});

test('the conversation gear is isolated from global settings', () => {
  assert.match(client, /function toggleSettings\(\) \{ settingsOpen \? closeSettings\(\) : openSettings\('chat', 'chats'\); \}/);
  assert.match(client, /settingsContextMode === 'chat' \? i18n\('conversation_settings'\)/);
  assert.match(client, /if \(settingsContextMode === 'chat'\) closeSettings\(\)/);
  assert.match(client, /settingsContextMode === 'chat' && category === 'chats'/);
});

test('new connection keeps its number form visible on Android', () => {
  assert.match(client, /#new-connection-overlay \.account-form\{order:2\}/);
  assert.match(client, /#new-connection-overlay \.account-copy\{order:3/);
  assert.match(client, /html\.vaultlix-native-android #new-connection-overlay \.account-card/);
  assert.match(client, /const guestView = document\.getElementById\('account-guest-view'\)/);
  assert.match(client, /guestView\.querySelectorAll\('\.account-form'\)/);
  assert.doesNotMatch(client, /document\.querySelectorAll\('\.account-form'\)\.forEach/);
});

test('vault setup uses the permanent identity name', () => {
  assert.match(client, /const name = identity\.displayName/);
  assert.match(client, /id="identity-name-field" style="display:none"/);
});

test('registration uses a reserved system-generated ten-digit Private Number', () => {
  assert.match(server, /path === '\/api\/account\/private-number'/);
  assert.match(server, /await reservePrivateNumber\(category\)/);
  assert.match(server, /privateNumbers\.has\(privateNumber\)/);
  assert.match(client, /id="account-private-number-value"/);
  assert.match(client, /function generatePrivateNumber\(category = 'standard'\)/);
  assert.match(client, /Generation limit reached\. Try again in about one hour\./);
  assert.match(client, /Password policy:<\/strong> Minimum 8 characters/);
  assert.match(client, /password\.length < 8/);
  assert.match(client, /This is not a cellular phone number/);
  assert.match(client, /vaultlix\.com\/\$\{result\.profile\.privateNumber\}/);
  assert.match(client, /<span>Username<\/span><input id="account-create-display-name"/);
  assert.doesNotMatch(client, /Your permanent name or pseudonym/);
});

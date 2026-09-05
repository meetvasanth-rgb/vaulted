const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(__dirname, '..', 'client', 'sw.js'), 'utf8');

test('connection requests use account-level native notifications', () => {
  assert.match(server, /\/api\/account\/native-push-subscribe/);
  assert.match(server, /sent you a connection request/);
  assert.match(server, /recipient\.account\.pushDestinations/);
  assert.match(server, /connectionRequest: !!parsed\.connectionRequest/);
  assert.match(server, /connectionRequest: parsed\.connectionRequest \? 'true' : 'false'/);
  assert.match(postgres, /push_destinations jsonb/);
  assert.match(client, /registerNativeTokenForAccount/);
  assert.match(client, /saveAccountState\(state\)[\s\S]*registerNativeTokenForAccount\(\)\.catch/);
  assert.match(client, /pushNotificationReceived/);
  assert.match(client, /notification\?\.data\?\.connectionRequest/);
  assert.match(server, /requestId:request\.id/);
  assert.match(server, /requestId: parsed\.connectionRequest \? String\(parsed\.requestId \|\| ''\)/);
  assert.match(client, /openConnectionRequest\(notification\.data\.requestId \|\| null\)/);
  assert.match(serviceWorker, /type:'connection-request-click', requestId/);
  assert.match(serviceWorker, /\?connectionRequest=\$\{encodeURIComponent\(requestId\)\}/);
});

test('sent connection requests remain visible while awaiting acceptance', () => {
  assert.match(client, /pendingOutgoingConnections/);
  assert.match(client, /direction === 'outgoing' && r\.status === 'pending'/);
  assert.match(client, /Connection request sent · awaiting acceptance/);
});

test('iOS call data rain is larger and runs at half speed', () => {
  assert.match(client, /ios-call-data-rain/);
  assert.match(client, /ios-call-data-rain \.call-data-column\{font-size:20px/);
  assert.match(client, /\* \(iosRain \? 2 : 1\)/);
});

test('connection UI uses conversation language and one encryption label', () => {
  assert.match(client, /Connect privately/);
  assert.doesNotMatch(client, /Request a private vault/);
  assert.doesNotMatch(client, /e2e-bar::after\{content:'Encrypted'/);
  assert.match(client, /private_vault:'Private conversation'/);
});

test('Quick Connect preserves intent through authentication and supports QR or pasted links', () => {
  assert.match(client, /vaultlix_quick_connect_target_v1/);
  assert.match(client, /rememberQuickConnectTarget\(activePublicProfile\.privateNumber\)/);
  assert.match(client, /resumeQuickConnectAfterAuthentication/);
  assert.match(client, /await requestPrivateVault\(\)/);
  assert.match(client, /Show my Quick Connect QR/);
  assert.match(client, /ref=qr/);
  assert.match(client, /Paste Vaultlix link or number/);
  assert.match(client, /privateNumberFromQuickConnectText/);
});

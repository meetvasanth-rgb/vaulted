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
  assert.match(client, /if \(result\.status === 'pending'\) \{[\s\S]*pendingOutgoingConnections = pendingOutgoingConnections[\s\S]*direction:'outgoing'[\s\S]*showScreen\('s-vault-list'\)/);
  assert.match(server, /const senderMirror = \(sender\.connectionRequests \|\| \[\]\)\.find\(r => r\.id === relationship\.id\)/);
  assert.match(server, /sender\.connectionRequests\.push\(\{[\s\S]*\.\.\.relationship,[\s\S]*direction:senderDirection/);
  assert.match(server, /await persistAccount\(d\.accountId\)/);
  assert.match(server, /Heal pending request mirrors left one-sided/);
  assert.match(server, /request\.senderAccountId !== d\.accountId && request\.recipientAccountId !== d\.accountId/);
  assert.match(server, /direction:request\.senderAccountId === d\.accountId \? 'outgoing' : 'incoming'/);
});

test('iOS call data rain is slower, larger, and organically randomized', () => {
  assert.doesNotMatch(client, /ios-call-data-rain/);
  assert.match(client, /const iosRain = document\.documentElement\.classList\.contains\('vaultlix-native-ios'\)/);
  assert.match(client, /html\.vaultlix-native-ios \.call-data-column\{font-size:11px\}/);
  assert.match(client, /const duration = iosRain \? baseDuration \* 4 \* \(\.9 \+ Math\.random\(\) \* \.2\) : baseDuration/);
  assert.match(client, /const groupGap = bit === nextGroupBreak \? 5 \+ Math\.random\(\) \* 12 : Math\.random\(\) \* 2\.5/);
  assert.match(client, /const left = 2 \+ index \* 5\.6 \+ \(iosRain \? \(Math\.random\(\) \* 3\.6 - 1\.8\) : 0\)/);
  assert.match(client, /function ensureStableCallDataRain\(overlay\)/);
  assert.match(client, /overlay\.querySelector\(':scope > \.call-data-rain'\)/);
  assert.match(client, /const stableIosRain = document\.documentElement\.classList\.contains\('vaultlix-native-ios'\)/);
  assert.match(client, /callSurface\.innerHTML =/);
  assert.match(client, /\$\{stableIosRain \? '' : callDataRainHtml\(\)\}/);
  assert.doesNotMatch(client, /overlay\.innerHTML = `\s*\$\{callDataRainHtml\(\)\}/);
  assert.match(client, /overlay\.querySelector\('\.call-data-rain'\)\?\.remove\(\)/);
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
  assert.match(client, /new URLSearchParams\(location\.search\)\.get\('ref'\) === 'qr'/);
  assert.match(client, /quickConnectQrUrl\(privateNumber\)/);
  assert.match(client, /package=com\.vaultlix\.app/);
  assert.match(client, /Paste Vaultlix link or number/);
  assert.match(client, /privateNumberFromQuickConnectText/);
});

test('logged-out Quick Connect is invitation-aware and creation-first', () => {
  assert.match(client, /invited you to extend a private line/);
  assert.match(client, /Create your Vaultlix Private Number to connect\. No phone number, email or contacts required\./);
  assert.match(client, /Create my private line/);
  assert.match(client, /Already have a Vaultlix number\? Sign in/);
  assert.match(client, /openQuickConnectAuthentication\(authenticationMode\)/);
  assert.match(client, /Your invitation from \$\{inviterName\} will be waiting after this step\./);
  assert.match(client, /Request sent to \$\{requestedProfile\.displayName\}\. We’ll notify you when they accept\./);
  assert.doesNotMatch(client, /Sign in to connect['<]/);
  assert.doesNotMatch(client, /\/api\/connect\/guest-request/);
});

test('Quick Connect survives a logged-out reload and resumes after authentication', () => {
  assert.match(client, /async function restoreQuickConnectInvitationAfterReload\(\)/);
  assert.match(client, /const target = loadQuickConnectTarget\(\);[\s\S]*return openPublicProfile\(target\);/);
  assert.match(client, /else if \(loadQuickConnectTarget\(\)\) \{[\s\S]*if \(loadAccountState\(\)\) await resumeQuickConnectAfterAuthentication\(\);[\s\S]*else await restoreQuickConnectInvitationAfterReload\(\);/);
  assert.match(client, /async function finishAccountCreation[\s\S]*await resumeQuickConnectAfterAuthentication\(\)/);
});

test('opening your own Quick Connect invitation gives visible feedback', () => {
  assert.match(client, /This is your Private Number/);
  assert.match(client, /clearQuickConnectTarget\(\);[\s\S]*closePublicProfile\(\);[\s\S]*toast\('That is your own Private Number'\)/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const android = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'VaultlixMessagingService.java'), 'utf8');

function extract(name) {
  let start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  if (server.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const end = server.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1);
  return server.slice(start, end);
}

// Isolated run of the real sendFcmNotification against a stubbed Firebase
// client — proves the actual branching logic, not just a regex over the
// source text, per this class of bug (timing/ordering/delivery-signal
// correctness) needing more than a read-through.
async function buildFcmMessage(parsed) {
  const context = {
    firebaseMessaging: { send: async message => { context.sentJson = JSON.stringify(message); } },
    sentJson: null,
  };
  vm.createContext(context);
  vm.runInContext(extract('sendFcmNotification') + '\nasync function run(p){ return sendFcmNotification({fcmToken:"tok"}, JSON.stringify(p), 60); }', context);
  await context.run(parsed);
  // JSON round-trip on the way out — comparing a vm-realm object's
  // structure directly against a main-realm object literal can trip
  // node:assert's reference-equality check even when the values match.
  return JSON.parse(context.sentJson);
}

test('a regular chat message (carries msgId) is sent data-only to Android, with the notification built natively instead', async () => {
  const message = await buildFcmMessage({ title: 'Vaultlix', body: 'New message from Alex', code: 'room1', msgId: 'msg123' });
  assert.equal(message.notification, undefined);
  assert.equal(message.android.notification, undefined);
  assert.equal(message.data.msgId, 'msg123');
  assert.equal(message.data.code, 'room1');
});

test('a call push stays data-only (unchanged behavior)', async () => {
  const message = await buildFcmMessage({ isCall: true, code: 'room1', caller: 'Alex' });
  assert.equal(message.notification, undefined);
  assert.equal(message.android.notification, undefined);
});

test('a push with no msgId and not a call (e.g. a connection request) keeps the existing system-rendered path', async () => {
  const message = await buildFcmMessage({ title: 'Vaultlix', body: 'New connection request', connectionRequest: true, requestId: 'req1' });
  assert.deepEqual(message.notification, { title: 'Vaultlix', body: 'New connection request' });
  assert.equal(message.android.notification.channelId, 'vaultlix_messages_bright_v1');
});

test('the message push payload sent server-side is the only one carrying msgId', () => {
  assert.match(server, /const payload = JSON\.stringify\(\{ title: 'Vaultlix', body: `New message from \$\{m\.name\}`, tag: `\$\{d\.code\}-\$\{msgId\}`, code: d\.code, msgId \}\);/);
});

test('Android builds the notification itself and reports delivery for a data-only message, using the room token from NativeCallRoomStore (not the WebView)', () => {
  assert.match(android, /String msgId = safe\(data\.get\("msgId"\)\);/);
  assert.match(android, /if \(!msgId\.isEmpty\(\)\) \{\s*\n\s*showMessageNotification\(data\);\s*\n\s*reportMessageDelivered\(safe\(data\.get\("code"\)\), msgId\);/);
  assert.match(android, /private void showMessageNotification\(Map<String, String> data\)/);
  assert.match(android, /private void reportMessageDelivered\(String code, String msgId\)/);
  assert.match(android, /NativeCallRoomStore\.Room room = new NativeCallRoomStore\(this\)\.byCode\(code\);/);
  assert.match(android, /new URL\("https:\/\/vaultlix\.com\/api\/mark-delivered"\)/);
  assert.match(android, /new JSONObject\(\)\.put\("code", code\)\.put\("token", room\.token\)\.put\("msgId", msgId\)/);
  // Best-effort: never lets a network failure here throw out of
  // onMessageReceived or block the notification from showing.
  assert.match(android, /reportMessageDelivered\(safe\(data\.get\("code"\)\), msgId\);\s*\n\s*return;/);
});

test('mark-delivered stays the shared server endpoint both sw.js (web push) and Android now call', () => {
  assert.match(server, /if \(path==='\/api\/mark-delivered' && method==='POST'\)/);
  const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'sw.js'), 'utf8');
  assert.match(client, /fetch\('\/api\/mark-delivered'/);
});

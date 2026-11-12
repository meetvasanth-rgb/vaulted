'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const android = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'VaultlixMessagingService.java'), 'utf8');
const androidActivity = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extract(name) {
  let start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  if (server.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const end = server.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1);
  return server.slice(start, end);
}

// The push functions pick the member's message tone through these helpers.
function extractToneHelpers() {
  const start = server.indexOf('const MESSAGE_TONE_IDS = new Set([');
  const end = server.indexOf('function sendApnsNotification(');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return server.slice(start, end);
}

// Isolated run of the real sendFcmNotification against a stubbed Firebase
// client — proves the actual branching logic, not just a regex over the
// source text, per this class of bug (timing/ordering/delivery-signal
// correctness) needing more than a read-through.
async function buildFcmMessage(parsed, member = {}) {
  const context = {
    firebaseMessaging: { send: async message => { context.sentJson = JSON.stringify(message); } },
    sentJson: null,
  };
  vm.createContext(context);
  vm.runInContext(extractToneHelpers() + extract('sendFcmNotification') + '\nasync function run(p,m){ return sendFcmNotification({fcmToken:"tok",...m}, JSON.stringify(p), 60); }', context);
  await context.run(parsed, member);
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
  assert.equal(message.android.notification.channelId, 'vaultlix_system_glow_v1');
  assert.equal(message.android.notification.sound, 'vault_tone_glow');
});

test('an app announcement is data-only so Android can reliably render its sound and thumbnail natively', async () => {
  const thumbnailUrl = 'https://vaultlix.com/icons/icon-192.png';
  const message = await buildFcmMessage({ title:'Vaultlix update', body:'A new update is ready.', announcement:true, updateId:'update-1', thumbnailUrl }, { announcementPushVersion:1 });
  assert.equal(message.data.thumbnailUrl, thumbnailUrl);
  assert.equal(message.data.announcement, 'true');
  assert.equal(message.data.updateId, 'update-1');
  assert.equal(message.notification, undefined);
  assert.equal(message.android.notification, undefined);
});

test('an older Android build keeps the existing Firebase-rendered announcement during rollout', async () => {
  const thumbnailUrl = 'https://vaultlix.com/icons/icon-192.png';
  const message = await buildFcmMessage({ title:'Vaultlix update', body:'A new update is ready.', announcement:true, updateId:'update-1', thumbnailUrl });
  assert.equal(message.notification.imageUrl, thumbnailUrl);
  assert.equal(message.android.notification.imageUrl, thumbnailUrl);
});

test('Android build 120 advertises native announcement support while older builds safely report zero', () => {
  assert.match(androidActivity, /public int announcementPushVersion\(\) \{ return 1; \}/);
  assert.match(client, /function nativeAnnouncementPushVersion\(\)/);
  assert.match(client, /window\.VaultlixAndroid\?\.announcementPushVersion\?\.\(\)/);
  assert.equal((client.match(/announcementPushVersion: nativeAnnouncementPushVersion\(\),/g) || []).length, 2);
  assert.match(server, /announcementPushVersion:Number\(d\.announcementPushVersion\) >= 1 \? 1 : 0/);
});

test('Android announcements use a dedicated audible channel, safe thumbnail download, and update deep link', () => {
  assert.match(android, /if \("true"\.equalsIgnoreCase\(data\.get\("announcement"\)\)\) \{\s*showAnnouncementNotification\(data\);\s*return;/);
  assert.match(android, /UPDATE_CHANNEL_ID = "vaultlix_updates_glow_v2"/);
  assert.match(android, /SYSTEM_CHANNEL_ID = "vaultlix_system_glow_v1"/);
  assert.match(android, /R\.raw\.vault_tone_glow/);
  assert.match(androidActivity, /VaultlixMessagingService\.ensureSystemNotificationChannels\(this\)/);
  assert.match(android, /private void showAnnouncementNotification\(Map<String, String> data\)/);
  assert.match(android, /appendQueryParameter\("update", updateId\.isEmpty\(\) \? "latest" : updateId\)/);
  assert.match(android, /builder\.setLargeIcon\(thumbnail\)/);
  assert.match(android, /new NotificationCompat\.BigPictureStyle\(\)/);
  assert.match(android, /manager\.notify\(notificationId, builder\.build\(\)\);\s*Bitmap thumbnail = downloadAnnouncementThumbnail/);
  assert.match(android, /\.setOnlyAlertOnce\(true\)/);
  assert.match(android, /!"https"\.equalsIgnoreCase\(url\.getProtocol\(\)\) \|\| !"vaultlix\.com"\.equalsIgnoreCase\(url\.getHost\(\)\)/);
});

test('a private-group message (carries groupId, no msgId) is sent data-only, with groupId/privateGroup forwarded', async () => {
  const message = await buildFcmMessage({ title: 'Vaultlix', body: 'New encrypted group message', privateGroup: true, groupId: 'grp1' });
  assert.equal(message.notification, undefined);
  assert.equal(message.android.notification, undefined);
  assert.equal(message.data.privateGroup, 'true');
  assert.equal(message.data.groupId, 'grp1');
});

test('groupId is never forwarded for a non-group push, even if a caller accidentally set it', async () => {
  const message = await buildFcmMessage({ title: 'Vaultlix', body: 'New connection request', connectionRequest: true, requestId: 'req1', groupId: 'leaked' });
  assert.equal(message.data.privateGroup, 'false');
  assert.equal(message.data.groupId, '');
});

test('the message push carries its id and explicit hidden-preview state', () => {
  assert.match(server, /const payload = JSON\.stringify\(\{ title, body: messageNotificationBody\(privacyEvent, senderLabel, mb\.hidePreview === true\), tag: `\$\{d\.code\}-\$\{msgId\}`, code: d\.code, msgId, privacyEvent, hidePreview:!!privacyEvent \|\| mb\.hidePreview === true \}\);/);
});

test('FCM forwards the capture type so Android preserves the security alert wording', async () => {
  const message = await buildFcmMessage({ title:'Vaultlix', body:'A screenshot was taken in your private conversation.', code:'room1', msgId:'capture1', privacyEvent:'screenshot' });
  assert.equal(message.data.privacyEvent, 'screenshot');
  assert.deepEqual(message.notification, { title:'Vaultlix', body:'A screenshot was taken in your private conversation.' });
  assert.equal(message.android.notification.channelId, 'vaultlix_system_glow_v1');
  assert.equal(message.android.notification.sound, 'vault_tone_glow');
});

test('room push destinations are persisted so a PostgreSQL reload cannot discard Android FCM registration', () => {
  const nativeRoute = server.slice(server.indexOf("if (path==='/api/native-push-subscribe'"), server.indexOf("// A PushKit token", server.indexOf("if (path==='/api/native-push-subscribe'")));
  assert.match(nativeRoute, /await postgresStore\.upsertConversationMember\(d\.code, m\.slot, d\.token, m/);
  const pushRoute = server.slice(server.indexOf("if (path==='/api/push-subscribe'"), server.indexOf("// POST \/api\/push-unsubscribe", server.indexOf("if (path==='/api/push-subscribe'")));
  assert.match(pushRoute, /await postgresStore\.upsertConversationMember\(d\.code, m\.slot, d\.token, m/);
});

test('Android builds the notification itself and reports delivery for a data-only message, using the room token from NativeCallRoomStore (not the WebView)', () => {
  assert.match(android, /String msgId = safe\(data\.get\("msgId"\)\);/);
  assert.match(android, /if \(!msgId\.isEmpty\(\)\) \{\s*\n\s*showMessageNotification\(data\);\s*\n\s*reportMessageDelivered\(safe\(data\.get\("code"\)\), msgId\);/);
  assert.match(android, /private void showMessageNotification\(Map<String, String> data\)/);
  assert.match(android, /private void reportMessageDelivered\(String code, String msgId\)/);
  assert.match(android, /NativeCallRoomStore\.Room room = new NativeCallRoomStore\(this\)\.byCode\(code\);/);
  assert.match(android, /new URL\("https:\/\/vaultlix\.com\/api\/mark-delivered"\)/);
  assert.match(android, /new JSONObject\(\)\.put\("code", code\)\.put\("token", room\.token\)\.put\("msgId", msgId\)/);
  assert.match(android, /NativeCallRoomStore\.Room savedRoom = new NativeCallRoomStore\(this\)\.byCode\(code\);/);
  assert.match(android, /if \(hidePreview\) \{[\s\S]{0,120}body = "New message";[\s\S]{0,180}body = "New message from " \+ savedRoom\.peerName;/);
  // Best-effort: never lets a network failure here throw out of
  // onMessageReceived or block the notification from showing.
  assert.match(android, /reportMessageDelivered\(safe\(data\.get\("code"\)\), msgId\);\s*\n\s*return;/);
});

test('mark-delivered stays the shared server endpoint both sw.js (web push) and Android now call', () => {
  assert.match(server, /if \(path==='\/api\/mark-delivered' && method==='POST'\)/);
  const serviceWorker = fs.readFileSync(path.join(__dirname, '..', 'client', 'sw.js'), 'utf8');
  assert.match(serviceWorker, /fetch\('\/api\/mark-delivered'/);
});

// Isolated run of the real sendApnsNotification against a stubbed http2
// client — proves the actual mutable-content branching, not just a regex.
// capturedBody is closed over by the OUTER-realm stub functions assigned
// onto the vm context; that closure works fine across the realm boundary
// even though the vm calls into it, so no JSON round-trip trick is needed
// here the way it is for cross-realm object comparisons elsewhere.
async function buildApnsRequestBody(parsed) {
  let capturedBody = null;
  const context = {
    APNS_CONFIGURED: true,
    APNS_HOST: 'https://api.push.apple.com',
    APNS_BUNDLE_ID: 'com.vaultlix.app',
    getApnsJwt: () => 'fake-jwt',
    setImmediate,
    Buffer, // not available by default inside a vm sandbox; the real function needs it for content-length
    http2: {
      connect: () => ({
        request: () => {
          const req = {
            on(event, cb) {
              if (event === 'response') cb({ ':status': 200 });
              if (event === 'end') setImmediate(cb);
              return req;
            },
            end(body) { capturedBody = body; },
          };
          return req;
        },
        setTimeout: () => {},
        on: () => {},
        close: () => {},
      }),
    },
  };
  vm.createContext(context);
  vm.runInContext(extractToneHelpers() + extract('sendApnsNotification'), context);
  await vm.runInContext(`sendApnsNotification({apnsToken:'tok'}, ${JSON.stringify(JSON.stringify(parsed))}, 60)`, context);
  return JSON.parse(capturedBody);
}

test('a regular chat message push sets mutable-content:1 so iOS actually invokes VaultlixNotificationService', async () => {
  const body = await buildApnsRequestBody({ title: 'Vaultlix', body: 'New message from Alex', code: 'room1', msgId: 'msg123' });
  assert.equal(body.aps['mutable-content'], 1);
  assert.equal(body.aps['content-available'], 1);
  assert.equal(body.code, 'room1');
  assert.equal(body.msgId, 'msg123');
});

test('a call push does not set mutable-content (unchanged behavior — calls have their own handling)', async () => {
  const body = await buildApnsRequestBody({ isCall: true, code: 'room1', caller: 'Alex' });
  assert.equal(body.aps['mutable-content'], undefined);
  assert.equal(body.aps['content-available'], undefined);
});

test('a push with no msgId (e.g. a connection request) does not set mutable-content', async () => {
  const body = await buildApnsRequestBody({ title: 'Vaultlix', body: 'New connection request', connectionRequest: true, requestId: 'req1' });
  assert.equal(body.aps['mutable-content'], undefined);
});

test('an app announcement invokes the iOS service extension and carries its thumbnail URL', async () => {
  const thumbnailUrl = 'https://vaultlix.com/icons/icon-192.png';
  const body = await buildApnsRequestBody({ title:'Vaultlix update', body:'A new update is ready.', announcement:true, thumbnailUrl });
  assert.equal(body.aps['mutable-content'], 1);
  assert.equal(body.aps['content-available'], undefined);
  assert.equal(body.thumbnailUrl, thumbnailUrl);
});

test('the iOS extension only attaches small Vaultlix HTTPS icon assets', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'VaultlixNotificationService', 'NotificationService.swift'), 'utf8');
  assert.match(source, /url\.scheme == "https"/);
  assert.match(source, /url\.host == "vaultlix\.com"/);
  assert.match(source, /url\.path\.hasPrefix\("\/icons\/"\)/);
  assert.match(source, /size > 0, size <= 2_000_000/);
  assert.match(source, /UNNotificationAttachment/);
});

test('a private-group push forwards groupId/privateGroup so the client can navigate to it on tap', async () => {
  const body = await buildApnsRequestBody({ title: 'Vaultlix', body: 'New encrypted group message', privateGroup: true, groupId: 'grp1' });
  assert.equal(body.privateGroup, true);
  assert.equal(body.groupId, 'grp1');
});

test('groupId is never forwarded for a non-group push, even if a caller accidentally set it', async () => {
  const body = await buildApnsRequestBody({ title: 'Vaultlix', body: 'New connection request', connectionRequest: true, requestId: 'req1', groupId: 'leaked' });
  assert.equal(body.privateGroup, false);
  assert.equal(body.groupId, '');
});

test('the Notification Service Extension target exists, is embedded, and is registered under the app team', () => {
  const pbxproj = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
  assert.match(pbxproj, /VaultlixNotificationService/);
  assert.match(pbxproj, /PRODUCT_BUNDLE_IDENTIFIER = com\.vaultlix\.app\.NotificationService/);
  assert.match(pbxproj, /DEVELOPMENT_TEAM = 3KLX2S84MV/);
  assert.match(pbxproj, /Embed Foundation Extensions/);
});

test('iOS extension reads the room token via a shared keychain access group, not the WebView', () => {
  const appEntitlements = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'App.entitlements'), 'utf8');
  const extEntitlements = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'VaultlixNotificationService', 'VaultlixNotificationService.entitlements'), 'utf8');
  const sharedGroup = '$(AppIdentifierPrefix)com.vaultlix.app';
  // Both targets must list the identical group string, and it must be the
  // app's own default identifier (TeamID.com.vaultlix.app) — anything else
  // would be a NEW group that existing keychain items were never saved
  // under, breaking the already-live native-call-answering feature this
  // store also backs.
  assert.match(appEntitlements, /keychain-access-groups/);
  assert.ok(appEntitlements.includes(sharedGroup));
  assert.match(extEntitlements, /keychain-access-groups/);
  assert.ok(extEntitlements.includes(sharedGroup));

  const store = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'NativeCallRoomStore.swift'), 'utf8');
  assert.match(store, /private let accessGroup = "3KLX2S84MV\.com\.vaultlix\.app"/);
  assert.match(store, /func room\(code: String\) -> NativeCallRoom\?/);
  // The existing handle-based save/lookup, used by the already-live call
  // flow, must remain present and unchanged in shape.
  assert.match(store, /func save\(_ room: NativeCallRoom\) -> Bool/);
  assert.match(store, /func room\(handle: String\) -> NativeCallRoom\?/);

  const engine = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'NativeWebRTCCallEngine.swift'), 'utf8');
  assert.match(engine, /NativeCallRoomStore\.shared\.room\(handle: roomHandle\)/);
});

test('the extension itself calls mark-delivered with the code-derived room token, and never blocks delivery on failure', () => {
  const nse = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'VaultlixNotificationService', 'NotificationService.swift'), 'utf8');
  assert.match(nse, /class NotificationService: UNNotificationServiceExtension/);
  assert.match(nse, /NativeCallRoomStore\.shared\.room\(code: code\)/);
  assert.match(nse, /URL\(string: "https:\/\/vaultlix\.com\/api\/mark-delivered"\)/);
  assert.match(nse, /"code": code, "token": room\.token, "msgId": msgId/);
  // guard-else always falls through to completion()/deliver() — a missing
  // token, a bad URL, or the network call itself must never leave the
  // notification undelivered.
  assert.match(nse, /guard let room = NativeCallRoomStore\.shared\.room\(code: code\),\s*\n\s*let url = URL\(string: "https:\/\/vaultlix\.com\/api\/mark-delivered"\) else \{\s*\n\s*completion\(\)/);
  assert.match(nse, /override func serviceExtensionTimeWillExpire\(\)/);
});

test('the iOS app reports delivery from a content-available push even when alert surfaces are disabled', () => {
  const appDelegate = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
  assert.match(appDelegate, /didReceiveRemoteNotification userInfo:[\s\S]*userInfo\["code"\][\s\S]*userInfo\["msgId"\][\s\S]*reportMessageDelivered\(code: code, msgId: msgId\)/);
  assert.match(appDelegate, /private func reportMessageDelivered\(code: String, msgId: String/);
  assert.match(appDelegate, /NativeCallRoomStore\.shared\.room\(code: code\)/);
  assert.match(appDelegate, /URL\(string: "https:\/\/vaultlix\.com\/api\/mark-delivered"\)/);
  assert.match(appDelegate, /"code": code, "token": room\.token, "msgId": msgId/);
  assert.match(appDelegate, /completionHandler\(reported \? \.newData : \.noData\)/);
});

'use strict';

// Settings -> Message sound: a picker of bundled tones. The in-app sound plays the
// chosen tone; for the lock screen the device sends its choice with its push
// registration and the server names the matching sound in the APNs payload / the
// Android notification channel. The ids must agree everywhere or a push would name
// a sound that is not in the app bundle (iOS then plays nothing).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const server = read('server', 'index.js');
const client = read('client', 'index.html');
const android = read('mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'VaultlixMessagingService.java');
const pbxproj = read('mobile', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

const FILE_TONES = ['glow', 'bright', 'sweet', 'notify', 'soft', 'whistle', 'triplet', 'ripple', 'spark', 'lantern', 'harp', 'marimba', 'droplet'];

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start !== -1 && end !== -1, `${startMarker} block missing`);
  return source.slice(start, end);
}

function serverTone() {
  const context = vm.createContext({});
  vm.runInContext(extractBlock(server, 'const MESSAGE_TONE_IDS = new Set([', 'function sendApnsNotification('), context);
  return context;
}

test('the server accepts only known tone ids and falls back to the default, Glow', () => {
  const { normalizeMessageTone, storedMessageTone } = serverTone();
  for (const id of ['chime', 'none', ...FILE_TONES]) assert.equal(normalizeMessageTone(id), id);
  for (const bad of ['../../etc/passwd', 'vault_note', '', null, undefined, 7, {}, 'GLOW']) assert.equal(normalizeMessageTone(bad), 'glow');
  assert.equal(storedMessageTone('glow'), undefined, 'the default is not stored');
  assert.equal(storedMessageTone('bogus'), undefined);
  assert.equal(storedMessageTone('chime'), 'chime', 'the original chime is a real, stored choice');
  assert.equal(storedMessageTone('harp'), 'harp');
});

async function apnsPayload(member, parsed) {
  let captured = null;
  const context = {
    APNS_CONFIGURED: true, APNS_HOST: 'https://api.push.apple.com', APNS_BUNDLE_ID: 'com.vaultlix.app',
    getApnsJwt: () => 'jwt', setImmediate, Buffer,
    http2: { connect: () => ({ request: () => { const req = { on(event, cb) { if (event === 'response') cb({ ':status': 200 }); if (event === 'end') setImmediate(cb); return req; }, end(body) { captured = body; } }; return req; }, setTimeout() {}, on() {}, close() {} }) },
  };
  vm.createContext(context);
  vm.runInContext(extractBlock(server, 'const MESSAGE_TONE_IDS = new Set([', 'function validateVoipToken(') .split('function sendMemberPush')[0], context);
  const apns = extractBlock(server, 'function sendApnsNotification(', '\nfunction ');
  vm.runInContext(apns, context);
  await vm.runInContext(`sendApnsNotification(${JSON.stringify(member)}, ${JSON.stringify(JSON.stringify(parsed))}, 60)`, context);
  return JSON.parse(captured);
}

test('an iOS message push names the sound of the tone the device chose', async () => {
  const message = { code:'room', msgId:'m1', title:'Vaultlix', body:'New message' };
  assert.equal((await apnsPayload({ apnsToken:'tok' }, message)).aps.sound, 'vault_tone_glow.caf', 'no choice = the default tone');
  assert.equal((await apnsPayload({ apnsToken:'tok', tone:'harp' }, message)).aps.sound, 'vault_tone_harp.caf');
  assert.equal((await apnsPayload({ apnsToken:'tok', tone:'chime' }, message)).aps.sound, 'vault_chime.caf');
  assert.equal((await apnsPayload({ apnsToken:'tok', tone:'bogus' }, message)).aps.sound, 'vault_tone_glow.caf');
});

test('the silent choice sends no sound at all', async () => {
  const body = await apnsPayload({ apnsToken:'tok', tone:'none' }, { code:'room', msgId:'m1' });
  assert.equal('sound' in body.aps, false);
});

test('calls keep the standard sound whatever tone was chosen', async () => {
  const body = await apnsPayload({ apnsToken:'tok', tone:'harp' }, { code:'room', isCall:true });
  assert.equal(body.aps.sound, 'vault_chime.caf');
});

test('the Android push data carries the chosen tone', () => {
  assert.match(server, /msgId: String\(parsed\.msgId \|\| ''\),\s*tone: messageToneForPush\(member, 'android'\),/);
});

test('both native registration routes store the tone, in the live record and in what is persisted', () => {
  assert.match(server, /m\.fcmToken = deviceToken;\s*m\.fcmTone = storedMessageTone\(d\.tone\);/);
  assert.match(server, /m\.apnsEnvironment = d\.environment;\s*m\.apnsTone = storedMessageTone\(d\.tone\);/);
  assert.equal((server.match(/tone:storedMessageTone\(d\.tone\) \}/g) || []).length, 2, 'account destinations (create)');
  assert.equal((server.match(/tone:storedMessageTone\(destination\.tone\) \}\] : \[\]/g) || []).length, 2, 'account destinations (reload)');
  const postgres = read('server', 'postgres.js');
  assert.match(postgres, /\.\.\.\(push\.tone \? \{ tone:push\.tone \} : \{\}\),/);
  assert.match(postgres, /tone:member\.tone \|\| undefined,/);
  assert.match(postgres, /apnsTone:member\.apnsTone \|\| undefined,\s*fcmTone:member\.fcmTone \|\| undefined,/);
  assert.match(postgres, /\.\.\.\(push\.apnsTone \? \{ apnsTone:push\.apnsTone \} : \{\}\),\s*\.\.\.\(push\.fcmTone \? \{ fcmTone:push\.fcmTone \} : \{\}\),/);
});

test('every tone id agrees across the client, the server and the Android service', () => {
  const clientIds = [...extractBlock(client, 'const MESSAGE_TONES = [', '];').matchAll(/id:'([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual([...clientIds].sort(), ['chime', 'none', ...FILE_TONES].sort());
  const serverIds = [...extractBlock(server, 'const MESSAGE_TONE_IDS = new Set([', ']);').matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual([...serverIds].sort(), [...clientIds].sort());
  const androidSwitch = extractBlock(android, 'private static String normalizeTone', 'private static String toneLabel');
  const androidIds = [...androidSwitch.matchAll(/case "([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual([...androidIds].sort(), ['chime', 'none', ...FILE_TONES].sort());
  assert.match(android, /DEFAULT_TONE = "glow"/);
  assert.match(server, /const DEFAULT_MESSAGE_TONE = 'glow';/);
  assert.match(client, /const DEFAULT_MESSAGE_TONE = 'glow';/);
});

test('every tone ships as a web mp3, an iOS caf registered in the Xcode project, and an Android raw resource', () => {
  for (const id of FILE_TONES) {
    assert.ok(fs.statSync(path.join(root, 'client', 'tones', `${id}.mp3`)).size > 1000, `${id}.mp3`);
    assert.ok(fs.statSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'res', 'raw', `vault_tone_${id}.wav`)).size > 1000, `${id} android`);
    assert.ok(fs.statSync(path.join(root, 'mobile', 'ios', 'App', 'App', 'Sounds', `vault_tone_${id}.caf`)).size > 1000, `${id} ios`);
    assert.match(pbxproj, new RegExp(`/\\* vault_tone_${id}\\.caf in Resources \\*/ = \\{isa = PBXBuildFile;`), `${id} build file`);
    assert.match(pbxproj, new RegExp(`path = App/Sounds/vault_tone_${id}\\.caf;`), `${id} file reference`);
  }
});

test('Android uses one notification channel per tone and keeps the original channel for the default', () => {
  assert.match(android, /TONE_CHANNEL_PREFIX = "vaultlix_messages_tone_"/);
  assert.match(android, /if \("chime"\.equals\(tone\)\) \{\s*ensureMessageChannel\(manager\);\s*return MESSAGE_CHANNEL_ID;/);
  assert.match(android, /getIdentifier\("vault_tone_" \+ tone, "raw", getPackageName\(\)\)/);
  assert.equal((android.match(/String channelId = ensureMessageChannel\(manager, chosenTone\(data\)\);/g) || []).length, 2, '1:1 and group message notifications');
  assert.equal((android.match(/new NotificationCompat\.Builder\(this, channelId\)/g) || []).length, 2);
});

function clientHarness({ native = true, stored = null, result = () => ({ ok:true }) } = {}) {
  const calls = [], previews = [], timers = [], store = new Map(stored ? [['vaultlix_message_tone', stored]] : []);
  const context = vm.createContext({
    localStorage: { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value) },
    document: { getElementById: () => null }, calls, previews, store, timers,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared:false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    rooms: new Map([['r1', { code:'r1' }], ['r2', { code:'r2' }]]),
    window: {}, isNativeApp: () => native,
    registerNativeTokenForAccount: async () => { calls.push('account'); return result(); },
    registerNativeTokenForRoom: async room => { calls.push(`room:${room.code}`); return result(); },
    playMessageTonePreview: id => previews.push(id), renderMessageToneList: () => {}, updateMessageToneStatus: () => {},
  });
  const source = extractBlock(client, "const MESSAGE_TONE_KEY = 'vaultlix_message_tone';", '// The floating Chats/Calls bar is hidden while the search box has the keyboard');
  vm.runInContext(source.replace(/function (renderMessageToneList|updateMessageToneStatus)\(\) \{[\s\S]*?\n\}\n/g, ''), context);
  timers.length = 0; // the start-up hand-off to the Android bridge is not part of these scenarios
  context.pending = () => timers.filter(timer => !timer.cleared);
  context.flush = async () => { const timer = context.pending().pop(); if (timer) { timer.cleared = true; await timer.fn(); } };
  return context;
}

test('the chosen tone is remembered, defaults to Glow, and ignores junk in storage', () => {
  assert.equal(clientHarness().selectedMessageTone(), 'glow');
  assert.equal(clientHarness({ stored:'harp' }).selectedMessageTone(), 'harp');
  assert.equal(clientHarness({ stored:'chime' }).selectedMessageTone(), 'chime');
  assert.equal(clientHarness({ stored:'../x' }).selectedMessageTone(), 'glow');
});

test('choosing a tone saves it and previews it at once, then tells the server in a single debounced sync', async () => {
  const harness = clientHarness();
  harness.chooseMessageTone('marimba');
  assert.equal(harness.store.get('vaultlix_message_tone'), 'marimba');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.previews)), ['marimba']);
  assert.equal(harness.calls.length, 0, 'nothing is registered until the taps settle');
  assert.equal(harness.pending().length, 1);
  assert.equal(harness.pending()[0].ms, 800);
  await harness.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls)), ['account', 'room:r1', 'room:r2']);
});

test('auditioning several tones in a row sends ONE registration per conversation, not one per tap', async () => {
  // The server answers 429 after 10 registrations a minute per conversation; one per tap
  // used to exhaust that and the final choice was never stored.
  const harness = clientHarness();
  for (const id of ['glow', 'bright', 'sweet', 'notify', 'soft', 'whistle', 'triplet', 'ripple', 'spark', 'lantern', 'harp', 'marimba']) harness.chooseMessageTone(id);
  assert.equal(harness.pending().length, 1, 'each tap replaces the pending sync');
  await harness.flush();
  assert.equal(harness.calls.filter(call => call === 'room:r1').length, 1);
  assert.equal(harness.store.get('vaultlix_message_tone'), 'marimba');
});

test('a sync the server rejects is retried, and gives up after a few tries', async () => {
  const harness = clientHarness({ result:() => ({ error:'Too many notification registrations.' }) });
  harness.chooseMessageTone('harp');
  await harness.flush();
  assert.equal(harness.pending().length, 1, 'a retry is scheduled');
  assert.equal(harness.pending()[0].ms, 20000);
  for (let i = 0; i < 6; i++) await harness.flush();
  assert.equal(harness.pending().length, 0, 'it stops retrying');
  assert.equal(harness.calls.filter(call => call === 'account').length, 5, 'first try plus four retries');
});

test('a successful retry stops retrying, and a newer choice supersedes a pending retry', async () => {
  let fail = true;
  const harness = clientHarness({ result:() => (fail ? { error:'429' } : { ok:true }) });
  harness.chooseMessageTone('harp');
  await harness.flush();
  fail = false;
  await harness.flush();
  assert.equal(harness.pending().length, 0);
  fail = true;
  harness.chooseMessageTone('spark');
  await harness.flush();
  harness.chooseMessageTone('droplet'); // supersedes the retry scheduled for 'spark'
  assert.equal(harness.pending().length, 1);
  assert.equal(harness.pending()[0].ms, 800);
});

test('re-choosing the same tone previews it but does not re-register; browsers never register', () => {
  const same = clientHarness({ stored:'harp' });
  same.chooseMessageTone('harp');
  assert.equal(same.previews.length, 1);
  assert.equal(same.pending().length, 0);
  const web = clientHarness({ native:false });
  web.chooseMessageTone('spark');
  assert.equal(web.pending().length, 0);
  web.chooseMessageTone('not-a-tone');
  assert.equal(web.store.get('vaultlix_message_tone'), 'spark', 'unknown ids are ignored');
});

test('closing the picker sends a pending sync straight away instead of waiting out the debounce', () => {
  assert.match(client, /function closeMessageTonePicker\(\) \{[\s\S]*?if \(messageToneSyncTimer\) syncMessageToneToServer\(\{ immediate:true \}\);/);
});

test('the registration helpers return the server answer so a rejection can be seen', () => {
  assert.match(client, /return api\('\/api\/native-push-subscribe', \{/);
  assert.match(client, /return api\('\/api\/account\/native-push-subscribe', \{/);
});

test('the in-app sound follows the choice: None is silent, others load their own file', () => {
  assert.match(client, /function prepareChime\(\) \{\s*const id = selectedMessageTone\(\);\s*return id === 'none' \? Promise\.resolve\(null\) : prepareTone\(id\);/);
  assert.match(client, /function messageToneUrl\(id\) \{\s*return id === 'chime' \? '\/vault_chime\.mp3' : `\/tones\/\$\{id\}\.mp3`;/);
});

test('Glow is marked as the default in the picker and is available offline', () => {
  assert.match(client, /\{ id:'glow', name:'Glow', note:'default' \}/);
  assert.doesNotMatch(client, /id:'chime', name:'Vaultlix', note/);
  assert.match(read('client', 'sw.js'), /'\/tones\/glow\.mp3'/);
});

test('every native registration sends the tone, and Settings lists the Message sound row', () => {
  assert.equal((client.match(/tone: selectedMessageTone\(\),/g) || []).length, 2);
  assert.match(client, /id="settings-tone-row" onclick="openMessageTonePicker\(\)"/);
  assert.match(client, /notifications:\['settings-chime-row','settings-tone-row','settings-push-row'\]/);
  assert.match(client, /id="message-tone-overlay"/);
});

// The iPhone app draws Settings pages like iOS Settings (grouped white cards on a
// lilac page, plain rows, grey value + chevron, green switches). It must stay
// scoped to the iOS app and must not change the rows' ids or behaviour.
test('the grouped-list Settings style applies only inside the iPhone app', () => {
  const block = extractBlock(client, '/* iPhone app: Settings pages in the grouped-list style', 'input:checked ~ .toggle-thumb{transform:translateX(20px)}');
  const selectors = block.split('\n').filter(line => line.startsWith('html') || line.includes('{')).map(line => line.trim());
  assert.ok(selectors.length > 10);
  for (const line of selectors) if (line.includes('{')) assert.match(line, /^html\.vaultlix-native-ios #settings-panel/, line.slice(0, 80));
  assert.match(block, /#34C759/, 'green switch');
});

test('the last visible row of a Settings card carries the no-divider marker', () => {
  assert.match(client, /generalSection\.querySelectorAll\('\.settings-row\.ios-last'\)\.forEach\(row => row\.classList\.remove\('ios-last'\)\);/);
  assert.match(client, /lastShownRow\.classList\.add\('ios-last'\)/);
});

// With the Chats search box focused, the keyboard lifted the floating bottom bar on
// top of it (Android resizes the page, iOS lifts fixed elements).
test('the floating Chats bar is hidden while the search box has the keyboard', () => {
  assert.match(client, /html\.vault-search-typing \.vault-list-actions\{display:none!important\}/);
  assert.match(client, /document\.addEventListener\('focusin', event => \{\s*if \(event\.target\?\.id === 'vault-search-input'\) document\.documentElement\.classList\.add\('vault-search-typing'\);/);
  assert.match(client, /document\.addEventListener\('focusout', event => \{\s*if \(event\.target\?\.id === 'vault-search-input'\) document\.documentElement\.classList\.remove\('vault-search-typing'\);/);
  assert.match(client, /function closeVaultSearch\(\) \{\s*document\.documentElement\.classList\.remove\('vault-search-typing'\);/);
});

// One conversation member is shared by every device signed in to the account, with a
// separate APNs and FCM token. A single `tone` field meant the iPhone and the Android
// phone overwrote each other's choice (the one that registered last won for both).
test('the tone is chosen per platform on a shared member, falling back to the older shared field', () => {
  const { messageToneForPush } = serverTone();
  const member = { apnsTone:'harp', fcmTone:'triplet' };
  assert.equal(messageToneForPush(member, 'ios'), 'harp');
  assert.equal(messageToneForPush(member, 'android'), 'triplet');
  assert.equal(messageToneForPush({ apnsTone:'harp' }, 'android'), 'glow', 'the other platform keeps the default');
  assert.equal(messageToneForPush({ tone:'spark' }, 'ios'), 'spark', 'a member registered before this change');
  assert.equal(messageToneForPush({ tone:'spark', fcmTone:'harp' }, 'android'), 'harp');
  assert.equal(messageToneForPush({}, 'ios'), 'glow');
});

test('an iPhone and an Android phone sharing one conversation member keep their own tones', async () => {
  const preload = path.join(require('node:os').tmpdir(), `vaultlix-firebase-stub-${process.pid}.js`);
  fs.writeFileSync(preload, `const Module = require('module'); const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'firebase-admin/app') return { initializeApp: () => ({}), cert: () => ({}) };
  if (request === 'firebase-admin/messaging') return { getMessaging: () => ({ send: async message => { console.log('FCM_SEND ' + JSON.stringify(message)); return 'ok'; } }) };
  return load.call(this, request, ...rest);
};`);
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const webpush = require('web-push');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const vapid = webpush.generateVAPIDKeys();
  const snapshotDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vaultlix-tone-test-'));
  const child = spawn(process.execPath, ['-r', preload, 'server/index.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey, FIREBASE_SERVICE_ACCOUNT_JSON:'{"project_id":"x"}' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test server did not start')), 8000);
      const poll = setInterval(() => { if (output.includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 50);
      child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
    });
    const post = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
      return { status:response.status, data:await response.json().catch(() => ({})) };
    };
    const alice = (await post('/api/create', { name:'Alice', pubKey:'a', persistent:true })).data;
    const bob = (await post('/api/join', { name:'Bob', code:alice.code, pubKey:'b' })).data;
    const fcm = `${'f'.repeat(30)}:APA91b${'x'.repeat(40)}`;
    // Bob's Android phone chooses triplet; then his iPhone (same member) registers with another tone.
    assert.equal((await post('/api/native-push-subscribe', { code:alice.code, token:bob.token, deviceToken:fcm, platform:'android', tone:'triplet' })).status, 200);
    assert.equal((await post('/api/native-push-subscribe', { code:alice.code, token:bob.token, deviceToken:'a'.repeat(64), platform:'ios', environment:'production', tone:'harp' })).status, 200);
    assert.equal((await post('/api/send', { code:alice.code, token:alice.token, content:'x', msgId:'tonetest1' })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 400));
    const sent = output.split('\n').filter(line => line.startsWith('FCM_SEND')).map(line => JSON.parse(line.slice(9)));
    assert.equal(sent.at(-1)?.data?.tone, 'triplet', "the iPhone's registration must not overwrite the Android choice");
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(snapshotDir, { recursive:true, force:true });
    fs.rmSync(preload, { force:true });
  }
});

// Android posts a system notification for every message (with the chosen tone as its
// sound) even while the app is open, so the in-app chime doubled it.
test('Android plays no in-app message chime; iOS and the web keep it', () => {
  const notify = extractBlock(client, 'function notifyMsg(room) {', 'showCrossVaultMessage(room);');
  assert.match(notify, /if \(nativePlatform\(\) !== 'android'\) playChime\(\);/);
  assert.doesNotMatch(notify.replace(/if \(nativePlatform\(\) !== 'android'\) playChime\(\);/, ''), /playChime\(\)/);
});

test('returning to the app re-registers the tone, at most every ten minutes', () => {
  assert.match(client, /const MESSAGE_TONE_RESYNC_INTERVAL_MS = 10 \* 60 \* 1000;/);
  assert.match(client, /refreshPushForAllRooms\(\);\s*resyncMessageToneOnResume\(\);\s*reconnectSignalingForAllRooms\(\);/);
  const harness = clientHarness();
  harness.resyncMessageToneOnResume();
  assert.equal(harness.pending().length, 1, 'the first return registers');
  harness.pending()[0].cleared = true;
  harness.resyncMessageToneOnResume();
  assert.equal(harness.pending().length, 0, 'a second return within ten minutes does not');
  assert.equal(clientHarness({ native:false }).resyncMessageToneOnResume(), undefined);
});

// Android reports an already-dismissed permission as 'prompt-with-rationale'. The
// Settings row read "Tap to enable" but the tap was wired for 'prompt' only, so
// it did nothing and notifications stayed off.
test('the Push notifications tap works for every not-yet-decided Android permission state', () => {
  const canPrompt = vm.runInNewContext(`${extractBlock(client, 'function nativePushCanPrompt() {', 'function applyNativePushStatus')} nativePushCanPrompt`, { nativePushPermission:'prompt-with-rationale' });
  for (const [state, expected] of [['prompt', true], ['prompt-with-rationale', true], ['granted', false], ['denied', false]]) {
    const check = vm.runInNewContext(`${extractBlock(client, 'function nativePushCanPrompt() {', 'function applyNativePushStatus')} nativePushCanPrompt`, { nativePushPermission:state });
    assert.equal(check(), expected, state);
  }
  assert.equal(typeof canPrompt, 'function');
  assert.equal((client.match(/el\.onclick = nativePushCanPrompt\(\)/g) || []).length, 1, 'one place decides the tap handler');
  assert.doesNotMatch(client, /nativePushPermission === 'prompt' \? \(\) => requestPushPermission\(\)/);
  assert.match(client, /Turn on notifications in Android Settings → Apps → Vaultlix → Notifications\./);
});

// The Android phone keeps the chosen tone itself, so the lock-screen sound does not
// depend on the server's copy (which only arrives with a push registration).
const messageToneJava = read('mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MessageTone.java');
const mainActivity = read('mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java');

test('the Android phone stores the chosen tone locally and the notification uses it before the push', () => {
  assert.match(mainActivity, /@JavascriptInterface\s*public void setMessageTone\(String tone\) \{ MessageTone\.store\(MainActivity\.this, tone\); \}/);
  assert.match(android, /private String chosenTone\(Map<String, String> data\) \{\s*String local = MessageTone\.stored\(this\);\s*return local != null \? local : data\.get\("tone"\);/);
  assert.match(messageToneJava, /if \(context == null \|\| !isKnown\(tone\)\) return;/);
});

test('the locally stored tone accepts exactly the same ids as the server and the client', () => {
  const ids = [...extractBlock(messageToneJava, 'static boolean isKnown', 'default:').matchAll(/case "([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual([...ids].sort(), ['chime', 'none', ...FILE_TONES].sort());
});

test('the web layer hands every choice, and the current one at start and on resume, to the Android bridge', () => {
  assert.match(client, /try \{ window\.VaultlixAndroid\?\.setMessageTone\?\.\(selectedMessageTone\(\)\); \} catch \(e\) \{\}/);
  assert.match(client, /setTimeout\(syncMessageToneToNative, 500\);/);
  assert.match(client, /try \{ localStorage\.setItem\(MESSAGE_TONE_KEY, id\); \} catch \(e\) \{\}\s*syncMessageToneToNative\(\);/);
  assert.match(client, /function resyncMessageToneOnResume\(\) \{\s*syncMessageToneToNative\(\);/);
});

// A phone that reports the notification permission as undecided (or whose permission
// check or channel set-up throws) never registered its token, so the server never
// learned its tone and the push fell back to the default.
test('Android registers its push token whatever the permission check says, and set-up errors do not stop it', () => {
  assert.match(client, /try \{ await ensureAndroidNotificationChannels\(\); \} catch \(e\) \{\}/);
  assert.match(client, /if \(nativePushPermission === 'granted' \|\| nativePlatform\(\) === 'android'\) \{\s*try \{ await plugin\.register\(\); \} catch \(e\) \{\}/);
  assert.match(client, /if \(\(nativePushPermission === 'granted' \|\| nativePlatform\(\) === 'android'\) && nativePushToken\) await registerNativeTokenForRoom\(room\);/);
  assert.match(client, /toast\('Notifications are not available in this version of the app\.'\)/);
});

test('the Message chime switch is hidden in the Android app, where it controls nothing', () => {
  assert.match(client, /html\.vaultlix-native-android #settings-chime-row\{display:none!important\}/);
  assert.match(client, /id="settings-chime-row"/, 'the row still exists for iOS and the web');
  assert.match(client, /if \(nativePlatform\(\) !== 'android'\) playChime\(\);/);
});

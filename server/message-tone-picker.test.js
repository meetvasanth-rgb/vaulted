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
  assert.match(server, /msgId: String\(parsed\.msgId \|\| ''\),\s*tone: normalizeMessageTone\(member\.tone\),/);
});

test('both native registration routes store the tone, in the live record and in what is persisted', () => {
  assert.equal((server.match(/m\.tone = storedMessageTone\(d\.tone\);/g) || []).length, 2);
  assert.equal((server.match(/tone:storedMessageTone\(d\.tone\) \}/g) || []).length, 2, 'account destinations (create)');
  assert.equal((server.match(/tone:storedMessageTone\(destination\.tone\) \}\] : \[\]/g) || []).length, 2, 'account destinations (reload)');
  const postgres = read('server', 'postgres.js');
  assert.match(postgres, /\.\.\.\(push\.tone \? \{ tone:push\.tone \} : \{\}\),/);
  assert.match(postgres, /tone:member\.tone \|\| undefined,/);
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
  assert.equal((android.match(/String channelId = ensureMessageChannel\(manager, data\.get\("tone"\)\);/g) || []).length, 2, '1:1 and group message notifications');
  assert.equal((android.match(/new NotificationCompat\.Builder\(this, channelId\)/g) || []).length, 2);
});

function clientHarness({ native = true, stored = null } = {}) {
  const calls = [], previews = [], store = new Map(stored ? [['vaultlix_message_tone', stored]] : []);
  const context = vm.createContext({
    localStorage: { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value) },
    document: { getElementById: () => null }, calls, previews, store,
    isNativeApp: () => native,
    registerNativeTokenForAccount: async () => calls.push('account'),
    registerNativeTokenForAllRooms: async () => calls.push('rooms'),
    playMessageTonePreview: id => previews.push(id), renderMessageToneList: () => {}, updateMessageToneStatus: () => {},
  });
  const source = extractBlock(client, "const MESSAGE_TONE_KEY = 'vaultlix_message_tone';", 'document.addEventListener(\'click\', event => {\n  const row = event.target?.closest?.(\'#message-tone-list');
  vm.runInContext(source.replace(/function (renderMessageToneList|updateMessageToneStatus)\(\) \{[\s\S]*?\n\}\n/g, ''), context);
  return context;
}

test('the chosen tone is remembered, defaults to Glow, and ignores junk in storage', () => {
  assert.equal(clientHarness().selectedMessageTone(), 'glow');
  assert.equal(clientHarness({ stored:'harp' }).selectedMessageTone(), 'harp');
  assert.equal(clientHarness({ stored:'chime' }).selectedMessageTone(), 'chime');
  assert.equal(clientHarness({ stored:'../x' }).selectedMessageTone(), 'glow');
});

test('choosing a tone saves it, previews it, and re-registers the device so the server learns it', () => {
  const harness = clientHarness();
  harness.chooseMessageTone('marimba');
  assert.equal(harness.store.get('vaultlix_message_tone'), 'marimba');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.previews)), ['marimba']);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls)), ['account', 'rooms']);
});

test('re-choosing the same tone previews it but does not re-register; browsers never register', () => {
  const same = clientHarness({ stored:'harp' });
  same.chooseMessageTone('harp');
  assert.equal(same.previews.length, 1);
  assert.equal(same.calls.length, 0);
  const web = clientHarness({ native:false });
  web.chooseMessageTone('spark');
  assert.equal(web.calls.length, 0);
  web.chooseMessageTone('not-a-tone');
  assert.equal(web.store.get('vaultlix_message_tone'), 'spark', 'unknown ids are ignored');
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

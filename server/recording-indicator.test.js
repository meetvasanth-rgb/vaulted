'use strict';

// Like typing, the other person sees when a voice note is being recorded: their picture with a small
// bubble holding a pulsing red dot and a microphone, instead of the typing dots.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const webpush = require('web-push');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFunction(name) {
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

// ── Receiver ──
function indicatorHarness() {
  const avatar = { innerHTML:'', dataset:{} };
  let mic = null;
  const classes = new Set();
  const indicator = {
    classList:{ toggle: (name, on) => { on ? classes.add(name) : classes.delete(name); } },
    querySelector: selector => selector === '#typing-avatar' ? avatar : (selector === '.peer-typing-mic' ? mic : null),
    appendChild: child => { mic = child; },
    label:'', setAttribute(name, value) { if (name === 'aria-label') this.label = value; },
  };
  const context = vm.createContext({
    document: { getElementById: id => id === 'typing-indicator' ? indicator : null, createElement: () => ({ className:'', innerHTML:'' }) },
    displayProfileImageUri: () => null, escapeHtml: value => String(value), roomDisplayLabel: room => room.peerName,
    getActiveRoom: () => ({ peerName:'Active' }), Array,
  });
  vm.runInContext(extractFunction('typingAvatarHtml') + '\n' + extractFunction('showTypingIndicator'), context);
  return { context, indicator, classes, getMic: () => mic };
}

test('recording swaps the dots for a microphone bubble; typing keeps the dots', () => {
  const h = indicatorHarness();
  h.context.showTypingIndicator(true, { peerName:'Velvet' }, 'recording');
  assert.equal(h.classes.has('show'), true);
  assert.equal(h.classes.has('recording'), true);
  assert.equal(h.indicator.label, 'Recording a voice note');
  assert.match(h.getMic().innerHTML, /<i><\/i><svg[^>]*><rect x="9" y="3"/);
  h.context.showTypingIndicator(true, { peerName:'Velvet' }, 'typing');
  assert.equal(h.classes.has('recording'), false);
  assert.equal(h.indicator.label, 'Typing');
  h.context.showTypingIndicator(true, { peerName:'Velvet' });
  assert.equal(h.classes.has('recording'), false, 'no activity means plain typing');
});

test('hiding removes the recording look too, and an older server (no activity) still shows typing', () => {
  const h = indicatorHarness();
  h.context.showTypingIndicator(true, { peerName:'V' }, 'recording');
  h.context.showTypingIndicator(false, { peerName:'V' }, 'recording');
  assert.equal(h.classes.has('show'), false);
  assert.equal(h.classes.has('recording'), false);
  const old = indicatorHarness();
  old.context.showTypingIndicator(true, { peerName:'V' }, undefined);
  assert.equal(old.classes.has('show'), true);
  assert.equal(old.classes.has('recording'), false);
});

test('the mic bubble is created once and styled like the typing bubble', () => {
  const h = indicatorHarness();
  h.context.showTypingIndicator(true, { peerName:'V' }, 'recording');
  const first = h.getMic();
  h.context.showTypingIndicator(true, { peerName:'V' }, 'recording');
  assert.equal(h.getMic(), first);
  assert.match(client, /\.typing-indicator\.peer-typing\.recording \.peer-typing-dots\{display:none\}/);
  assert.match(client, /\.typing-indicator\.peer-typing\.recording \.peer-typing-mic\{display:flex\}/);
  assert.match(client, /@keyframes recording-pulse/);
});

// ── Sender ──
test('while recording, a sign of life is sent every two seconds, to the room being recorded in', () => {
  const calls = [];
  const room = { code:'room-1', token:'tok-1' };
  const context = vm.createContext({
    voiceActivityRoom:room, voiceActivitySentAt:0, RECORDING_ACTIVITY_INTERVAL_MS:2000, Date,
    api: (route, body) => { calls.push([route, body]); return Promise.resolve({}); },
  });
  vm.runInContext(extractFunction('sendRecordingActivity'), context);
  assert.equal(context.sendRecordingActivity(10_000), true);
  assert.equal(context.sendRecordingActivity(10_200), false, 'the 200ms timer tick does not flood');
  assert.equal(context.sendRecordingActivity(11_900), false);
  assert.equal(context.sendRecordingActivity(12_000), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['/api/typing', { code:'room-1', token:'tok-1', activity:'recording' }],
    ['/api/typing', { code:'room-1', token:'tok-1', activity:'recording' }],
  ]);
  context.voiceActivityRoom = null;
  assert.equal(context.sendRecordingActivity(20_000), false, 'nothing without a room');
});

test('the heartbeat rides the recording timer, so it stops the moment recording does', () => {
  const start = extractFunction('startVoiceRecording');
  assert.match(start, /voiceActivityRoom = room;\s*voiceActivitySentAt = 0;\s*voiceTimerInterval = setInterval\(\(\) => \{[\s\S]*?sendRecordingActivity\(\);/);
  // Sending, cancelling and stopping all clear that timer.
  for (const name of ['stopVoiceRecording', 'cancelVoiceRecording', 'finishVoiceRecording']) {
    assert.match(extractFunction(name), /clearInterval\(voiceTimerInterval\)/);
  }
});

// ── Server ──
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const post = async (base, route, body) => {
  const response = await fetch(base + route, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  return { status:response.status, data:await response.json() };
};

test('the server tells the other member typing vs recording, and it expires', { timeout:30000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'vaultlix-recording-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:path.join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive:true, force:true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 8000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const created = (await post(base, '/api/create', { name:'Alice', pubKey:'alice-key' })).data;
  const joined = (await post(base, '/api/join', { name:'Bob', code:created.code, pubKey:'bob-key' })).data;
  assert.ok(created.token && joined.token);
  const alice = { code:created.code, token:created.token }, bob = { code:created.code, token:joined.token };
  const seenByBob = async () => (await post(base, '/api/check_typing', bob)).data;
  const seenByAlice = async () => (await post(base, '/api/check_typing', alice)).data;

  assert.deepEqual(await seenByBob(), { typing:false });
  await post(base, '/api/typing', alice);
  assert.deepEqual(await seenByBob(), { typing:true, activity:'typing' });
  await post(base, '/api/typing', { ...alice, activity:'recording' });
  assert.deepEqual(await seenByBob(), { typing:true, activity:'recording' });
  await post(base, '/api/typing', { ...alice, activity:'<script>' });
  assert.deepEqual(await seenByBob(), { typing:true, activity:'typing' }, 'anything but "recording" is ordinary typing');
  await post(base, '/api/typing', { ...alice, activity:'recording' });
  assert.deepEqual(await seenByAlice(), { typing:false }, 'you never see your own activity');
  // A non-member cannot read or set it.
  assert.deepEqual((await post(base, '/api/check_typing', { code:created.code, token:'stranger' })).data, { typing:false });
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.deepEqual(await seenByBob(), { typing:false }, 'it lapses three seconds after the last sign of life');
});

test('the inbox status poll and the live message carry the activity as well', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /const activity = peerActivity\(room, item\.token\);\s*const typing = activity !== null;/);
  assert.match(server, /typing,\s*\.\.\.\(activity \? \{ activity \} : \{\}\),/);
  assert.match(server, /payload:\{ active:true, activity:m\.typingActivity \}/);
  assert.match(server, /m\.typingActivity = d\.activity === 'recording' \? 'recording' : 'typing';/);
});

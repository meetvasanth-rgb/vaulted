'use strict';

// A received voice note could be silent with a correct timer: every note was captured into a Web Audio
// graph, and when iOS suspends or interrupts that context the element keeps playing (and counting)
// without any sound. Now only genuinely quiet notes use the graph, only when its context is running,
// and a graph that is not running is replaced by a plain element.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFunction(name, prefix) {
  const start = client.indexOf(`${prefix} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

// samples: Float32Array the fake decoder returns. contextState: what the fake AudioContext reports.
function harness({ samples = new Float32Array(1000).fill(0.2), contextState = 'running', decodeFails = false, nativeIOS = false } = {}) {
  const contexts = [], audios = [], toasts = [], timers = [], icons = [];
  class FakeContext {
    constructor() { this.state = 'suspended'; this.sources = 0; this.closed = false; contexts.push(this); }
    resume() { this.state = contextState; return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    decodeAudioData() {
      if (decodeFails) return Promise.reject(new Error('unsupported'));
      return Promise.resolve({ numberOfChannels:1, getChannelData: () => samples, duration:samples.length / 16000 });
    }
    createMediaElementSource() { this.sources++; const node = { connect: () => node }; return node; }
    createGain() { const g = { gain:{ value:1 }, connect: () => g }; this.gainNode = g; return g; }
    createDynamicsCompressor() { const c = { threshold:{}, knee:{}, ratio:{}, attack:{}, release:{}, connect: () => c }; return c; }
    get destination() { return {}; }
  }
  class FakeAudio {
    constructor(src) { this.src = src; this.paused = true; this.ended = false; this.currentTime = 0; this.readyState = 4; this.muted = false; this.volume = 1; this.duration = 5; this.listeners = {}; this.listenerLists = {}; this.loads = 0; audios.push(this); }
    addEventListener(type, fn) { const list = this.listenerLists[type] ||= []; list.push(fn); this.listeners[type] = () => list.slice().forEach(listener => listener()); }
    removeEventListener(type, fn) { const list = this.listenerLists[type] || []; this.listenerLists[type] = list.filter(listener => listener !== fn); this.listeners[type] = () => this.listenerLists[type].slice().forEach(listener => listener()); }
    load() { this.loads++; }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const context = vm.createContext({
    window: { AudioContext: FakeContext }, Audio: FakeAudio, Map, WeakMap, Date, Math, Uint8Array, Number,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    safeVoiceDataUri: (mime, base64) => `data:${mime};base64,${base64}`,
    updateVoiceProgress: () => {}, finishVoicePlayback: () => {},
    toast: message => toasts.push(message),
    isNativeIOS: () => nativeIOS,
    setVoicePlayIcon: (id, playing) => icons.push([id, playing]),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    voiceAudioEls: new Map(), voicePlaybackGraphs: new WeakMap(), currentlyPlayingVoiceId: null,
  });
  const source = [
    client.slice(client.indexOf('const VOICE_QUIET_RMS'), client.indexOf('\n', client.indexOf('const VOICE_QUIET_RMS'))),
    'const voiceLoudnessCache = new Map(); const voiceTrace = [];',
    'const voiceTimelineOffsets = new WeakMap();',
    extractFunction('traceVoicePlayback', 'function'),
    extractFunction('replaceVoiceAudioWithPlain', 'function'),
    extractFunction('prepareQuietVoicePlayback', 'async function'),
    extractFunction('watchVoiceAudible', 'function'),
    extractFunction('voiceTimelineOffset', 'function'),
    extractFunction('alignVoiceTimeline', 'function'),
    extractFunction('waitForVoiceMetadata', 'function'),
    extractFunction('getOrCreateVoiceAudio', 'function'),
  ].join('\n');
  vm.runInContext(source, context);
  const rec = { id:'v1', kind:'voice', mime:'audio/mp4', base64:'AAAA', duration:5 };
  return { context, contexts, audios, toasts, timers, icons, rec };
}

const loud = new Float32Array(2000).fill(0.3);     // rms 0.3: an ordinary recording
const quiet = new Float32Array(2000).fill(0.02);   // rms 0.02: unusually quiet speech

test('native iOS always plays the plain media element and never creates a Web Audio graph', async () => {
  const h = harness({ samples:quiet, nativeIOS:true });
  const audio = vm.runInContext('getOrCreateVoiceAudio', h.context)(h.rec);
  const used = await h.context.prepareQuietVoicePlayback(audio, h.rec);
  assert.equal(used, audio);
  assert.equal(h.contexts.length, 0, 'iOS never creates an AudioContext for playback');
  assert.equal(vm.runInContext("voiceLoudnessCache.get('v1')", h.context), 'ios-plain');
  assert.equal(vm.runInContext('voiceTrace.at(-1).stage', h.context), 'ios-plain');
});

test('an inflated Android WebM timeline starts at its real audio segment on iOS', () => {
  const h = harness({ nativeIOS:true });
  h.rec.duration = 5;
  const audio = h.context.getOrCreateVoiceAudio(h.rec);
  audio.duration = 90.7;
  audio.listeners.loadedmetadata();
  assert.ok(Math.abs(audio.currentTime - 85.7) < 0.001);
  const offsets = vm.runInContext('voiceTimelineOffsets', h.context);
  assert.ok(Math.abs(offsets.get(audio) - 85.7) < 0.001);
});

test('cold playback waits until WebM metadata has resolved', async () => {
  const h = harness({ nativeIOS:true });
  const audio = h.context.getOrCreateVoiceAudio(h.rec);
  audio.readyState = 0;
  audio.duration = Number.NaN;
  const waiting = h.context.waitForVoiceMetadata(audio);
  assert.equal(audio.loads, 1);
  audio.readyState = 1;
  audio.duration = 90.7;
  audio.listeners.loadedmetadata();
  assert.equal(await waiting, true);
});

test('an ordinary recording plays on its plain element: no Web Audio capture at all', async () => {
  const h = harness({ samples:loud });
  const audio = vm.runInContext('getOrCreateVoiceAudio', h.context)(h.rec);
  const used = await h.context.prepareQuietVoicePlayback(audio, h.rec);
  assert.equal(used, audio);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].sources, 0, 'the element was never captured into a graph');
  assert.equal(h.contexts[0].closed, true);
});

test('a very quiet recording is lifted through the graph when the context is running', async () => {
  const h = harness({ samples:quiet, contextState:'running' });
  const audio = h.context.getOrCreateVoiceAudio(h.rec);
  assert.equal(await h.context.prepareQuietVoicePlayback(audio, h.rec), audio);
  assert.equal(h.contexts[0].sources, 1);
  assert.ok(h.contexts[0].gainNode.gain.value > 1 && h.contexts[0].gainNode.gain.value <= 6);
});

test('a quiet recording is NOT captured when the context is not running (it would play silently)', async () => {
  const h = harness({ samples:quiet, contextState:'suspended' });
  const audio = h.context.getOrCreateVoiceAudio(h.rec);
  assert.equal(await h.context.prepareQuietVoicePlayback(audio, h.rec), audio);
  assert.equal(h.contexts[0].sources, 0);
});

test('a note the browser cannot decode plays directly', async () => {
  const h = harness({ decodeFails:true });
  const audio = h.context.getOrCreateVoiceAudio(h.rec);
  assert.equal(await h.context.prepareQuietVoicePlayback(audio, h.rec), audio);
  assert.equal(h.contexts[0].sources, 0);
});

test('a captured note whose context stopped running is replaced by a plain element at the next tap, keeping its position', async () => {
  const h = harness({ samples:quiet, contextState:'running' });
  const first = h.context.getOrCreateVoiceAudio(h.rec);
  await h.context.prepareQuietVoicePlayback(first, h.rec);
  assert.equal(h.contexts[0].sources, 1);
  // iOS interrupts the context between plays; resume() no longer brings it back.
  h.contexts[0].resume = () => Promise.resolve();
  h.contexts[0].state = 'interrupted';
  first.currentTime = 2.5;
  const next = await h.context.prepareQuietVoicePlayback(first, h.rec);
  assert.notEqual(next, first);
  assert.equal(h.context.voiceAudioEls.get('v1'), next);
  assert.equal(h.contexts[0].closed, true);
  next.listeners.loadedmetadata();
  assert.equal(next.currentTime, 2.5);
  // The replacement is plain from now on.
  assert.equal(await h.context.prepareQuietVoicePlayback(next, h.rec), next);
  assert.equal(h.contexts.length, 1, 'no new graph is attempted');
});

test('the watchdog stops a captured note that is playing without sound and invites another tap', async () => {
  const h = harness({ samples:quiet, contextState:'running' });
  const audio = h.context.getOrCreateVoiceAudio(h.rec);
  await h.context.prepareQuietVoicePlayback(audio, h.rec);
  audio.play();
  h.context.currentlyPlayingVoiceId = 'v1';
  h.context.watchVoiceAudible(h.rec, audio);
  assert.equal(h.timers.length, 1);
  h.contexts[0].state = 'suspended'; // the context stopped running right after Play
  h.timers[0].fn();
  assert.equal(audio.paused, true);
  assert.deepEqual(h.toasts, ['Tap play again']);
  assert.deepEqual(h.icons.at(-1), ['v1', false]);
  assert.notEqual(h.context.voiceAudioEls.get('v1'), audio);
});

test('the watchdog leaves a healthy captured note, and a plain note, alone', async () => {
  const h = harness({ samples:quiet, contextState:'running' });
  const audio = h.context.getOrCreateVoiceAudio(h.rec);
  await h.context.prepareQuietVoicePlayback(audio, h.rec);
  audio.play();
  h.context.watchVoiceAudible(h.rec, audio);
  h.timers[0].fn();
  assert.equal(audio.paused, false);
  assert.deepEqual(h.toasts, []);

  const plain = harness({ samples:loud });
  const plainAudio = plain.context.getOrCreateVoiceAudio(plain.rec);
  await plain.context.prepareQuietVoicePlayback(plainAudio, plain.rec);
  plain.context.watchVoiceAudible(plain.rec, plainAudio);
  assert.equal(plain.timers.length, 0, 'nothing to watch without a graph');
});

test('playback keeps a timestamped trace for diagnosing a device', async () => {
  const h = harness({ samples:loud });
  const audio = h.context.getOrCreateVoiceAudio(h.rec);
  await h.context.prepareQuietVoicePlayback(audio, h.rec);
  const trace = vm.runInContext('voiceTrace', h.context);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].stage, 'plain');
  for (const key of ['t', 'context', 'paused', 'ready', 'muted', 'volume', 'time']) assert.ok(key in trace[0], `trace lacks ${key}`);
  assert.equal(h.context.window.__vaultlixVoiceTrace, trace);
});

test('toggleVoicePlayback plays the element it is handed back and arms the watchdog', () => {
  const toggle = extractFunction('toggleVoicePlayback', 'async function');
  assert.match(toggle, /let audio = getOrCreateVoiceAudio\(rec\);/);
  assert.match(toggle, /audio = await prepareQuietVoicePlayback\(audio, rec\);/);
  assert.match(toggle, /traceVoicePlayback\('play', audio,[\s\S]*?watchVoiceAudible\(rec, audio\);/);
});

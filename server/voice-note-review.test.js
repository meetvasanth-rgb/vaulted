'use strict';

// Voice notes, Snapchat-style: while recording a ring with live level bars floats above the
// composer; stopping opens a review bar (delete, play, the recorded waveform, length, send)
// so the note can be checked before it is sent. Nothing is sent until Send is tapped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFn(name) {
  const start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const asyncStart = client.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(asyncStart, i + 1);
  }
  throw new Error('unbalanced');
}

const plain = value => JSON.parse(JSON.stringify(value));
const run = (ctx, code) => vm.runInContext(code, ctx);

class FakeElement {
  constructor(id) { this.id = id; this.style = {}; this.innerHTML = ''; this.textContent = ''; this.attrs = {}; this.classes = new Set(); this.classList = { add:name => this.classes.add(name), remove:name => this.classes.delete(name), toggle:(name, on) => on ? this.classes.add(name) : this.classes.delete(name), contains:name => this.classes.has(name) }; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getBoundingClientRect() { return { left:100, width:200 }; }
}

function harness() {
  const nodes = new Map(['chat-ftr', 'voice-record-bar', 'voice-review-bar', 'voice-review-wave', 'voice-review-time', 'voice-review-play', 'voice-review-play-icon', 'voice-hud-progress'].map(id => [id, new FakeElement(id)]));
  const events = { sent:[], revoked:[], toasts:[], audio:[] };
  class FakeAudio {
    constructor(url) { this.url = url; this.paused = true; this.currentTime = 0; this.listeners = {}; events.audio.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const context = vm.createContext({
    document:{ getElementById:id => nodes.get(id) || null, querySelectorAll:selector => selector === '#voice-review-wave span' ? (context.waveSpans || []) : [] },
    nodes, events, Math, Date, Array, Blob, URL:{ createObjectURL:blob => `blob:${blob.size}`, revokeObjectURL:url => events.revoked.push(url) },
    Audio:FakeAudio, setInterval, clearInterval, console,
    getActiveRoom:() => ({ code:'room-a' }), toast:message => events.toasts.push(message),
    sendVoiceMessage:async (...args) => { events.sent.push(args); },
    voiceRecorder:null, voiceChunks:[], voiceStream:null, voiceStartTime:0, voiceTimerInterval:null, voiceMime:'',
    stopVoiceMeter:() => { context.meterStopped = (context.meterStopped || 0) + 1; },
    hideVoiceRecordBar:() => { nodes.get('chat-ftr').style.display = 'flex'; nodes.get('voice-record-bar').classes.delete('show'); },
  });
  vm.runInContext(['formatVoiceTime'].map(extractFn).join('\n') + `
const VOICE_WAVE_BARS = 36; const VOICE_HUD_BARS = 11; const VOICE_RING_CIRCUMFERENCE = 276.46; let voiceMeter = null; let voiceLevels = []; let voiceDraft = null;
` + ['voiceRingOffset', 'waveBars', 'voiceLevelFromSamples', 'hideVoiceReviewBar', 'setVoiceDraftPlayIcon', 'paintVoiceDraftProgress', 'showVoiceReviewBar', 'voiceDraftAudio', 'toggleVoiceDraftPlayback', 'seekVoiceDraft', 'discardVoiceDraft', 'sendVoiceDraft', 'stopVoiceRecording'].map(extractFn).join('\n'), context);
  return context;
}

test('the ring sweeps once a minute and the level maths stays in range', () => {
  const ctx = harness();
  assert.equal(run(ctx, 'voiceRingOffset(0)'), 276.46, 'empty at the start');
  assert.ok(Math.abs(run(ctx, 'voiceRingOffset(30000)') - 138.23) < 0.01, 'half way after 30 seconds');
  assert.ok(Math.abs(run(ctx, 'voiceRingOffset(60000)') - 276.46) < 0.01, 'starts again each minute');
  assert.ok(run(ctx, 'voiceRingOffset(-5)') <= 276.46);
  ctx.silence = new Uint8Array(64).fill(128);
  ctx.loud = new Uint8Array(64).fill(255);
  assert.equal(run(ctx, 'voiceLevelFromSamples(silence)'), 0);
  assert.equal(run(ctx, 'voiceLevelFromSamples(loud)'), 1, 'capped at full height');
  assert.equal(run(ctx, 'voiceLevelFromSamples(new Uint8Array(0))'), 0);
});

test('the recorded levels become a fixed number of bars, tallest at full height', () => {
  const ctx = harness();
  ctx.levels = Array.from({ length: 200 }, (_, i) => (i === 100 ? 0.8 : 0.1));
  const bars = plain(run(ctx, 'waveBars(levels)'));
  assert.equal(bars.length, 36);
  assert.equal(Math.max(...bars), 1);
  assert.ok(bars.every(value => value >= 0.12 && value <= 1));
  assert.equal(plain(run(ctx, 'waveBars([])')).length, 36, 'a flat placeholder when nothing was measured');
  assert.equal(plain(run(ctx, 'waveBars([0.5], 4)')).length, 4, 'fewer levels than bars still works');
  assert.equal(plain(run(ctx, 'waveBars([0, 0, 0, 0], 2)')).every(value => value >= 0.12), true, 'silence keeps a visible minimum');
});

function recorderStub(ctx, { chunks = ['a', 'b'], elapsedMs = 3000 } = {}) {
  ctx.voiceChunks = chunks.map(part => new Blob([part]));
  ctx.voiceStartTime = Date.now() - elapsedMs;
  ctx.voiceMime = 'audio/webm';
  ctx.voiceStream = { getTracks:() => [{ stop:() => { ctx.trackStopped = true; } }] };
  ctx.voiceRecorder = { state:'recording', mimeType:'audio/webm', stop() { this.state = 'inactive'; this.onstop && this.onstop(); } };
  ctx.voiceLevels = [0.2, 0.9, 0.4, 0.6];
}

test('stopping opens the review bar and sends nothing', () => {
  const ctx = harness();
  recorderStub(ctx);
  ctx.nodes.get('voice-record-bar').classes.add('show');
  run(ctx, 'stopVoiceRecording()');
  assert.equal(ctx.events.sent.length, 0, 'not sent until Send is tapped');
  assert.equal(ctx.trackStopped, true, 'the microphone is released');
  assert.equal(ctx.meterStopped, 1);
  assert.equal(ctx.nodes.get('voice-record-bar').classes.has('show'), false);
  assert.equal(ctx.nodes.get('voice-review-bar').classes.has('show'), true);
  assert.equal(ctx.nodes.get('chat-ftr').style.display, 'none', 'the normal composer stays hidden behind the review bar');
  assert.equal(ctx.nodes.get('voice-review-time').textContent, '0:03');
  assert.equal((ctx.nodes.get('voice-review-wave').innerHTML.match(/<span/g) || []).length, 36);
  assert.equal(run(ctx, 'voiceDraft.mime'), 'audio/webm');
  assert.equal(run(ctx, 'voiceDraft.room.code'), 'room-a');
});

test('a stray tap shorter than a moment opens nothing', () => {
  const ctx = harness();
  recorderStub(ctx, { elapsedMs:150 });
  run(ctx, 'stopVoiceRecording()');
  assert.equal(run(ctx, 'voiceDraft'), null);
  assert.equal(ctx.nodes.get('voice-review-bar').classes.has('show'), false);
  const empty = harness();
  recorderStub(empty, { chunks:[] });
  run(empty, 'stopVoiceRecording()');
  assert.equal(run(empty, 'voiceDraft'), null, 'no audio captured');
});

test('Send in the review bar sends the recording with its length, then clears everything', async () => {
  const ctx = harness();
  recorderStub(ctx, { elapsedMs:7400 });
  run(ctx, 'stopVoiceRecording()');
  await run(ctx, 'sendVoiceDraft()');
  assert.equal(ctx.events.sent.length, 1);
  const [room, blob, seconds, mime] = ctx.events.sent[0];
  assert.equal(room.code, 'room-a');
  assert.equal(blob.size, 2);
  assert.equal(seconds, 7);
  assert.equal(mime, 'audio/webm');
  assert.equal(run(ctx, 'voiceDraft'), null);
  assert.equal(ctx.events.revoked.length, 1, 'the temporary playback URL is released');
  assert.equal(ctx.nodes.get('voice-review-bar').classes.has('show'), false);
  assert.equal(ctx.nodes.get('chat-ftr').style.display, 'flex', 'the normal composer returns');
  await run(ctx, 'sendVoiceDraft()');
  assert.equal(ctx.events.sent.length, 1, 'a second tap sends nothing');
});

test('Delete discards the recording without sending and restores the composer', () => {
  const ctx = harness();
  recorderStub(ctx);
  run(ctx, 'stopVoiceRecording()');
  run(ctx, 'toggleVoiceDraftPlayback()');
  run(ctx, 'discardVoiceDraft()');
  assert.equal(ctx.events.sent.length, 0);
  assert.equal(run(ctx, 'voiceDraft'), null);
  assert.equal(ctx.events.audio[0].paused, true, 'playback stops');
  assert.equal(ctx.events.revoked.length, 1);
  assert.equal(ctx.nodes.get('voice-review-bar').classes.has('show'), false);
  assert.equal(ctx.nodes.get('chat-ftr').style.display, 'flex');
  run(ctx, 'discardVoiceDraft()'); // harmless when there is nothing to discard
});

test('play toggles the recording, shows progress, and returns to the full length when it ends', async () => {
  const ctx = harness();
  recorderStub(ctx, { elapsedMs:10000 });
  run(ctx, 'stopVoiceRecording()');
  ctx.waveSpans = Array.from({ length:10 }, () => new FakeElement('bar'));
  run(ctx, 'toggleVoiceDraftPlayback()');
  await Promise.resolve();
  const audio = ctx.events.audio[0];
  assert.equal(audio.url.startsWith('blob:'), true);
  assert.equal(audio.paused, false);
  assert.match(ctx.nodes.get('voice-review-play-icon').innerHTML, /<rect/, 'pause icon while playing');
  audio.currentTime = 5;
  audio.listeners.timeupdate();
  assert.equal(ctx.waveSpans.filter(bar => bar.classes.has('played')).length, 5, 'half the bars are played at the half way point');
  assert.equal(ctx.nodes.get('voice-review-time').textContent, '0:05');
  run(ctx, 'toggleVoiceDraftPlayback()');
  assert.equal(audio.paused, true);
  assert.match(ctx.nodes.get('voice-review-play-icon').innerHTML, /<polygon/, 'play icon when paused');
  audio.listeners.ended();
  assert.equal(ctx.waveSpans.filter(bar => bar.classes.has('played')).length, 0);
  assert.equal(ctx.nodes.get('voice-review-time').textContent, '0:10');
});

test('tapping the waveform jumps to that point', () => {
  const ctx = harness();
  recorderStub(ctx, { elapsedMs:20000 });
  run(ctx, 'stopVoiceRecording()');
  ctx.waveSpans = Array.from({ length:20 }, () => new FakeElement('bar'));
  ctx.tap = { clientX:200 }; // the wave spans x 100..300 in the stub, so the middle
  run(ctx, 'seekVoiceDraft(tap)');
  assert.ok(Math.abs(ctx.events.audio[0].currentTime - 10) < 0.01);
  assert.equal(ctx.waveSpans.filter(bar => bar.classes.has('played')).length, 10);
  ctx.tapEnd = { clientX:5000 };
  run(ctx, 'seekVoiceDraft(tapEnd)');
  assert.ok(Math.abs(ctx.events.audio[0].currentTime - 20) < 0.01, 'clamped to the end');
});

test('the recording bar has a stop button; the cap opens the review bar instead of sending', () => {
  assert.match(client, /<button class="voice-stop-btn" onclick="stopVoiceRecording\(\)"/);
  assert.match(extractFn('startVoiceRecording'), /showVoiceRecordBar\(\);\s*startVoiceMeter\(\);/);
  assert.match(extractFn('startVoiceRecording'), /if \(elapsedMs >= VOICE_MAX_MS\) stopVoiceRecording\(\);/);
  assert.doesNotMatch(extractFn('startVoiceRecording'), /finishVoiceRecording\(\)/, 'no automatic send at the cap any more');
});

test('the ring and live bars sit above the recording bar, and the meter never plays back to the speakers', () => {
  assert.match(client, /<div class="voice-hud" id="voice-hud" aria-hidden="true">/);
  assert.match(client, /\.voice-hud\{position:absolute;left:50%;bottom:calc\(100% \+ 16px\)/);
  const meter = extractFn('startVoiceMeter');
  assert.match(meter, /source\.connect\(analyser\); \/\/ read-only: never connected to the speakers/);
  assert.doesNotMatch(meter, /destination/);
  assert.match(extractFn('stopVoiceMeter'), /voiceMeter\.context\?\.close\(\)/);
});

test('sending straight from the recording bar, cancelling, and leaving the chat all clean up', () => {
  assert.match(extractFn('finishVoiceRecording'), /stopVoiceMeter\(\);/);
  assert.match(extractFn('cancelVoiceRecording'), /stopVoiceMeter\(\);\s*discardVoiceDraft\(\);/);
  assert.match(client, /if \(voiceDraft\) discardVoiceDraft\(\); \/\/ an unsent voice note is not kept behind another screen/);
});

test('the review bar has delete, play, waveform, length and send', () => {
  const bar = client.slice(client.indexOf('<div class="voice-review-bar" id="voice-review-bar">'), client.indexOf('<!-- VAULT INBOX'));
  for (const hook of ['discardVoiceDraft()', 'toggleVoiceDraftPlayback()', 'seekVoiceDraft(event)', 'id="voice-review-time"', 'sendVoiceDraft()']) assert.ok(bar.includes(hook), hook);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');

function extractFunction(name) {
  const start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let index = open; index < client.length; index++) {
    if (client[index] === '{') depth++;
    else if (client[index] === '}' && --depth === 0) return client.slice(start, index + 1);
  }
  throw new Error(`Unbalanced ${name}`);
}

function playbackHarness() {
  const audio = { playbackRate:1, defaultPlaybackRate:1, preservesPitch:false };
  const button = {
    textContent:'1×', attributes:{},
    setAttribute(name, value) { this.attributes[name] = value; },
    parentElement:{ querySelector:selector => selector === 'audio' ? audio : null },
  };
  const context = vm.createContext({ Number, Math });
  vm.runInContext([
    'const VOICE_PLAYBACK_RATES = [1, 1.5, 2, 3];',
    extractFunction('voicePlaybackRateLabel'),
    extractFunction('nextVoicePlaybackRate'),
    extractFunction('applyVoicePlaybackRate'),
    extractFunction('cycleInlineVoicePlaybackRate'),
  ].join('\n'), context);
  return { context, audio, button };
}

test('voice-note speed cycles through every requested rate and returns to normal', () => {
  const { context, audio, button } = playbackHarness();
  const cycle = context.cycleInlineVoicePlaybackRate;
  for (const expected of [1.5, 2, 3, 1]) {
    cycle(button);
    assert.equal(audio.playbackRate, expected);
    assert.equal(audio.defaultPlaybackRate, expected);
    assert.equal(button.textContent, `${expected}×`);
    assert.equal(button.attributes['aria-label'], `Playback speed ${expected} times`);
  }
  assert.equal(audio.preservesPitch, true);
});

test('one-to-one and group voice notes both expose the speed control', () => {
  const direct = extractFunction('buildVoicePlayerHtml');
  assert.match(direct, /id="voice-rate-\$\{rec\.id\}"/);
  assert.match(direct, /cycleVoicePlaybackRate\('\$\{rec\.id\}'\)/);
  assert.match(groups, /group-voice-player/);
  assert.match(groups, /cycleInlineVoicePlaybackRate\(this\)/);
});

test('recreated direct voice audio retains its selected speed', () => {
  const create = extractFunction('getOrCreateVoiceAudio');
  assert.match(create, /applyVoicePlaybackRate\(audio, voicePlaybackRates\.get\(rec\.id\) \|\| 1\)/);
  assert.match(client, /const VOICE_PLAYBACK_RATES = \[1, 1\.5, 2, 3\];/);
});

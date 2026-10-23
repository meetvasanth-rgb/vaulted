'use strict';

// TestFlight / App Store builds cannot be attached to Safari's Web Inspector, so the on-device traces are
// also reachable from a hidden Diagnostics sheet (tap the version line in Settings five times) that shows
// them as copyable text. Counters and states only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFunction(name, prefix = 'function') {
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

test('five taps on the version line open the sheet; fewer, or slow ones, do not', () => {
  assert.match(client, /<div class="settings-version" onclick="settingsVersionTap\(\)">/);
  let opened = 0; const timers = [];
  const context = vm.createContext({
    openDiagnosticsSheet: () => opened++,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
  });
  vm.runInContext('let settingsVersionTaps = 0, settingsVersionTapTimer = null;\n' + extractFunction('settingsVersionTap'), context);
  for (let i = 0; i < 4; i++) context.settingsVersionTap();
  assert.equal(opened, 0);
  timers.at(-1)(); // the two-second window passes
  for (let i = 0; i < 4; i++) context.settingsVersionTap();
  assert.equal(opened, 0, 'taps spread over time do not add up');
  context.settingsVersionTap();
  assert.equal(opened, 1);
});

test('the report holds only states and counters: voice notes, traces and the platform', () => {
  const body = extractFunction('collectDiagnostics');
  for (const key of ['voiceNotes', 'voiceTrace', 'unreadTrace', 'emojiTrace', 'canPlay', 'userAgent']) assert.match(body, new RegExp(key));
  // Nothing that carries content or identity.
  assert.doesNotMatch(body, /\.base64|\.content|masterKey|sessionToken|privateNumber|displayName|\.token/);
  const audio = body.slice(body.indexOf('audioFacts.push'), body.indexOf('} catch (_) {}'));
  assert.match(audio, /mime:\(audio\.src\.match\(\/\^data:\(\[\^;,\]\+\[\^,\]\*\)\//, 'only the media type is read from the data URI, never the audio');
});

test('the sheet offers refresh, copy and close, above the Settings panel', () => {
  const open = extractFunction('openDiagnosticsSheet');
  for (const action of ['refresh', 'copy', 'close']) assert.match(open, new RegExp(`data-diag="${action}"`));
  assert.match(open, /navigator\.clipboard\.writeText/);
  assert.match(client, /\.contact-sheet-overlay\{position:fixed;inset:0;z-index:10040/);
  assert.match(client, /\.settings-overlay\{position:fixed;inset:0;background:rgba\(0,0,0,0\.5\);z-index:400/);
});

'use strict';

// The native call engines keep one session id for the whole app run but restart
// their message counter at 1 for every call. The web page must not mistake that
// restart for a replay (the caller would sit on "Calling…" for ever), while
// still rejecting genuinely replayed or reordered messages.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const client = readFileSync(join(root, 'client', 'index.html'), 'utf8');
const read = relative => readFileSync(join(root, relative), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

const context = vm.createContext({ JSON, Math, Number });
// The envelope is the wrapped message itself; decryption is not under test.
context.decryptMsg = async (room, envelope) => envelope;
vm.runInContext(extractFunction(client, 'decryptSignalEnvelope'), context);

const receive = (room, seq, ts, payload = { n: seq }) =>
  context.decryptSignalEnvelope(room, JSON.stringify({ seq, ts, payload }));
const newRoom = () => vm.runInContext('({ signalSeqIn: 0, signalTsIn: 0 })', context);

test('messages in order are accepted', async () => {
  const room = newRoom();
  assert.deepEqual(await receive(room, 1, 1000), { n: 1 });
  assert.deepEqual(await receive(room, 2, 1001), { n: 2 });
});

test('a replayed or reordered message is still rejected', async () => {
  const room = newRoom();
  await receive(room, 1, 1000);
  await receive(room, 2, 1001);
  await receive(room, 3, 1002);
  assert.equal(await receive(room, 2, 1001), null, 'replay of an old message');
  assert.equal(await receive(room, 3, 1002), null, 'replay of the latest message');
  assert.equal(await receive(room, 1, 1000), null, 'replay from the start');
});

test('a native engine restarting its counter for the next call is accepted', async () => {
  const room = newRoom();
  for (let seq = 1; seq <= 12; seq++) await receive(room, seq, 1000 + seq);
  // second call, same session id, counter back at 1, later timestamps
  assert.deepEqual(await receive(room, 1, 60_000), { n: 1 });
  assert.deepEqual(await receive(room, 2, 60_010), { n: 2 });
  // and the old call's messages stay dead
  assert.equal(await receive(room, 5, 1005), null);
});

test('after a restart the new counter is what later messages are compared against', async () => {
  const room = newRoom();
  for (let seq = 1; seq <= 5; seq++) await receive(room, seq, 1000 + seq);
  await receive(room, 1, 60_000);
  await receive(room, 2, 60_010);
  assert.equal(await receive(room, 2, 60_010), null);
  assert.equal(await receive(room, 1, 60_000), null);
  assert.deepEqual(await receive(room, 3, 60_020), { n: 3 });
});

test('malformed messages are dropped', async () => {
  const room = newRoom();
  assert.equal(await context.decryptSignalEnvelope(room, 'not json'), null);
  assert.equal(await context.decryptSignalEnvelope(room, JSON.stringify({ seq: 'x', ts: 1, payload: {} })), null);
});

test('both native engines start a new signalling session for every call', () => {
  const ios = read('mobile/ios/App/App/NativeWebRTCCallEngine.swift');
  const android = read('mobile/android/app/src/main/java/com/vaultlix/app/NativeWebRtcCallEngine.java');
  assert.match(ios, /private var sessionID = UUID\(\)\.uuidString/);
  assert.match(ios, /peerSessionID = nil\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*sessionID = UUID\(\)\.uuidString/);
  assert.match(android, /private String sessionId = UUID\.randomUUID\(\)\.toString\(\)/);
  assert.match(android, /peerSessionId = null;[\s\S]{0,200}sessionId = UUID\.randomUUID\(\)\.toString\(\)/);
});

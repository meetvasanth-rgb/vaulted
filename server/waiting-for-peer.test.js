'use strict';

// The creator of an accepted request sits on a "waiting for the other person" room until the
// peer is seen. The old check was the peer's momentary online presence, so a peer who had
// already joined (and moved to another screen or an inbox that polls slowly) left the
// creator's chat row stuck on "Waiting for the other person", and tapping it opened the
// room-code screen instead of the chat.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

async function waitWith(pollResult, { silent = true } = {}) {
  const log = [];
  let tick = null;
  const room = { code:'room-1', token:'tok', waitInterval:null };
  const context = vm.createContext({
    api: async () => pollResult,
    setInterval: fn => { tick = fn; return 7; },
    clearInterval: () => log.push('clear'),
    pendingRoomCode: 'room-1',
    deriveSharedKey: async (_room, key) => log.push(`derive:${key}`),
    persistRoom: async () => log.push('persist'),
    setActiveRoom: () => log.push('active'),
    startRoomPolling: () => log.push('polling'),
    showScreen: name => log.push(`screen:${name}`),
    renderVaultList: () => log.push('render'),
    playChime: () => log.push('chime'),
    triggerConnectionMoment: async () => log.push('moment'),
    enableInput: () => {},
  });
  vm.runInContext(extract(client, 'startWaitingForPeer'), context);
  context.startWaitingForPeer(room, { silent });
  await tick();
  return { room, log };
}

test('a peer who has joined but reads offline still ends the waiting state', async () => {
  const { room, log } = await waitWith({ peerOnline:false, peerName:'Madhan', peerPubKey:'KEY' });
  assert.equal(room.everOnline, true);
  assert.equal(room.peerName, 'Madhan');
  assert.ok(log.includes('derive:KEY') && log.includes('polling') && log.includes('screen:s-vault-list'));
});

test('an online peer still ends the waiting state', async () => {
  const { room } = await waitWith({ peerOnline:true, peerName:'Madhan', peerPubKey:'KEY' });
  assert.equal(room.everOnline, true);
  assert.equal(room.peerOnline, true);
});

test('with nobody joined yet, the room keeps waiting', async () => {
  const { room, log } = await waitWith({ peerOnline:false, peerName:null, peerPubKey:null });
  assert.notEqual(room.everOnline, true);
  assert.deepEqual(log, []);
  const failed = await waitWith({ error:'x' });
  assert.notEqual(failed.room.everOnline, true);
});

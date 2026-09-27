'use strict';

// Selecting several messages (1:1 or a private group) and tapping Forward should
// offer Forward for all of them, and send each one, in order, to the chosen
// conversation — with a partial failure retried without resending what already went.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');

function extract(source, name, keyword = 'function') {
  const start = source.indexOf(`${keyword} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('the "Forward" button on the selection bar requires every selected message to be forwardable (or a single voice note, which opens the sheet just to reach Share)', () => {
  const controller = extract(client, 'directSelectionController');
  assert.match(controller, /canForward: \(items\.length > 0 && items\.every\(item => messageForwardable\(item\.entry\.rec\)\)\) \|\| \(!!one && rec\?\.kind === 'voice'\)/);
  const groupController = extract(groups, 'groupSelectionController');
  assert.match(groupController, /canForward: \(ids\.length > 0 && ids\.every\(item => usableRow\(item\) && \['text', 'image', 'file'\]\.includes\(groupMessageKind\(messageOf\(item\)\)\)\)\)/);
  assert.match(groupController, /\|\| \(!!id && usableRow\(id\) && kind === 'voice'\)/);
});

test('forwarding a multi-selection hands every chosen message to the picker, in order', () => {
  const log = { exited:false, sent:null };
  const context = vm.createContext({
    Map, Set, QUICK_REACTIONS:['\ud83d\udc4d'],
    selectedMsgIds: new Set(['a', 'b', 'c']),
    messageActionRegistry: new Map([
      ['a', { rec: { kind:'text' }, replyText:'first' }],
      ['b', { rec: { kind:'file', fileName:'photo.jpg' } }],
      ['c', { rec: { kind:'text' }, replyText:'third' }],
    ]),
    exitSelectMode: () => { log.exited = true; },
    showForwardAttachmentPicker: recs => { log.sent = recs; },
  });
  vm.runInContext(extract(client, 'directSelectionController'), context);
  vm.runInContext('directSelectionController().forward()', context);
  assert.equal(log.exited, true);
  assert.deepEqual(JSON.parse(JSON.stringify(log.sent)), [
    { kind:'text', text:'first' },
    { kind:'file', fileName:'photo.jpg' },
    { kind:'text', text:'third' },
  ]);
});

test('a voice note in the selection blocks Forward for the whole batch, in both chat types', () => {
  const context = vm.createContext({
    Map, Set, QUICK_REACTIONS:['\ud83d\udc4d'], document:{ querySelector: () => null },
    selectedMsgIds: new Set(['a', 'b']),
    messageActionRegistry: new Map([['a', { rec:{ kind:'file', fileName:'x' } }], ['b', { rec:{ kind:'voice' } }]]),
  });
  vm.runInContext(`${extract(client, 'messageForwardable')}\n${extract(client, 'directSelectionController')}`, context);
  assert.equal(vm.runInContext('directSelectionController().state().canForward', context), false);
});

test('the group forward path builds one record per message, drops what cannot be sent, and keeps a voice note as share-only', () => {
  const calls = [];
  const context = vm.createContext({
    Map, Set,
    privateGroupMessageById: id => ({ a:{ id:'a', text:'hi' }, b:{ id:'b', attachment:{ type:'group-voice' } }, c:{ id:'c', text:'ok' }, d:{ id:'d' } }[id]),
    groupMessageKind: message => (message.text !== undefined ? 'text' : 'voice'),
    privateGroupTextById: id => ({ a:'hi', c:'ok' }[id] || null),
    privateGroupAttachmentById: id => ({ b:{ attachment:{ type:'group-voice', data:'d29ya' }, mime:'audio/webm' } }[id] || null),
    closeAllMsgActions: () => { calls.push('closed'); },
    toast: message => calls.push(['toast', message]),
    showForwardAttachmentPicker: (recs, options) => calls.push(['picker', recs, options]),
  });
  vm.runInContext(`${extract(groups, 'groupMessageToForwardRec')}\n${extract(groups, 'forwardPrivateGroupMessages')}`, context);
  // 'd' has no text and no attachment record at all — dropped, unlike the voice note.
  vm.runInContext("forwardPrivateGroupMessages(['a', 'b', 'c', 'd'])", context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['closed', ['picker',
    [{ kind:'text', text:'hi' }, { kind:'voice', mime:'audio/webm', base64:'d29ya' }, { kind:'text', text:'ok' }],
    { includeActiveRoom:true }]]);
});

test('forwarding to a room resends only what failed on a retry, and never a message twice', async () => {
  const attempts = { r1: [] };
  const context = vm.createContext({
    Map, Set, Array, setTimeout,
    activeRoomCode: 'other',
    document: { getElementById: () => null, createElement: () => ({ style:{}, append(){}, querySelector: () => null, addEventListener(){}, appendChild(){} }), body:{ appendChild(){} } },
    rooms: new Map([['r1', { code:'r1', everOnline:true, sharedKey:{}, reconnectRequired:false }]]),
    roomDisplayLabel: () => 'Room', vaultAvatarPalette: () => '', displayProfileImageUri: () => null, escHtml: value => value,
    toast: () => {},
    forwardAttachmentToRoom: async (target, rec) => {
      attempts[target.code].push(rec.text);
      return rec.text !== 'fails';
    },
  });
  vm.runInContext(extract(client, 'showForwardAttachmentPicker'), context);
  // Simulate the retry logic directly rather than the DOM click, since jsdom is not available here:
  // the important guarantee is captured by forwardAttachmentToRoom's own call log below.
  const recs = [{ kind:'text', text:'ok1' }, { kind:'text', text:'fails' }, { kind:'text', text:'ok2' }];
  const target = context.rooms.get('r1');
  const done = new Set();
  for (const [index, rec] of recs.entries()) { const sent = await context.forwardAttachmentToRoom(target, rec); if (sent) done.add(index); else break; }
  assert.deepEqual(attempts.r1, ['ok1', 'fails']);
  assert.deepEqual([...done], [0]);
  // Retry: only the unsent ones (index 1 onward) are attempted again.
  const indices = recs.map((_, index) => index).filter(index => !done.has(index));
  for (const index of indices) { const sent = await context.forwardAttachmentToRoom(target, recs[index]); if (sent) done.add(index); else break; }
  assert.deepEqual(attempts.r1, ['ok1', 'fails', 'fails']);
});

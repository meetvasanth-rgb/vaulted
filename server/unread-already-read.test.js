'use strict';

// After a restart the poll redelivers everything past the saved position. A message the server already
// shows as read (read here before the restart, or on another device of the account) used to be counted
// as unread again, so read chats came back with "new message" badges. The full restore already honoured
// the server's readAt; the live poll and the deferred-decrypt replay now do too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFunction(name, prefix = 'async function') {
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

async function replay(items, { visible = false } = {}) {
  const persisted = [];
  const room = { code:'r1', token:'me', sharedKey:{}, messages:[], unread:0, unreadSystemCount:0, readConfirmIds:[], seenMsgIds:new Set(), pendingDecrypt:items };
  const context = vm.createContext({
    isRoomVisible: () => visible,
    processIncomingContent: async (_room, _content, _name, _time, msgId) => ({ id:msgId, kind:'text' }),
    renderMessageRecord: () => {}, handleIncomingEmojiEffect: () => {}, notifyMsg: () => {},
    persistRoomSeq: () => persisted.push(true),
    renderRoomTabs: () => {}, traceUnreadIncrement: () => {}, updateDocumentTitle: () => {}, renderVaultList: () => {}, applyDirectMessageEdit: () => {},
    Promise,
  });
  vm.runInContext(extractFunction('flushPendingDecrypt'), context);
  await context.flushPendingDecrypt(room);
  return { room, persisted };
}

const item = (id, extra = {}) => ({ msgId:id, content:'c', name:'n', time:'10:00', ts:1, from:'peer', ...extra });

test('a deferred-decrypt message the server already shows as read is not counted as unread', async () => {
  const { room } = await replay([item('read-1', { readAt:1700000000000 }), item('read-2', { readAt:1700000001000 })]);
  assert.equal(room.unread, 0);
  assert.equal(room.messages.length, 2, 'the messages themselves still arrive');
});

test('a genuinely new message is still counted, alongside already-read ones', async () => {
  const { room, persisted } = await replay([item('old', { readAt:1700000000000 }), item('new-1'), item('new-2', { readAt:null })]);
  assert.equal(room.unread, 2);
  assert.equal(persisted.length, 1);
});

test('nothing is counted for the conversation that is open on screen', async () => {
  const { room } = await replay([item('seen')], { visible:true });
  assert.equal(room.unread, 0);
});

test('the live poll applies the same readAt rule', () => {
  const poll = client.slice(client.indexOf('if (data.messages && data.messages.length > 0) {\n      historyStorePut'), client.indexOf('Note: the disappearing-message timer does NOT start here'));
  assert.match(poll, /else if \(\(!isPerspectiveCallEvent \|\| rec\.callEventViewerRole === 'receiver'\) && !msg\.readAt\) \{\s*\/\/[\s\S]*?room\.unread\+\+;/);
  // The full restore keeps its own readAt rule.
  assert.match(client, /msg\.type !== 'message' \|\| msg\.from === room\.token \|\| msg\.readAt \|\| Number\(msg\.seq\) <= \(Number\(room\.lastReadSeq\) \|\| 0\)/);
});

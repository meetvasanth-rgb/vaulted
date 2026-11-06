'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');

test('delivered direct messages get bounded receipt catch-up polls', () => {
  assert.match(client, /const READ_RECEIPT_CATCHUP_DELAYS = \[700, 1800, 4000, 8000, 15000\]/);
  assert.match(client, /message\.isMe && message\.receiptState === 'delivered'/);
  assert.match(client, /READ_RECEIPT_CATCHUP_DELAYS\.map\(delay => setTimeout\(\(\) => \{/);
  assert.match(client, /doPoll\(room\)/);
  assert.doesNotMatch(client, /receiptCatchupTimers\s*=\s*setInterval/);
});

test('a read receipt cancels catch-up and delivery advances its sequence watermark', () => {
  assert.match(client, /else if \(typeof clearReadReceiptCatchup === 'function'\) clearReadReceiptCatchup\(room\)/);
  assert.match(client, /if \(seq && deliveredAt && seq > room\.lastReceiptSeq\) room\.lastReceiptSeq = seq/);
  assert.match(client, /if \(seq && readAt && seq > room\.lastReadReceiptSeq\) room\.lastReadReceiptSeq = seq/);
  assert.match(client, /lastReadReceiptSeq:room\.lastReadReceiptSeq \|\| 0/);
});

test('delivery and read acknowledgements use separate persisted cursors', () => {
  assert.match(client, /lastSeq: 0, lastReceiptSeq: 0, lastReadReceiptSeq: 0/);
  assert.match(client, /existing\.lastReadReceiptSeq = room\.lastReadReceiptSeq/);
  assert.match(client, /room\.lastReadReceiptSeq = session\.lastReadReceiptSeq \|\| 0/);
  assert.match(client, /lastReceiptSeq: room\.lastReceiptSeq, lastReadReceiptSeq: room\.lastReadReceiptSeq/);
});

test('opening a restored conversation confirms both restored and background read queues', () => {
  const start = client.indexOf('function flushPendingReads(room) {');
  const end = client.indexOf('\n}', start) + 2;
  const source = client.slice(start, end);
  const confirmations = [];
  const flushPendingReads = Function('confirmRead', `${source}; return flushPendingReads;`)(
    (room, ids) => confirmations.push({ room, ids }),
  );
  const room = { readConfirmIds:['restored', 'overlap'], pendingReadIds:['overlap', 'background'] };

  flushPendingReads(room);

  assert.deepEqual(confirmations.map(item => item.ids), [['restored', 'overlap', 'background']]);
  assert.deepEqual(room.readConfirmIds, []);
  assert.deepEqual(room.pendingReadIds, []);
});

test('native keyboards cannot make a visible chat look inactive', () => {
  const start = client.indexOf('function isUserActive() {');
  const end = client.indexOf('\n}', start) + 2;
  const source = client.slice(start, end);
  const evaluate = ({ hidden = false, locked = false, iosKnown = false, iosActive = true, platform = null, focused = false, interactedAt = 0 } = {}) =>
    Function('document', 'quickLockActive', 'nativeIOSLifecycleKnown', 'nativeIOSAppActive', 'nativePlatform', 'tabFocused', 'lastInteractionTime',
      `${source}; return isUserActive();`)(
        { hidden }, locked, iosKnown, iosActive, () => platform, focused, interactedAt,
      );

  assert.equal(evaluate({ platform:'android' }), true, 'an Android software keyboard may blur the WebView while the chat stays visible');
  assert.equal(evaluate({ iosKnown:true, iosActive:true }), true, 'the signed iOS scene lifecycle is authoritative');
  assert.equal(evaluate({ iosKnown:true, iosActive:false }), false);
  assert.equal(evaluate({ hidden:true, platform:'android' }), false);
});

test('read acknowledgements stay queued until the server confirms them', async () => {
  const start = client.indexOf('const READ_ACK_RETRY_DELAYS =');
  const end = client.indexOf("\ndocument.addEventListener('visibilitychange'", start);
  const source = client.slice(start, end);
  const calls = [];
  const room = {
    code:'room', token:'token', pendingReadAckIds:new Set(), readAckTimer:null,
    readAckInFlight:false, readAckAttempt:0, lastReadSeq:0, lastSeq:2, messages:[],
  };
  const rooms = new Map([[room.code, room]]);
  const confirmRead = Function('fetch', 'rooms', 'persistRoomSeq', 'startReceiveDeleteTimer',
    'AbortController', 'setTimeout', 'clearTimeout',
    `${source}; return confirmRead;`)(
      async (path, options) => {
        calls.push({ path, body:JSON.parse(options.body) });
        return { ok:true, status:200, text:async () => JSON.stringify({ ok:true }) };
      },
      rooms, () => {}, () => {}, AbortController, setTimeout, clearTimeout,
    );

  confirmRead(room, ['message-1']);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls.map(call => call.body.msgIds), [['message-1']]);
  assert.deepEqual([...room.pendingReadAckIds], []);
  assert.equal(room.readAckAttempt, 0);
});

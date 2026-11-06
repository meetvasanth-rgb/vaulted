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

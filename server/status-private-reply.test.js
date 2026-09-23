const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('private status replies carry an encrypted reference and compact preview', () => {
  assert.match(client, /function replyToCurrentStatus\(\)[\s\S]*type:'status'[\s\S]*statusId:item\.id[\s\S]*thumbPromise/);
  assert.match(client, /replyTo\.type === 'status'[\s\S]*statusId:replyTo\.statusId[\s\S]*thumb/);
  assert.match(client, /function buildStatusReplyQuoteHtml\(replyData\)/);
  assert.match(client, /class="msg-status-reply" data-status-reply-id=/);
  assert.match(client, /Status reply/);
  assert.doesNotMatch(client, /input\.value=`Replying to your status:/);
});

test('status reply links reopen a live original and handle expiry', () => {
  assert.match(client, /async function openStatusReply\(statusId\)/);
  assert.match(client, /statusFeed\.find\(item => item\.id === statusId && Number\(item\.expiresAt\) > Date\.now\(\)\)/);
  assert.match(client, /This status is no longer available\./);
  assert.match(client, /data-status-reply-id[\s\S]*openStatusReply\(event\.currentTarget\.dataset\.statusReplyId\)/);
});

test('received status reply metadata is bounded before rendering', () => {
  assert.match(client, /function sanitizeStatusReplyData\(value\)/);
  assert.match(client, /\^\[a-f0-9-\]\{36\}\$/i);
  assert.match(client, /value\.thumb\.length <= 32768/);
  assert.match(client, /text:String\(value\.text \|\| ''\)\.slice\(0,160\)/);
});

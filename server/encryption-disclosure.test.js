const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const clientHtml = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('call encryption disclosures consistently describe TURN as an encrypted-media relay', () => {
  assert.doesNotMatch(clientHtml, /call is not end-to-end encrypted/i);
  assert.match(clientHtml, /Call signaling is encrypted with the conversation's end-to-end encryption key/);
  assert.match(clientHtml, /WebRTC then encrypts audio and video between participant devices using DTLS-SRTP/);
  assert.match(clientHtml, /Cloudflare relays encrypted media packets/);
  assert.match(clientHtml, /cannot decrypt call audio or video/);
});

test('storage disclosure describes durable encrypted conversation state and backup retention', () => {
  assert.match(clientHtml, /Active encrypted state and access tokens are checkpointed to restricted persistent storage/i);
  assert.match(clientHtml, /Infrastructure backups may retain an encrypted copy until the backup expires or is deleted/i);
  assert.match(clientHtml, /Older encrypted infrastructure backups remain subject to the provider's configured retention period/i);
  assert.doesNotMatch(clientHtml, /Conversation content lives only in memory during normal operation/i);
});

test('call history survives restart only as encrypted conversation content', () => {
  assert.match(clientHtml, /encryptTextMsg\(room, JSON\.stringify\(\{ type:'call-event'/);
  assert.match(clientHtml, /parsed\.type === 'call-event'/);
  assert.match(clientHtml, /call-event-\$\{room\.callInviteId\}/);
});

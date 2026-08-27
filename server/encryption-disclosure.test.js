const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const clientHtml = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('call encryption disclosures consistently describe TURN as an encrypted-media relay', () => {
  assert.doesNotMatch(clientHtml, /call is not end-to-end encrypted/i);
  assert.match(clientHtml, /Call signaling is encrypted with the vault's end-to-end encryption key/);
  assert.match(clientHtml, /WebRTC then encrypts audio and video between the participants' devices using DTLS-SRTP/);
  assert.match(clientHtml, /Cloudflare relays the already-encrypted media packets/);
  assert.match(clientHtml, /it cannot decrypt the call audio or video/);
});

test('storage disclosure describes durable encrypted room checkpoints and backup retention', () => {
  assert.match(clientHtml, /encrypted state and access tokens are periodically checkpointed to restricted persistent storage/i);
  assert.match(clientHtml, /Railway volume backups may retain a checkpoint until that backup expires or is deleted/i);
  assert.match(clientHtml, /older backup copies remain subject to Railway's configured backup-retention period/i);
  assert.doesNotMatch(clientHtml, /Conversation content lives only in memory during normal operation/i);
});

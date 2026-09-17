'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('new files upload only E2E ciphertext directly to private object storage', () => {
  assert.match(client, /attachmentId = await uploadEncryptedAttachment\(room, msgId, encryptedPayload\)/);
  assert.match(client, /method:'PUT'[\s\S]*body:ciphertext/);
  assert.match(client, /content:`\$\{ENCRYPTED_ATTACHMENT_PREFIX\}\$\{attachmentId\}`/);
  assert.match(server, /POST \/api\/attachment\/prepare[\s\S]*createPendingAttachment/);
  assert.match(server, /pending\.messageId !== msgId/);
  assert.match(server, /objectStorage\.sizeOf\(pending\.objectKey\)/);
});

test('attachment downloads recheck conversation membership before issuing a short-lived URL', () => {
  const downloadRoute = server.slice(server.indexOf("path==='/api/attachment/download'"), server.indexOf('// POST /api/send'));
  assert.match(downloadRoute, /room\.members\.has\(d\.token\)/);
  assert.match(downloadRoute, /postgresStore\.attachmentForMessage/);
  assert.match(downloadRoute, /objectStorage\.createDownloadUrl/);
  assert.match(client, /resolveEncryptedAttachment\(room, content\)/);
});

test('large existing ciphertext is externalized without decrypting it', () => {
  assert.match(server, /listInlinePayloadCandidates/);
  assert.match(server, /objectStorage\.put\(objectKey, ciphertext\)/);
  assert.match(server, /externalizeMessagePayload/);
  assert.doesNotMatch(server, /migrateInlineAttachmentPayloads[\s\S]{0,1200}decrypt/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client', 'groups.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

test('direct and private-group file attachments allow 25 MB sources', () => {
  assert.match(client, /const MAX_FILE_SIZE = 25 \* 1024 \* 1024/);
  assert.match(client, /maximum 25MB/);
  assert.match(groups, /const MAX_PRIVATE_GROUP_FILE_BYTES = 25 \* 1024 \* 1024/);
  assert.match(groups, /maximum 25MB/);
});

test('encrypted attachment ceilings accommodate double-base64 expansion', () => {
  assert.match(client, /const MAX_ENCRYPTED_ATTACHMENT_BYTES = 48 \* 1024 \* 1024/);
  assert.match(groups, /const MAX_PRIVATE_GROUP_ATTACHMENT_BYTES = 48 \* 1024 \* 1024/);
  assert.match(server, /const MAX_MESSAGE_CONTENT_BYTES = 48 \* 1024 \* 1024/);
  assert.match(server, /const BODY_LIMIT_SEND = 20 \* 1024 \* 1024/);
});

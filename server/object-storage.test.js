'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EncryptedObjectStorage } = require('./object-storage');

test('object storage stays disabled without credentials and rejects partial configuration', () => {
  const disabled = new EncryptedObjectStorage({ env:{} });
  assert.equal(disabled.enabled, false);
  assert.throws(() => new EncryptedObjectStorage({
    endpoint:'https://example.invalid', bucket:'bucket-only', env:{},
  }), /credentials are incomplete/);
});

test('signed URLs are scoped to one private object and expire', async () => {
  const signed = [];
  const store = new EncryptedObjectStorage({
    endpoint:'https://storage.example', bucket:'private-bucket', region:'auto',
    accessKeyId:'key', secretAccessKey:'secret', client:{ send:async () => ({ ContentLength:321 }) },
    signer:async (_client, command, options) => {
      signed.push({ input:command.input, options });
      return 'https://private-bucket.storage.example/signed';
    }, env:{},
  });
  assert.equal(await store.createUploadUrl('encrypted/object'), 'https://private-bucket.storage.example/signed');
  assert.equal(await store.createDownloadUrl('encrypted/object'), 'https://private-bucket.storage.example/signed');
  assert.equal(signed[0].input.Bucket, 'private-bucket');
  assert.equal(signed[0].input.Key, 'encrypted/object');
  assert.equal(signed[0].options.expiresIn, 600);
  assert.equal(await store.sizeOf('encrypted/object'), 321);
  assert.equal((await store.open('encrypted/object')).ContentLength, 321);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTemporaryVaultAcceptedPayload } = require('./temporary-vault-notification');

test('creates a vault-accepted notification for a temporary vault', () => {
  const payload = JSON.parse(buildTemporaryVaultAcceptedPayload({
    persistent: false,
    code: 'quiet-copper-1234',
    peerName: 'Lily',
    eventId: 'join-event',
  }));

  assert.deepEqual(payload, {
    title: 'Vaultlix',
    body: 'Lily accepted your temporary vault invitation',
    tag: 'quiet-copper-1234-accepted-join-event',
    code: 'quiet-copper-1234',
  });
});

test('does not create a vault-accepted notification for a permanent vault', () => {
  assert.equal(buildTemporaryVaultAcceptedPayload({
    persistent: true,
    code: 'standing-link-1234',
    peerName: 'Lily',
    eventId: 'join-event',
  }), null);
});

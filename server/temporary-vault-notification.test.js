const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTemporaryVaultAcceptedPayload } = require('./temporary-vault-notification');

test('creates an accepted notification for a temporary conversation', () => {
  const payload = JSON.parse(buildTemporaryVaultAcceptedPayload({
    persistent: false,
    code: 'quiet-copper-1234',
    peerName: 'Lily',
    eventId: 'join-event',
  }));

  assert.deepEqual(payload, {
    title: 'Vaultlix',
    body: 'Lily accepted your private conversation invitation',
    tag: 'quiet-copper-1234-accepted-join-event',
    code: 'quiet-copper-1234',
  });
});

test('does not create an accepted notification for a persistent conversation', () => {
  assert.equal(buildTemporaryVaultAcceptedPayload({
    persistent: true,
    code: 'standing-link-1234',
    peerName: 'Lily',
    eventId: 'join-event',
  }), null);
});

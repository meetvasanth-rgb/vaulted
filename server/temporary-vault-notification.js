function buildTemporaryVaultAcceptedPayload({ persistent, code, peerName, eventId }) {
  if (persistent || !code || !eventId) return null;
  const safeName = String(peerName || 'Someone').trim().slice(0, 24) || 'Someone';
  return JSON.stringify({
    title: 'Vaultlix',
    body: `${safeName} accepted your temporary vault invitation`,
    tag: `${code}-accepted-${eventId}`,
    code,
  });
}

module.exports = { buildTemporaryVaultAcceptedPayload };

'use strict';
// Only E2E ciphertext and routing metadata travel through the push provider.
// A conservative byte cap leaves room for APNs/FCM's existing alert fields.
function notificationEnvelope(message, { group = false, viewOnce = false } = {}) {
  if (!message || viewOnce) return '';
  const ciphertext = group ? message.ciphertext : message.content;
  if (typeof ciphertext !== 'string' || !/^(?:v2:|v:|g1:)/.test(ciphertext)) return '';
  const envelope = group ? {
    id:message.id, ciphertext, senderId:message.senderId, keyVersion:message.keyVersion,
    createdAt:message.createdAt, attachmentId:message.attachmentId || undefined,
  } : {
    id:message.id, type:'message', content:ciphertext, from:'peer', seq:0,
    ts:message.ts, deleteTimerSeconds:message.deleteTimerSeconds || 0,
    attachmentId:message.attachmentId || undefined,
  };
  const encoded = JSON.stringify(envelope);
  return Buffer.byteLength(encoded, 'utf8') <= 1800 ? encoded : '';
}
module.exports = { notificationEnvelope };

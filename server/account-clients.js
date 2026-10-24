'use strict';

// Which kind of Vaultlix client an identity has used: the native iOS or Android app, or the web
// (browser or installed PWA). Detected from the User-Agent, since the native shells append a
// Vaultlix marker to their web view's user agent. Only the three coarse kinds are kept, never the
// user agent itself.

const CLIENT_KINDS = ['ios', 'android', 'web'];
const NATIVE_MARKER = /VaultlixNative|VaultlixImageSafety/i;

function detectClientKind(userAgent) {
  const agent = String(userAgent || '');
  if (!NATIVE_MARKER.test(agent)) return 'web';
  if (/android/i.test(agent)) return 'android';
  if (/iphone|ipad|ipod|ios/i.test(agent)) return 'ios';
  return 'web';
}

function normalizeClientKind(value) {
  return CLIENT_KINDS.includes(value) ? value : null;
}

function normalizeClientsSeen(value) {
  const seen = Array.isArray(value) ? value.map(normalizeClientKind).filter(Boolean) : [];
  return CLIENT_KINDS.filter(kind => seen.includes(kind));
}

// Records that this account just used `kind`. Returns true when something changed, so the caller
// can skip a write for the common case of a client already on record.
function noteAccountClient(account, kind) {
  const clean = normalizeClientKind(kind);
  if (!account || !clean) return false;
  const seen = normalizeClientsSeen(account.clientsSeen);
  if (seen.includes(clean)) return false;
  account.clientsSeen = normalizeClientsSeen([...seen, clean]);
  return true;
}

// What the admin page shows. Older identities were created before this was recorded, so a native
// notification destination still proves they have used the app.
function describeAccountClients(account) {
  const seen = new Set(normalizeClientsSeen(account?.clientsSeen));
  for (const destination of account?.pushDestinations || []) {
    if (destination?.platform === 'ios') seen.add('ios');
    if (destination?.platform === 'android') seen.add('android');
  }
  const clientsSeen = CLIENT_KINDS.filter(kind => seen.has(kind));
  return {
    registeredVia: normalizeClientKind(account?.registeredVia),
    clientsSeen,
    usesApp: clientsSeen.includes('ios') || clientsSeen.includes('android'),
  };
}

module.exports = { CLIENT_KINDS, detectClientKind, normalizeClientKind, normalizeClientsSeen, noteAccountClient, describeAccountClients };

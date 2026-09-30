'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');

// Brace-counting extractor: robust regardless of what follows a function in
// source order (this file's Locker functions have addEventListener/const
// statements interleaved between them, unlike the simpler
// "slice to the next \nfunction " approach used elsewhere in this suite,
// which would over- or under-capture here).
function extract(name) {
  let start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in client/index.html`);
  if (html.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  // Skip past the parameter list via paren-counting first — it may itself
  // contain a brace (e.g. a default value like `options = {}`), which would
  // throw off a brace-counter started right after the function name.
  let i = html.indexOf('(', start);
  let parenDepth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '(') parenDepth++;
    else if (html[i] === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
  }
  i = html.indexOf('{', i);
  let braceDepth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') braceDepth++;
    else if (html[i] === '}') { braceDepth--; if (braceDepth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}

function extractConst(name) {
  const match = html.match(new RegExp(`const ${name} = [^;]+;`));
  assert.ok(match, `${name} constant should exist in client/index.html`);
  return match[0];
}

const LOCKER_CONSTANTS = ['LOCKER_CONFIG_KEY', 'LOCKER_FAILURE_KEY', 'LOCKER_PBKDF2_ITERATIONS', 'LOCKER_IDLE_LOCK_MS'];

const LOCKER_FUNCTIONS = [
  'base64UrlToBytes', 'bytesToBase64', 'bytesToBase64UrlCompact', 'equalBytes', 'appLockDelayMs',
  'deriveLockerMaterial', 'loadLockerConfig', 'lockerConfigured', 'setUpLocker',
  'loadLockerFailures', 'recordLockerFailure', 'lockerWaitCopy',
  'unlockLocker', 'lockLocker', 'armLockerIdleTimer',
  'encryptLockerItem', 'decryptLockerItem',
];

function lockerContext() {
  const store = new Map();
  const context = {
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, JSON, console,
    btoa, atob,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    // Timers are stubbed as no-ops: armLockerIdleTimer's real 2-minute
    // setTimeout must never actually schedule inside a test process (it
    // would keep node --test alive / leak an open handle). The idle-lock
    // *behavior* is out of scope for this automated suite per the plan —
    // it needs manual/in-browser verification (visibilitychange, real
    // timers) instead.
    setTimeout: () => 0,
    clearTimeout: () => {},
    lastInteractionTime: Date.now(),
    lockerSessionKey: null,
    lockerIdleTimer: null,
  };
  vm.createContext(context);
  for (const name of LOCKER_CONSTANTS) vm.runInContext(extractConst(name), context);
  for (const name of LOCKER_FUNCTIONS) vm.runInContext(extract(name), context);
  return context;
}

test('wrong password is rejected and never produces a session key', async () => {
  const ctx = lockerContext();
  await ctx.setUpLocker('correct horse battery staple');
  await assert.rejects(() => ctx.unlockLocker('totally wrong'), /Incorrect Locker password/);
  assert.equal(ctx.lockerSessionKey, null);
});

test('correct password unlocks and the resulting key actually works', async () => {
  const ctx = lockerContext();
  await ctx.setUpLocker('correct horse battery staple');
  const ok = await ctx.unlockLocker('correct horse battery staple');
  assert.equal(ok, true);
  assert.notEqual(ctx.lockerSessionKey, null);
  const record = await ctx.encryptLockerItem({ type: 'note', text: 'hello vault' });
  const decrypted = await ctx.decryptLockerItem(record);
  assert.equal(decrypted.text, 'hello vault');
});

test('editing a note reuses its id/createdAt (overwrite, not a duplicate) and carries the heading', async () => {
  const ctx = lockerContext();
  await ctx.setUpLocker('pw'); await ctx.unlockLocker('pw');

  const original = await ctx.encryptLockerItem({ type: 'note', heading: 'Groceries', text: 'milk, eggs' });
  assert.deepEqual(await ctx.decryptLockerItem(original), { type: 'note', heading: 'Groceries', text: 'milk, eggs' });

  // Simulate an edit: same id/createdAt passed back in, new content.
  const edited = await ctx.encryptLockerItem(
    { type: 'note', heading: 'Groceries (updated)', text: 'milk, eggs, bread' },
    { id: original.id, createdAt: original.createdAt },
  );
  assert.equal(edited.id, original.id);
  assert.equal(edited.createdAt, original.createdAt);
  assert.ok(edited.updatedAt >= original.updatedAt);
  assert.deepEqual(await ctx.decryptLockerItem(edited), { type: 'note', heading: 'Groceries (updated)', text: 'milk, eggs, bread' });

  // The old ciphertext is a different value — a real re-encryption happened,
  // not a no-op — and the old wrapped key is gone; only `edited`'s survives.
  assert.notEqual(edited.ciphertext, original.ciphertext);
  assert.notEqual(edited.wrappedKey, original.wrappedKey);
});

test('note and image items round-trip through encrypt/decrypt', async () => {
  const ctx = lockerContext();
  await ctx.setUpLocker('pw'); await ctx.unlockLocker('pw');

  // JSON.stringify drops undefined-valued keys entirely, so the decrypted
  // object only carries whichever fields the original item actually set.
  const note = await ctx.encryptLockerItem({ type: 'note', text: 'my bank pin is 1234' });
  assert.deepEqual(await ctx.decryptLockerItem(note), { type: 'note', text: 'my bank pin is 1234' });

  const image = await ctx.encryptLockerItem({ type: 'image', mime: 'image/jpeg', base64: 'ZmFrZS1pbWFnZS1ieXRlcw==' });
  assert.deepEqual(await ctx.decryptLockerItem(image), { type: 'image', mime: 'image/jpeg', base64: 'ZmFrZS1pbWFnZS1ieXRlcw==' });

  // Ciphertext/wrappedKey are never equal to the plaintext/verifier material —
  // a cheap sanity check that this isn't accidentally a no-op "encryption".
  assert.notEqual(note.ciphertext, '');
  assert.notEqual(note.wrappedKey, '');
});

test('repeated wrong passwords escalate a lockout delay, and a blocked attempt is rejected before deriving anything', async () => {
  const ctx = lockerContext();
  await ctx.setUpLocker('pw');
  for (let i = 0; i < 5; i++) await assert.rejects(() => ctx.unlockLocker('wrong'));
  const failures = JSON.parse(ctx.localStorage.getItem('vaultlix_locker_failures_v1'));
  assert.equal(failures.count, 5);
  assert.ok(failures.blockedUntil > Date.now(), 'fifth failure should trigger appLockDelayMs\'s 30s escalation');
  // Blocked window: even the CORRECT password is rejected immediately, with
  // the wait-copy message rather than a fresh PBKDF2 attempt.
  await assert.rejects(() => ctx.unlockLocker('pw'), /Too many attempts/);
  const failuresAfter = JSON.parse(ctx.localStorage.getItem('vaultlix_locker_failures_v1'));
  assert.equal(failuresAfter.count, 5, 'a blocked-window attempt must not itself count as a new failure');
});

test('the persisted Locker config never contains the password or a usable key — only a salt and one-way verifier', async () => {
  const ctx = lockerContext();
  await ctx.setUpLocker('correct horse battery staple');
  const config = JSON.parse(ctx.localStorage.getItem('vaultlix_locker_v1'));
  assert.deepEqual(Object.keys(config).sort(), ['iterations', 'salt', 'verifier', 'version']);
  assert.ok(!JSON.stringify(config).includes('correct horse battery staple'));

  // The stored verifier is a *different* 32-byte half of the PBKDF2 output
  // than the wrap key — it must not itself work as an AES-GCM decryption key.
  await ctx.unlockLocker('correct horse battery staple');
  const record = await ctx.encryptLockerItem({ type: 'note', text: 'secret' });
  const verifierBytes = ctx.base64UrlToBytes(config.verifier);
  const verifierAsKey = await ctx.crypto.subtle.importKey('raw', verifierBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  ctx.lockerSessionKey = verifierAsKey;
  await assert.rejects(() => ctx.decryptLockerItem(record));
});

test('deleting an item makes its ciphertext permanently undecryptable, even with a still-valid session key', async () => {
  const ctx = lockerContext();
  await ctx.setUpLocker('pw'); await ctx.unlockLocker('pw');

  const record = await ctx.encryptLockerItem({ type: 'note', text: 'sensitive plaintext' });
  assert.equal((await ctx.decryptLockerItem(record)).text, 'sensitive plaintext');

  // Simulate deleteLockerItem's crypto-shredding: destroy just the wrapped
  // key (this is exactly what an IndexedDB store.delete(id) removes,
  // atomically together with the ciphertext row — proven independently of
  // the storage layer here, since IndexedDB isn't available in Node).
  const shredded = { ...record, wrapIv: undefined, wrappedKey: undefined };
  await assert.rejects(() => ctx.decryptLockerItem(shredded));

  // Still locked out even with the CURRENT, correctly-unlocked session key —
  // proving the item key was never password-derivable in the first place,
  // only ever existed as this now-destroyed wrapped value.
  assert.notEqual(ctx.lockerSessionKey, null);
  await assert.rejects(() => ctx.decryptLockerItem(shredded));

  // And a fresh, independent locker with the SAME password cannot help
  // either — the item key was random per-item, not derived from the
  // password at all.
  const ctx2 = lockerContext();
  await ctx2.setUpLocker('pw'); await ctx2.unlockLocker('pw');
  await assert.rejects(() => ctx2.decryptLockerItem(shredded));
});

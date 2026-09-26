'use strict';

// Attachments are cached on the device, downloaded only when they come into
// view, retried only when the cause is temporary, and a failure says why. The
// real download functions run here against a fake network and cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

const PREFIX = 'obj:v1:';
function makeWorld(overrides = {}) {
  const calls = { fetch:0, cachePut:[], cacheGet:[] };
  const store = new Map(overrides.cache || []);
  const world = {
    Promise, Error, Number, Set, Map, Math, TextDecoder, AbortController, Blob,
    setTimeout, clearTimeout, JSON, String,
    navigator: { onLine: overrides.onLine !== false },
    ENCRYPTED_ATTACHMENT_PREFIX: PREFIX,
    MAX_ENCRYPTED_ATTACHMENT_BYTES: overrides.maxBytes || 48 * 1024 * 1024,
    ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS: [0, 0, 0, 0],
    ATTACHMENT_STALL_MS: overrides.stallMs || 25000,
    attachmentCacheGet: async (code, id) => { calls.cacheGet.push(id); return store.get(`${code}:${id}`) || null; },
    attachmentCachePut: async (code, id, msgId, text) => { calls.cachePut.push({ code, id, msgId, size:text.length }); store.set(`${code}:${id}`, text); return true; },
    fetch: async (url, init) => { calls.fetch++; return overrides.fetch(url, init, calls.fetch); },
  };
  const context = vm.createContext(world);
  vm.runInContext('const attachmentDownloads = new Map();', context);
  for (const name of ['attachmentFailureReason', 'readAttachmentBody', 'resolveEncryptedAttachment', 'downloadEncryptedAttachment']) {
    const async = client.includes(`async function ${name}(`) ? 'async ' : '';
    vm.runInContext(async + extract(client, name), context);
  }
  return { context, calls, store };
}
const room = { code:'room-a', token:'tok' };
const streamBody = (chunks, headers = {}) => ({
  ok:true, status:200, headers:{ get: name => headers[name] ?? null },
  body:{ getReader() {
    let i = 0;
    return { read: async () => (i < chunks.length ? { done:false, value:new TextEncoder().encode(chunks[i++]) } : { done:true }), cancel: async () => {} };
  } },
});
const statusResponse = status => ({ ok:false, status, headers:{ get:() => null } });
const run = (world, ref = PREFIX + 'att-1', msgId = 'm1', options = {}) =>
  vm.runInContext(`resolveEncryptedAttachment(${JSON.stringify(room)}, ${JSON.stringify(ref)}, ${JSON.stringify(msgId)}, opts)`, Object.assign(world.context, { opts:options }));

test('a cached attachment is returned without touching the network', async () => {
  const w = makeWorld({ cache:[['room-a:att-1', 'v:cached']], fetch: () => { throw new Error('must not fetch'); } });
  assert.equal(await run(w), 'v:cached');
  assert.equal(w.calls.fetch, 0);
});

test('a first download is saved to the cache, tied to its message', async () => {
  const w = makeWorld({ fetch: async () => streamBody(['v:ab', 'cdef']) });
  assert.equal(await run(w), 'v:abcdef');
  assert.deepEqual(w.calls.cachePut, [{ code:'room-a', id:'att-1', msgId:'m1', size:8 }]);
  // and the next open is local
  assert.equal(await run(w), 'v:abcdef');
  assert.equal(w.calls.fetch, 1);
});

test('progress is reported while a large file streams in', async () => {
  const seen = [];
  const w = makeWorld({ fetch: async () => streamBody(['aaaa', 'bbbb', 'cccc'], { 'Content-Length':'12' }) });
  await run(w, PREFIX + 'att-2', 'm2', { onProgress: (received, total) => seen.push([received, total]) });
  assert.deepEqual(seen, [[4, 12], [8, 12], [12, 12]]);
});

test('a temporary server error is retried and then succeeds', async () => {
  const w = makeWorld({ fetch: async (u, i, n) => (n < 3 ? statusResponse(503) : streamBody(['v:ok'])) });
  assert.equal(await run(w), 'v:ok');
  assert.equal(w.calls.fetch, 3);
});

test('an attachment the server no longer has fails as "gone" after the retries', async () => {
  const w = makeWorld({ fetch: async () => statusResponse(404) });
  await assert.rejects(run(w), error => error.reason === 'gone');
  assert.equal(w.calls.fetch, 4);
  assert.equal(w.calls.cachePut.length, 0);
});

test('a refusal is not retried and says so', async () => {
  const w = makeWorld({ fetch: async () => statusResponse(403) });
  await assert.rejects(run(w), error => error.reason === 'denied');
  assert.equal(w.calls.fetch, 1);
});

test('no connection is reported as offline, otherwise as a connection problem', async () => {
  const offline = makeWorld({ onLine:false, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(run(offline), error => error.reason === 'offline');
  const flaky = makeWorld({ onLine:true, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(run(flaky), error => error.reason === 'network');
});

test('busy and overloaded responses are reported as a busy server', async () => {
  for (const status of [429, 500, 503]) {
    const w = makeWorld({ fetch: async () => statusResponse(status) });
    await assert.rejects(run(w), error => error.reason === 'busy', `status ${status}`);
  }
});

test('a download that stops making progress is abandoned, but a slow one is not', async () => {
  // never answers, but honours the abort the stall timer fires
  const stalled = makeWorld({ stallMs:30, fetch: (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  }) });
  await assert.rejects(run(stalled), error => error.reason === 'timeout');
  // delivers a chunk every 20 ms for well over the 30 ms stall window: fine
  const slow = makeWorld({ stallMs:30, fetch: async () => ({
    ok:true, status:200, headers:{ get:() => null },
    body:{ getReader() {
      let i = 0;
      return { read: () => new Promise(resolve => setTimeout(() => resolve(i < 8 ? { done:false, value:new TextEncoder().encode('x') } : { done:true }, i++), 20)), cancel: async () => {} };
    } },
  }) });
  assert.equal(await run(slow), 'xxxxxxxx');
});

test('an oversized attachment is refused, from the header or from the bytes', async () => {
  const header = makeWorld({ maxBytes:10, fetch: async () => streamBody(['x'], { 'Content-Length':'99' }) });
  await assert.rejects(run(header));
  const bytes = makeWorld({ maxBytes:10, fetch: async () => streamBody(['xxxxxx', 'xxxxxx']) });
  await assert.rejects(run(bytes));
});

test('two requests for the same attachment share one download', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const w = makeWorld({ fetch: async () => { await gate; return streamBody(['v:shared']); } });
  const first = run(w), second = run(w);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['v:shared', 'v:shared']);
  assert.equal(w.calls.fetch, 1);
});

test('content that is not an attachment reference passes straight through', async () => {
  const w = makeWorld({ fetch: () => { throw new Error('no'); } });
  assert.equal(await run(w, 'v:inline-ciphertext'), 'v:inline-ciphertext');
});

// ---- wording ----
test('each failure says what happened, and only temporary ones are retried automatically', () => {
  const context = vm.createContext({ escHtml: value => value });
  vm.runInContext(extract(client, 'attachmentUnavailableText'), context);
  vm.runInContext(client.slice(client.indexOf('const ATTACHMENT_UNAVAILABLE_LABELS'), client.indexOf('function attachmentUnavailableText')), context);
  const text = reason => vm.runInContext(`attachmentUnavailableText(${JSON.stringify(reason)})`, context);
  assert.match(text('offline'), /No connection/);
  assert.match(text('timeout'), /timed out/);
  assert.match(text('busy'), /Server busy/);
  assert.match(text('gone'), /No longer available/);
  assert.match(text('denied'), /Not allowed/);
  assert.equal(text(undefined), 'Attachment unavailable — tap to retry');
  assert.match(client, /ATTACHMENT_TRANSIENT_REASONS = new Set\(\['offline', 'network', 'timeout', 'busy', 'failed'\]\)/);
});

// ---- wiring ----
test('restoring history never downloads media; placeholders load as they scroll into view', () => {
  assert.doesNotMatch(client, /restoreBatch\(attachmentMessages\)/);
  assert.match(client, /const ATTACHMENT_LOAD_CONCURRENCY = 2;/);
  assert.match(client, /attachmentLoadObserver = new IntersectionObserver/);
  assert.match(client, /scheduleAttachmentLoads\(body, room\);/);
  // newest first: what the reader is looking at
  assert.match(client, /const job = attachmentLoadQueue\.pop\(\);/);
});

test('a loaded attachment replaces its placeholder in place without moving the reader', () => {
  assert.match(client, /function replaceRenderedMessage\(room, rec\)/);
  assert.match(client, /if \(isRoomVisible\(room\)\) replaceRenderedMessage\(room, restored\);/);
  assert.match(client, /body\.scrollTop = previousTop \+ \(oldAbove && div \? div\.getBoundingClientRect\(\)\.height - oldRect\.height : 0\);/);
});

test('failed attachments are retried when the connection returns, the app resumes or the chat opens', () => {
  assert.match(client, /window\.addEventListener\('online', \(\) => retryTransientAttachments\(getActiveRoom\(\)\)\);/);
  assert.match(client, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) retryTransientAttachments\(getActiveRoom\(\)\); \}\);/);
  assert.match(client, /renderChatBody\(room\);\s*\n\s*retryTransientAttachments\(room\);/);
  assert.match(client, /const ATTACHMENT_AUTO_RETRIES = 3;/);
});

test('our own sent attachments are cached on upload, and deleting a message deletes its cached copy', () => {
  assert.match(client, /attachmentCachePut\(room\.code, prepared\.attachmentId, msgId, ciphertext\)/);
  assert.match(client, /function historyStoreDelete\(code, id\) \{\s*if \(!code \|\| !id\) return;\s*attachmentCacheDeleteForMessage\(code, id\);/);
  assert.match(client, /function historyStoreClearRoom\(code\) \{\s*if \(!code\) return;\s*attachmentCacheClearRoom\(code\);/);
});

test('the cache is bounded and evicts least recently used items', () => {
  assert.match(client, /const ATTACHMENT_CACHE_MAX_BYTES = 600 \* 1024 \* 1024;/);
  assert.match(client, /index\('byAccess'\)\.getAll\(\)/);
  assert.match(client, /ATTACHMENT_CACHE_MAX_BYTES \* 0\.9/);
  assert.match(client, /estimate\.quota \* 0\.85/);
});

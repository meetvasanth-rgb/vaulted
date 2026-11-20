const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const client = fs.readFileSync(require('node:path').join(__dirname, '../client/index.html'), 'utf8');
function backfillContext(ciphertext) {
  const jobs = [], writes = [], decodes = [];
  let erased = false;
  const ctx = vm.createContext({
    enqueueMediaPreviewBackfill: (_key, work) => jobs.push(work),
    isChatConcealed: () => false,
    historyStoreLoad: async () => [{ id:'old-photo', type:'message', content:'obj:v1:local-file', from:'me', ts:1 }],
    secureNativeLoadMessages: async () => [], parseSecureNativeHistory: (_room, rows) => rows,
    HISTORY_LOAD_LIMIT:50, ENCRYPTED_ATTACHMENT_PREFIX:'obj:v1:',
    nativeMessageCacheEligible: () => true, cacheRecordErased: () => erased,
    attachmentCacheGet: async () => ciphertext, formatMsgTime: () => '12:00',
    processIncomingContent: async (...args) => { decodes.push(args); return {id:'old-photo', kind:'file'}; },
    queueSecureNativeMediaPreview: async (_room, rec) => writes.push(rec),
    fetch: () => { throw new Error('Backfill must never fetch'); },
  });
  vm.runInContext(client.slice(client.indexOf('function scheduleRoomPreviewBackfill('), client.indexOf('// Prime recent conversations')), ctx);
  return { ctx, jobs, writes, decodes, erase: () => { erased = true; } };
}
test('legacy media without local ciphertext is skipped without decryption or network', async () => {
  const run = backfillContext(null);
  run.ctx.scheduleRoomPreviewBackfill({code:'room', sharedKey:{}});
  while (run.jobs.length) await run.jobs.shift()();
  assert.equal(run.decodes.length, 0);
  assert.equal(run.writes.length, 0);
});
test('legacy media backfill passes existing ciphertext directly into decryption', async () => {
  const run = backfillContext('encrypted-local-file');
  run.ctx.scheduleRoomPreviewBackfill({code:'room', token:'me', sharedKey:{}});
  while (run.jobs.length) await run.jobs.shift()();
  assert.equal(run.decodes[0].at(-1), 'encrypted-local-file');
  assert.equal(run.writes.length, 1);
  assert.equal(run.writes[0].isMe, true);
});
test('a message deleted while waiting for idle is never backfilled', async () => {
  const run = backfillContext('encrypted-local-file');
  run.ctx.scheduleRoomPreviewBackfill({code:'room', sharedKey:{}});
  await run.jobs.shift()();
  run.erase();
  while (run.jobs.length) await run.jobs.shift()();
  assert.equal(run.writes.length, 0);
});
test('replacement readiness waits for decoding and rejects failed images', async () => {
  const ctx = vm.createContext({setTimeout, clearTimeout});
  vm.runInContext(client.slice(client.indexOf('async function decodeReplacementImages('), client.indexOf('async function replaceRenderedMessage(')), ctx);
  let release;
  const ready = ctx.decodeReplacementImages({querySelectorAll: () => [{decode: () => new Promise(resolve => {release = resolve;})}]});
  let finished = false;
  ready.then(() => {finished = true;});
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  assert.equal(await ready, true);
  assert.equal(await ctx.decodeReplacementImages({querySelectorAll: () => [{decode: async () => {throw Error('bad image');}}]}), false);
});

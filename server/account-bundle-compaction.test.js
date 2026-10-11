const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('account backup compaction begins before the server ceiling and retries safely', () => {
  assert.match(client, /ACCOUNT_BUNDLE_COMPACT_AT_CHARS = Math\.floor\(6\.5 \* 1024 \* 1024\)/);
  assert.match(client, /ACCOUNT_BUNDLE_MAX_CHARS = 8 \* 1024 \* 1024/);
  assert.match(client, /const mediaFree = accountBundleWithoutMedia\(snapshot\);\s*let bundle = await aesEncryptJson\(keyBytes, mediaFree\)/);
  assert.match(client, /if \(bundle\.length < ACCOUNT_BUNDLE_COMPACT_AT_CHARS\) return bundle/);
  assert.match(client, /compactAccountBundleSnapshot\(mediaFree\)/);
  assert.match(client, /compactAccountBundleSnapshot\(mediaFree, true\)/);
  assert.match(client, /error\.accountBundleTooLarge = true/);
});

test('compaction removes only refreshable display and bounded bookkeeping data', () => {
  const start = client.indexOf('function accountBundleWithoutMedia(');
  const end = client.indexOf('async function encryptAccountBundleForUpload', start);
  const compact = client.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(compact, /delete mediaFree\.peerProfileImage/);
  assert.match(compact, /delete mediaFree\.profileImage/);
  assert.match(compact, /ids:\[\], seenBefore:/);
  assert.doesNotMatch(compact, /delete compacted\.(?:token|pubJwk|privJwk|lastKnownPeerPubKey)/);
  assert.doesNotMatch(compact, /delete compacted\.deleteLedger/);
});

test('compaction leaves the original snapshot and all recovery credentials intact', () => {
  const start = client.indexOf('const ACCOUNT_BUNDLE_COMPACT_AT_CHARS');
  const end = client.indexOf('async function encryptAccountBundleForUpload', start);
  const source = `${client.slice(start, end)}\nresult = compactAccountBundleSnapshot(input, true, now);`;
  const input = {
    v:1,
    sessions:[{
      code:'room-1', token:'member-token', ownerAccountId:'account-1',
      pubJwk:{ x:'public-x', y:'public-y' }, privJwk:{ d:'private-d', x:'public-x', y:'public-y' },
      lastKnownPeerPubKey:{ x:'peer-x', y:'peer-y' }, deleteLedger:{ deleted:123 },
      peerProfileImage:'data:image/jpeg;base64,large-cache',
    }],
    inbox:{ pubJwk:{ x:'inbox-x' }, privJwk:{ d:'inbox-private' } },
    groups:[{ id:'group-1', keys:{ 1:'group-secret' }, members:[{ accountId:'friend', profileImage:'data:image/webp;base64,group-cache' }] }],
    missedCalls:{ v:1, ids:['old-call'], seenBefore:10 },
    achievements:{ v:1, rooms:{ 'room-1':{ textCount:900, countedTextIds:['a','b'], activeDays:{} } } },
    recoveryCodeWrap:'encrypted-recovery-code',
  };
  const context = {
    input,
    now:987654321,
    result:null,
    Date,
    Math,
    Object,
    Array,
    achievementDayNumber:timestamp => Math.floor(timestamp / 86400000),
  };
  vm.runInNewContext(source, context);

  assert.equal(context.result.sessions[0].peerProfileImage, undefined);
  assert.equal(input.sessions[0].peerProfileImage, 'data:image/jpeg;base64,large-cache');
  assert.equal(context.result.sessions[0].token, 'member-token');
  assert.equal(context.result.sessions[0].privJwk.d, 'private-d');
  assert.equal(context.result.sessions[0].lastKnownPeerPubKey.x, 'peer-x');
  assert.deepEqual(context.result.sessions[0].deleteLedger, { deleted:123 });
  assert.equal(context.result.inbox.privJwk.d, 'inbox-private');
  assert.equal(context.result.groups[0].keys[1], 'group-secret');
  assert.equal(context.result.groups[0].members[0].profileImage, undefined);
  assert.equal(input.groups[0].members[0].profileImage, 'data:image/webp;base64,group-cache');
  assert.equal(context.result.recoveryCodeWrap, 'encrypted-recovery-code');
  assert.equal(context.result.achievements.rooms['room-1'].textCount, 900);
  assert.deepEqual(Array.from(context.result.achievements.rooms['room-1'].countedTextIds), []);
});

test('registration, recovery rotation, initial sync and merge retry all use compactable bundles', () => {
  const calls = client.match(/encryptAccountBundleForUpload\(/g) || [];
  // Function declaration plus four upload paths.
  assert.equal(calls.length, 5);
  assert.match(client, /lastAccountSyncFailure = \{ status:e\?\.accountBundleTooLarge \? 413 : 0/);
});

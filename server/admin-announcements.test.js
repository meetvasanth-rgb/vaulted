const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAnnouncement, selectAnnouncementTargets, buildAnnouncementPayload, decodeAnnouncementMedia, validateAnnouncementExperience } = require('./admin-announcements');

test('announcement validation protects an all-user broadcast and normalizes copy', () => {
  assert.match(validateAnnouncement({}).error, /title/i);
  assert.match(validateAnnouncement({ title:'Update', body:'Ready', platform:'all', audience:'all' }).error, /confirm/i);
  const result = validateAnnouncement({ title:'  A new   Vaultlix update ', body:'  Open it   today. ', platform:'all', audience:'all', confirmAll:true });
  assert.deepEqual(result.value, { title:'A new Vaultlix update', body:'Open it today.', platform:'all', audience:'all' });
});

test('announcement targets are restricted by audience and platform and deduplicated', () => {
  const shared = { platform:'ios', apnsToken:'ios-token' };
  const accounts = new Map([
    ['test-one', { isTestAccount:true, pushDestinations:[shared, { platform:'android', fcmToken:'android-test' }] }],
    ['test-two', { isTestAccount:true, pushDestinations:[{ ...shared }] }],
    ['real', { isTestAccount:false, pushDestinations:[{ platform:'android', fcmToken:'android-real' }] }],
  ]);
  assert.deepEqual(selectAnnouncementTargets(accounts, { audience:'test', platform:'ios' }).map(target => target.accountId), ['test-one']);
  assert.deepEqual(selectAnnouncementTargets(accounts, { audience:'test', platform:'all' }).map(target => target.accountId), ['test-one', 'test-one']);
  assert.equal(selectAnnouncementTargets(accounts, { audience:'all', platform:'all' }).length, 3);
});

test('announcement payload is display-only and carries no conversation data', () => {
  const payload = buildAnnouncementPayload({ id:'56fdc337-4d75-4eaf-9022-74b85945e86a', title:'Vaultlix update', body:'A faster app is ready.' });
  assert.equal(payload.announcement, true);
  assert.equal(payload.updateId, '56fdc337-4d75-4eaf-9022-74b85945e86a');
  assert.equal(payload.thumbnailUrl, 'https://vaultlix.com/icons/icon-192.png');
  assert.match(payload.tag, /^vaultlix-update-/);
  assert.equal(payload.code, undefined);
  assert.equal(payload.msgId, undefined);
});

test('ephemeral update options and media are validated before storage', () => {
  assert.deepEqual(validateAnnouncementExperience({ viewOnce:true, expiryHours:12 }).value, { viewOnce:true, expiryHours:12 });
  assert.match(validateAnnouncementExperience({ expiryHours:0 }).error, /expiry/i);
  const media = decodeAnnouncementMedia(`data:video/mp4;base64,${Buffer.from('small-video').toString('base64')}`);
  assert.equal(media.value.kind, 'video');
  assert.equal(media.value.contentType, 'video/mp4');
  assert.match(decodeAnnouncementMedia('data:text/html;base64,PGgxPg==').error, /JPEG|PNG|WebP|MP4/);
});

test('announcement endpoint requires admin authentication and never defaults to all users', { timeout:15000 }, async t => {
  const { spawn } = require('node:child_process');
  const { mkdtemp, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const net = require('node:net');
  const port = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const value=server.address().port; server.close(() => resolve(value)); });
  });
  const directory = await mkdtemp(join(tmpdir(), 'vaultlix-announcement-'));
  const vapid = require('web-push').generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], { cwd:join(__dirname, '..'), env:{ ...process.env, NODE_ENV:'test', PORT:String(port), ADMIN_KEY:'announcement-test-key', DATABASE_URL:'', REDIS_URL:'', SNAPSHOT_DIR:directory, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey }, stdio:'ignore' });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } await rm(directory, { recursive:true, force:true }); });
  const url = `http://127.0.0.1:${port}/api/admin/announcements`;
  for (let i=0;i<60;i++) { try { await fetch(`http://127.0.0.1:${port}/api/admin/health`); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  const send = async (body, key='announcement-test-key') => {
    const response = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json', ...(key ? { Authorization:`Bearer ${key}` } : {}) }, body:JSON.stringify(body) });
    return { status:response.status, data:await response.json().catch(() => ({})) };
  };
  assert.equal((await send({ title:'Update', body:'Ready', platform:'all', audience:'test' }, '')).status, 404);
  assert.equal((await send({ title:'Update', body:'Ready', platform:'all', audience:'all' })).status, 400);
  const testSend = await send({ title:'Update', body:'Ready', platform:'all', audience:'test' });
  assert.equal(testSend.status, 200);
  assert.deepEqual({ targeted:testSend.data.targeted, delivered:testSend.data.delivered, audience:testSend.data.audience }, { targeted:0, delivered:0, audience:'test' });
});

test('admin screen exposes the protected composer and defaults it to test accounts', () => {
  const html = require('node:fs').readFileSync('client/admin.html', 'utf8');
  const script = require('node:fs').readFileSync('client/admin.js', 'utf8');
  assert.match(html, /id="announcement-form"/);
  assert.match(html, /id="announcement-preview-icon" class="announcement-icon" src="\/icons\/icon-192\.png"/);
  assert.match(html, /id="announcement-thumbnail"/);
  assert.match(html, /id="announcement-media"/);
  assert.match(html, /id="announcement-view-once"[^>]+checked/);
  assert.match(html, /id="announcement-expiry"/);
  assert.match(html, /id="announcement-schedule-enabled"/);
  assert.match(html, /<option value="test">Test accounts<\/option><option value="all">/);
  assert.match(script, /Schedule.*Publish.*update for every opted-in Vaultlix app device/s);
  assert.match(script, /fetch\('\/api\/admin\/announcements'/);
});

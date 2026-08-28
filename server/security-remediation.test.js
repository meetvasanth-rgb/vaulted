'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const webpush = require('web-push');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(base, pathname, { body, headers = {} } = {}) {
  const response = await fetch(base + pathname, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, data: await response.text() };
}

test('Tier 1 security remediations enforce limits and keep install scripts local', { timeout: 15000 }, async t => {
  const appPort = await freePort();
  const turnPort = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-security-test-'));
  const vapid = webpush.generateVAPIDKeys();
  let turnRequests = 0;
  const turnServer = http.createServer((req, res) => {
    turnRequests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ iceServers: [{ urls: ['turn:example.test'] }] }));
  });
  await new Promise((resolve, reject) => turnServer.listen(turnPort, '127.0.0.1', resolve).once('error', reject));

  const adminKey = 'test-admin-key-with-at-least-32-characters';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(appPort),
      SNAPSHOT_DIR: snapshotDir,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      ADMIN_KEY: adminKey,
      TEST_ADMIN_AUTH_WINDOW_MS: '100',
      CF_TURN_KEY_ID: 'test-key-id',
      CF_TURN_KEY_API_TOKEN: 'test-api-token',
      TEST_CF_TURN_API_BASE: `http://127.0.0.1:${turnPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => turnServer.close(resolve));
    await rm(snapshotDir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes(`Vaultlix on port ${appPort}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });

  const base = `http://127.0.0.1:${appPort}`;
  const created = JSON.parse((await request(base, '/api/create', { body: { name: 'Security test' } })).data);
  for (let i = 0; i < 6; i++) {
    const result = await request(base, '/api/turn-credentials', {
      body: { code: created.code, token: created.token },
    });
    assert.equal(result.response.status, 200);
  }
  const blockedTurn = await request(base, '/api/turn-credentials', {
    body: { code: created.code, token: created.token },
  });
  assert.equal(blockedTurn.response.status, 429);
  assert.equal(turnRequests, 6, 'blocked TURN request must not reach Cloudflare');

  const attackerHeaders = { 'x-forwarded-for': '198.51.100.10' };
  for (let i = 0; i < 10; i++) {
    const wrong = await request(base, '/api/admin/stats', {
      headers: { ...attackerHeaders, authorization: `Bearer wrong-${i}` },
    });
    assert.equal(wrong.response.status, 404);
    assert.equal(wrong.data, '');
  }
  const correctEleventh = await request(base, '/api/admin/stats', {
    headers: { ...attackerHeaders, authorization: `Bearer ${adminKey}` },
  });
  assert.equal(correctEleventh.response.status, 404, 'correct key must remain blocked after ten failures');
  await new Promise(resolve => setTimeout(resolve, 150));
  const afterExpiry = await request(base, '/api/admin/stats', {
    headers: { ...attackerHeaders, authorization: `Bearer ${adminKey}` },
  });
  assert.equal(afterExpiry.response.status, 200, 'expired failure window must reset');

  for (let i = 0; i < 12; i++) {
    const valid = await request(base, '/api/admin/stats', {
      headers: { 'x-forwarded-for': '198.51.100.20', authorization: `Bearer ${adminKey}` },
    });
    assert.equal(valid.response.status, 200, 'successful admin requests must not consume failure budget');
  }

  const install = await request(base, '/install');
  assert.equal(install.response.status, 200);
  assert.match(install.data, /src="\/vendor\/qrcode\.min\.js"/);
  assert.doesNotMatch(install.data, /cdnjs\.cloudflare\.com/);
  assert.match(install.response.headers.get('content-security-policy') || '', /script-src 'self'/);
  const qrAsset = await request(base, '/vendor/qrcode.min.js');
  assert.equal(qrAsset.response.status, 200);
  assert.match(qrAsset.data, /QRCode/);

  const walkthroughVideo = await fetch(base + '/media/vaultlix-create-connect-walkthrough-human-voice.mp4');
  assert.equal(walkthroughVideo.status, 200);
  assert.equal(walkthroughVideo.headers.get('content-type'), 'video/mp4');
  await walkthroughVideo.body.cancel();
  const walkthroughPoster = await fetch(base + '/media/vaultlix-walkthrough-poster.jpg');
  assert.equal(walkthroughPoster.status, 200);
  assert.equal(walkthroughPoster.headers.get('content-type'), 'image/jpeg');
  await walkthroughPoster.body.cancel();
});

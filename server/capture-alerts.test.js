'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const webpush = require('web-push');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client', 'groups.js'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body),
  });
  return { status:response.status, data:await response.json() };
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('capture pushes are generic and are never swallowed by a recent foreground poll', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extractFunction(server, 'shouldSendMessagePush')}\n${extractFunction(server, 'messageNotificationBody')}`, context);
  assert.equal(context.shouldSendMessagePush('screenshot', 95_000, 100_000), true);
  assert.equal(context.shouldSendMessagePush('screenshot', 92_000, 100_000), true);
  assert.equal(context.shouldSendMessagePush(null, 99_999, 100_000), true);
  assert.equal(context.messageNotificationBody('screenshot', 'Priya'), 'A screenshot was taken in your private conversation.');
  assert.equal(context.messageNotificationBody('screen-recording', 'Priya'), 'Screen recording started in your private conversation.');
  assert.doesNotMatch(context.messageNotificationBody('screenshot', 'Priya'), /Priya/);
});

test('Android keeps capture alerts visible and preserves their privacy-safe wording', () => {
  const service = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'VaultlixMessagingService.java'), 'utf8');
  assert.match(server, /privacyEvent: parsed\.privacyEvent === 'screenshot'/);
  assert.match(server, /msgId, privacyEvent, hidePreview/);
  assert.match(server, /privacyEvent === 'screenshot' \? 'Screenshot detected'/);
  assert.match(server, /hidePreview:!!privacyEvent \|\| mb\.hidePreview === true/);
  assert.match(service, /boolean privacyAlert = "screenshot"\.equals\(privacyEvent\) \|\| "screen-recording"\.equals\(privacyEvent\)/);
  assert.match(service, /MainActivity\.isAppInForeground\(\) && !privacyAlert/);
  assert.match(service, /if \(privacyAlert\) \{/);
});

test('direct and group capture events remain encrypted message content', () => {
  assert.match(client, /encryptMsg\(room, JSON\.stringify\(\{ type:'capture-event', event:type \}\)\)/);
  assert.match(client, /parsed\.type === 'capture-event'/);
  assert.match(groups, /encryptPrivateGroupValue\(key, \{ type:'group-capture-event', event:type \}\)/);
  assert.match(groups, /metadata\?\.type === 'group-capture-event'/);
  assert.match(server, /content: messageContent, attachmentId, viewOnce: !!d\.viewOnce, privacyEvent/);
});

test('native platforms emit only capture type and recording state', () => {
  assert.match(ios, /UIApplication\.userDidTakeScreenshotNotification/);
  assert.match(ios, /UIScreen\.capturedDidChangeNotification/);
  assert.doesNotMatch(ios, /screenshotData|capturedImage/);
  assert.match(android, /registerScreenCaptureCallback/);
  assert.match(android, /addScreenRecordingCallback/);
  assert.match(manifest, /android\.permission\.DETECT_SCREEN_CAPTURE/);
  assert.match(manifest, /android\.permission\.DETECT_SCREEN_RECORDING/);
  assert.doesNotMatch(android, /MediaStore|ImageReader/);
});

test('the web bridge requires a visible conversation and deduplicates recording start', () => {
  assert.match(client, /document\.hidden \|\| !tabFocused/);
  assert.match(client, /if \(active === nativeScreenRecordingActive\) return/);
  assert.match(client, /if \(document\.hidden\) nativeScreenRecordingActive = false/);
  assert.match(client, /classList\.contains\('open'\)/);
  assert.match(client, /rec\.timerEvent === true \|\| rec\.contactEvent === true \|\| rec\.captureEvent/);
  assert.match(client, /pendingNativeScreenRecordingAlert = true/);
  assert.match(client, /queueMicrotask\(flushPendingNativeScreenRecordingAlert\)/);
});

test('capture alerts are durable security events rather than ordinary deletable messages', () => {
  assert.match(server, /deleteTimerSeconds:privacyEvent \? 0/);
  assert.match(server, /room\.msgs = room\.msgs\.filter\(isPrivacyCaptureEvent\)/);
  assert.match(server, /Screenshot and screen-recording alerts cannot be deleted/);
  assert.match(server, /hasUnacknowledgedPrivacyCaptureEventFrom\(room, d\.token\)/);
  assert.match(client, /room\.messages = room\.messages\.filter\(record => record\.captureEvent\)/);
  assert.match(client, /if \(closeResult\?\.error\) \{ toast\(closeResult\.error\); return; \}/);
  assert.match(postgres, /privacy_event varchar\(24\)/);
  assert.match(postgres, /DELETE FROM encrypted_messages WHERE conversation_id=\$1 AND privacy_event IS NULL/);
  assert.match(postgres, /m\.delete_timer_seconds>0 AND m\.privacy_event IS NULL/);
});

test('clear and close cannot hide an unread direct-chat capture alert', { timeout:20000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'vaultlix-capture-integrity-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:root,
    env:{ ...process.env, NODE_ENV:'test', ADMIN_KEY:'capture-integrity-test', PORT:String(port), SNAPSHOT_DIR:snapshotDir,
      VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(snapshotDir, { recursive:true, force:true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const sender = (await post(base, '/api/create', { name:'Sender', pubKey:'sender-key' })).data;
  const recipient = (await post(base, '/api/join', { name:'Recipient', pubKey:'recipient-key', code:sender.code })).data;
  await post(base, '/api/set-timer', { code:sender.code, token:sender.token, deleteTimer:60 });
  const msgId = 'capture-event-000001';
  assert.equal((await post(base, '/api/send', {
    code:sender.code, token:sender.token, msgId, content:'v:encrypted-capture-event', privacyEvent:'screenshot',
  })).status, 200);

  assert.equal((await post(base, '/api/clear-chat', { code:sender.code, token:sender.token })).status, 200);
  const deletion = await post(base, '/api/delete-message', { code:sender.code, token:sender.token, msgId });
  assert.equal(deletion.status, 409);
  assert.equal(deletion.data.error, 'Screenshot and screen-recording alerts cannot be deleted.');
  const prematureClose = await post(base, '/api/close', { code:sender.code, token:sender.token });
  assert.equal(prematureClose.status, 409);
  assert.equal(prematureClose.data.pendingPrivacyAlert, true);

  const received = await post(base, '/api/poll', { code:sender.code, token:recipient.token, lastSeq:0, full:1 });
  const alert = received.data.messages.find(message => message.id === msgId);
  assert.ok(alert, 'the recipient still receives the alert after clear chat');
  assert.equal(alert.privacyEvent, 'screenshot');
  assert.equal(alert.deleteTimerSeconds, 0);
  assert.equal((await post(base, '/api/read', { code:sender.code, token:recipient.token, msgIds:[msgId] })).status, 200);
  assert.equal((await post(base, '/api/close', { code:sender.code, token:sender.token })).status, 200);
});

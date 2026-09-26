const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'client', 'sw.js'), 'utf8');

test('New Connection opens a local rear-camera QR scanner', () => {
  assert.match(html, /Scan QR with camera/);
  assert.match(html, /id="private-number-scanner-video"[^>]*playsinline[^>]*autoplay/);
  assert.match(html, /navigator\.mediaDevices\.getUserMedia\(\{/);
  assert.match(html, /facingMode:\{ ideal:'environment' \}/);
  assert.match(html, /window\.jsQR\(pixels\.data, pixels\.width, pixels\.height/);
  assert.match(html, /await openQuickConnectURL\(raw\)/);
  assert.match(html, /video\.controls = false/);
  assert.match(html, /video\.classList\.add\('ready'\)/);
  assert.match(html, /qr-scanner-stage video\{[^}]*opacity:0/);
});

test('scanner camera is stopped on close and when the app is backgrounded', () => {
  assert.match(html, /privateNumberScannerStream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(html, /document\.addEventListener\('visibilitychange'/);
  assert.match(html, /document\.hidden[^\n]+closePrivateNumberScanner\(\)/);
});

test('QR decoder ships in the offline app shell', () => {
  assert.ok(fs.statSync(path.join(root, 'client', 'vendor', 'jsQR.js')).size > 200_000);
  assert.ok(fs.statSync(path.join(root, 'client', 'vendor', 'jsQR.LICENSE.txt')).size > 1_000);
  assert.match(html, /<script src="\/vendor\/jsQR\.js"><\/script>/);
  // Shipped in v63; any newer shell cache still includes it.
  assert.match(sw, /vaultlix-app-shell-v(6[3-9]|[7-9]\d|\d{3,})'/);
  assert.match(sw, /'\/vendor\/jsQR\.js'/);
});

test('keyboard Enter creates a newline while the Vaultlix send buttons send', () => {
  const directComposer = html.match(/<textarea id="msg-input"[^>]*>/)?.[0] || '';
  const groupComposer = html.match(/<textarea id="group-message-input"[^>]*>/)?.[0] || '';
  assert.doesNotMatch(directComposer, /onkeydown=/);
  assert.doesNotMatch(groupComposer, /onkeydown=/);
  assert.doesNotMatch(html, /getElementById\('msg-input'\)\?\.addEventListener\('keydown'/);
  assert.match(html, /id="send-btn"[^>]*onpointerdown="event\.preventDefault\(\)"[^>]*onclick="sendMsg\(\)"/);
  assert.match(html, /class="group-send-btn"[^>]*onpointerdown="event\.preventDefault\(\)"[^>]*onclick="sendPrivateGroupMessage\(\)"/);
});

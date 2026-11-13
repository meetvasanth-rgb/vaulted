const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { compileClientShell, MAIN_SCRIPT_MARKER } = require('./client-shell');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const compiled = compileClientShell({ clientDir:path.join(root, 'client') });
const html = compiled.html.toString();

test('delivery shell is small and keeps the startup cover inline', () => {
  assert.ok(compiled.sourceBytes > 1_000_000);
  assert.ok(compiled.shellBytes < 250_000, `shell is ${compiled.shellBytes} bytes`);
  assert.match(html, /#restore-skeleton-overlay/);
  assert.match(html, /<link rel="stylesheet" href="\/app-shell\.[a-f0-9]{16}\.css">/);
  assert.ok(html.indexOf(`<link rel="preload" as="script" href="${compiled.paths.app}">`) < html.indexOf('</head>'));
});

test('application and QR scripts are extracted byte-for-byte into hashed assets', () => {
  const appAsset = compiled.assets.get(compiled.paths.app).body.toString();
  const qrAsset = compiled.assets.get(compiled.paths.qr).body.toString();
  assert.ok(appAsset.startsWith(`\n${MAIN_SCRIPT_MARKER}`));
  assert.ok(source.includes(appAsset));
  assert.ok(qrAsset.startsWith('\nvar qrcode=(()=>'));
  assert.ok(source.includes(qrAsset));
  assert.ok(appAsset.includes("const VAULTLIX_LANGUAGE_KEY = 'vaultlix_language_v1'"));
  assert.match(appAsset, /function encryptMsg\s*\(/);
  assert.match(appAsset, /function decryptMsg\s*\(/);
});

test('deferred scripts retain their dependency order', () => {
  const expected = [
    compiled.paths.qr,
    '/number-card.js',
    compiled.paths.app,
    '/groups.js',
    '/walkthrough-player.js',
  ];
  let previous = -1;
  for (const scriptPath of expected) {
    const index = html.indexOf(`<script defer src="${scriptPath}"></script>`);
    assert.ok(index > previous, `${scriptPath} is missing or out of order`);
    previous = index;
  }
  assert.doesNotMatch(html, /<script defer src="\/vendor\/jsQR\.js"><\/script>/);
  assert.match(html, /<script type="application\/x-vaultlix-lazy" data-src="\/vendor\/jsQR\.js"><\/script>/);
});

test('service worker recognizes the generated immutable assets', () => {
  const worker = fs.readFileSync(path.join(root, 'client/sw.js'), 'utf8');
  assert.match(worker, /vaultlix-app-shell-v261/);
  assert.match(worker, /shellHtml\.matchAll/);
  assert.match(worker, /compiledAssets\.map\(assetPath => cache\.add\(assetPath\)\)/);
  for (const assetPath of compiled.assets.keys()) {
    if (assetPath.endsWith('.css')) assert.match(assetPath, /^\/app-shell\.[a-f0-9]{16}\.css$/);
    else if (assetPath.startsWith('/vendor/')) assert.match(assetPath, /^\/vendor\/qrcode\.[a-f0-9]{16}\.js$/);
    else assert.match(assetPath, /^\/app-core\.[a-f0-9]{16}\.js$/);
  }
});

test('private-group image presentation cache cannot block opening a group', () => {
  assert.doesNotMatch(source, /profileImage:typeof group\.profileImage/);
  assert.match(source, /A cache write must never prevent an encrypted group from opening/);
  assert.match(source, /continuing without updating it/);
});

test('private-group system notices are not wired as selectable message bubbles', () => {
  const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');
  assert.match(groups, /const card = row\.querySelector\('\.group-message'\);[\s\S]*if \(!card\) return;[\s\S]*attachLongPress\(card/);
});

test('private-group images are not resized and recompressed a second time', () => {
  const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');
  assert.match(groups, /async function compressPrivateGroupProfileImage\(file\) \{[\s\S]*return compressProfileImage\(file\);[\s\S]*\n\}/);
  assert.doesNotMatch(groups, /canvas\.width = 256; canvas\.height = 256/);
  assert.doesNotMatch(groups, /result\.length <= 96 \* 1024/);
});

test('group header image opens the preview for every member', () => {
  assert.match(source, /id="group-chat-avatar"[^>]*onclick="openPrivateGroupProfileImage\(\)"[^>]*aria-label="View group image"/);
});

test('private-group multi-photo sends use one encrypted album and immediate progress', () => {
  const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');
  assert.match(groups, /type:'group-album'/);
  assert.match(groups, /privateGroupAlbumGridHtml/);
  assert.match(groups, /beginPhotoSendProgress\(files\.length/);
  assert.match(source, /await onSend\(caption, viewOnce, message => progress\.update\(message\)\)/);
});

test('direct media picker keeps mixed photos and videos in one album', () => {
  assert.match(source, /media\.push\(\{ kind:'video'/);
  assert.match(source, /kind:kind === 'video'.*\? 'video' : 'image'/);
  assert.match(source, /videoThumb:safeImageDataUri\('image\/jpeg', videoThumb\)/);
  assert.match(source, /handleAlbumItemTap/);
  assert.match(source, /View once is unavailable for multiple selections/);
  assert.match(source, /viewOnce = !!viewOnce && items\.length === 1/);
  assert.match(source, /if \(onlyIsImage\) \{\s*showSendImageOptions\(room, media\)/);
  assert.match(source, /if \(media\.length > 1\) \{\s*await sendAlbumMessage\(room, media, false/);
});

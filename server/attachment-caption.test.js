'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '../client/groups.js'), 'utf8');

function extractFromClient(name) {
  let start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in client/index.html`);
  if (client.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = client.indexOf('(', start);
  let parenDepth = 0;
  for (; i < client.length; i++) {
    if (client[i] === '(') parenDepth++;
    else if (client[i] === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
  }
  i = client.indexOf('{', i);
  let braceDepth = 0;
  for (; i < client.length; i++) {
    if (client[i] === '{') braceDepth++;
    else if (client[i] === '}') { braceDepth--; if (braceDepth === 0) { i++; break; } }
  }
  return client.slice(start, i);
}

// showSendImageOptions is the one piece of the new caption feature small and
// self-contained enough to run for real (it's a DOM-only dialog, no network
// or crypto) — everything downstream of it (sendFileMessage,
// sendAlbumMessage, sendPrivateGroupAttachment) is exercised only through
// structural assertions below, matching this suite's existing convention
// for attachment-pipeline functions too entangled with live chat state to
// extract cleanly (see pdf-preview.test.js, video-attachment-experience.test.js).
function domStub() {
  const buttons = {};
  return {
    document: {
      createElement: () => ({ style: {}, querySelector: key => buttons[key] ||= {}, addEventListener() {}, remove() {} }),
      body: { appendChild() {} },
    },
    buttons,
    safeMessageImagePreview: () => '',
    safeImageDataUri: () => '',
    MEDIA_BLOCKED_HTML: '',
    beginPhotoSendProgress: () => ({ update() {}, close() {} }),
    requestAnimationFrame: fn => fn(),
    setTimeout: fn => fn(),
    toast() {},
  };
}

test('showSendImageOptions groupMode hides the view-once choice and shows a single Send button', async () => {
  // The DOM stub's querySelector fabricates an object for any id regardless
  // of what the real markup contains, so "no view-once button" has to be
  // checked against the rendered innerHTML string itself, not a query result.
  const context = domStub();
  vm.createContext(context);
  vm.runInContext(extractFromClient('showSendImageOptions'), context);
  let overlayHtml = '';
  context.document.createElement = () => ({
    style: {}, querySelector: key => context.buttons[key] ||= {}, addEventListener() {}, remove() {},
    set innerHTML(value) { overlayHtml = value; }, get innerHTML() { return overlayHtml; },
  });
  context.showSendImageOptions(null, [{ file: { type: 'image/jpeg' }, base64: 'a' }], { groupMode: true, onSend: async () => {} });
  assert.ok(!overlayHtml.includes('id="send-img-once"'), 'groupMode must not render a view-once button at all');
  assert.ok(overlayHtml.includes('id="send-img-normal"') && overlayHtml.includes('>Send<'), 'groupMode must render a single plain "Send" button');
  assert.ok(context.buttons['#send-img-normal'].onclick, 'groupMode must still wire up the single Send button');
});

test('showSendImageOptions (1:1 mode) still wires up both the view-once and normal-send buttons', async () => {
  const context = domStub();
  vm.createContext(context);
  vm.runInContext(extractFromClient('showSendImageOptions'), context);
  let sentViewOnce = null;
  context.sendFileMessage = async (...args) => { sentViewOnce = args[4]; return true; };
  context.showSendImageOptions({}, [{ file: { type: 'image/jpeg' }, base64: 'a' }]);
  await context.buttons['#send-img-once'].onclick();
  assert.equal(sentViewOnce, true, 'the view-once button must send with viewOnce=true');
});

test('the caption typed into showSendImageOptions is trimmed and passed through to onSend/sendFileMessage/sendAlbumMessage', async () => {
  // groupMode/onSend path (what handlePrivateGroupFileSelect uses)
  const groupCtx = domStub();
  vm.createContext(groupCtx);
  vm.runInContext(extractFromClient('showSendImageOptions'), groupCtx);
  let captured = null;
  // The stub only creates a button's entry the first time showSendImageOptions
  // itself queries that id — pre-seed it so sendAll's later
  // querySelector('#send-img-caption') finds this same object (buttons[key]
  // ||= {} only assigns when nothing is there yet).
  groupCtx.buttons['#send-img-caption'] = { value: '  Finished my 7km jogging today!  ' };
  groupCtx.showSendImageOptions(null, [{ file: { type: 'image/jpeg' }, base64: 'a' }], {
    groupMode: true, onSend: async caption => { captured = caption; },
  });
  await groupCtx.buttons['#send-img-normal'].onclick();
  assert.equal(captured, 'Finished my 7km jogging today!', 'caption must be trimmed before being handed off');

  // Default 1:1 path (calls sendFileMessage directly)
  const directCtx = domStub();
  vm.createContext(directCtx);
  vm.runInContext(extractFromClient('showSendImageOptions'), directCtx);
  let sentCaption = null;
  directCtx.sendFileMessage = async (...args) => { sentCaption = args[11]; return true; };
  directCtx.buttons['#send-img-caption'] = { value: 'A single photo caption' };
  directCtx.showSendImageOptions({}, [{ file: { type: 'image/jpeg' }, base64: 'a' }]);
  await directCtx.buttons['#send-img-normal'].onclick();
  assert.equal(sentCaption, 'A single photo caption');
});

test('a message with no caption text sends an empty string, not undefined/null', async () => {
  const context = domStub();
  vm.createContext(context);
  vm.runInContext(extractFromClient('showSendImageOptions'), context);
  let sentCaption = 'not yet set';
  context.sendFileMessage = async (...args) => { sentCaption = args[11]; return true; };
  context.showSendImageOptions({}, [{ file: { type: 'image/jpeg' }, base64: 'a' }]);
  await context.buttons['#send-img-normal'].onclick();
  assert.equal(sentCaption, '');
});

// ── Structural assertions for the parts too entangled with live chat state,
// network and crypto to run standalone (encryptMsg, uploadEncryptedAttachment,
// the real DOM chat body, group's own send/decrypt pipeline).
test('caption is threaded through the 1:1 send payload, local echo record, and incoming-message parser', () => {
  assert.match(client, /async function sendFileMessage\([^)]*caption\s*=\s*''\s*\)/);
  assert.match(client, /const payload = JSON\.stringify\(\{[^}]*caption:safeCaption/s);
  assert.match(client, /const rec = \{[\s\S]{0,400}caption:safeCaption/);
  assert.match(client, /async function sendAlbumMessage\([^)]*caption\s*=\s*''\s*\)/);
  assert.match(client, /type: 'album',\s*\n\s*viewOnce: !!viewOnce,\s*\n\s*caption: safeCaption/);
  assert.match(client, /const caption = typeof parsed\.caption === 'string' \? parsed\.caption\.slice\(0, 2000\) : '';/);
  assert.match(client, /caption: typeof parsed\.caption === 'string' \? parsed\.caption\.slice\(0, 2000\) : ''/);
});

test('an un-revealed view-once photo never leaks its caption before the photo itself is opened', () => {
  assert.match(client, /const captionHiddenByViewOnce = rec\.isImage && rec\.viewOnce && !rec\.isMe && !rec\.viewed;/);
  assert.match(client, /const captionHtml = rec\.caption && !captionHiddenByViewOnce/);
  assert.match(client, /const albumCaptionHiddenByViewOnce = rec\.viewOnce && !rec\.isMe && !\(rec\.images \|\| \[\]\)\.some\(img => img\.viewed\);/);
});

test('the caption bubble is only appended when a caption exists, reusing the same escaped .bubble markup as text messages', () => {
  assert.match(client, /captionHtml = rec\.caption && !captionHiddenByViewOnce \? `<div class="bubble">\$\{escHtml\(rec\.caption\)\}<\/div>` : '';/);
});

test('private groups: handlePrivateGroupFileSelect batches picked images into one caption-entry dialog instead of sending each immediately', () => {
  assert.match(groups, /const imageItems = \[\];/);
  assert.match(groups, /imageItems\.push\(\{ file, base64: compressed\.base64, mime: compressed\.mime, imagePreview: null \}\);/);
  assert.match(groups, /showSendImageOptions\(null, imageItems, \{\s*\n\s*groupMode: true,/);
  // Non-image attachments (video/pdf/generic file) must be completely
  // unaffected — still sent immediately per file, exactly as before.
  assert.match(groups, /await sendPrivateGroupAttachment\(\{ type:'group-file',/);
});

test('private groups: an incoming attachment caption is bounded/sanitized the same way as 1:1, and rendered with escHtml', () => {
  assert.match(groups, /payload\.caption = typeof payload\.caption === 'string' \? payload\.caption\.slice\(0, 2000\) : '';/);
  assert.match(groups, /if \(message\.attachment\.caption && usable\) content \+= `<div class="group-message-text">\$\{escHtml\(message\.attachment\.caption\)\}<\/div>`;/);
});

test('private groups: sendPrivateGroupAttachment payload carries caption through to the pending optimistic record', () => {
  // sendPrivateGroupAttachment spreads its whole `payload` argument straight
  // into both the pending local record and the encrypted wire payload, so a
  // caption included by the caller (handlePrivateGroupFileSelect) needs no
  // separate plumbing here — confirm that spread is still exactly what it
  // was before this feature (a regression here would silently drop captions).
  assert.match(groups, /const pending = \{ id:messageId, senderId:state\.accountId, attachmentId:null, attachment:payload,/);
});

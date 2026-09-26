'use strict';

// Messages are controlled the way WhatsApp does it: long-press selects (top bar,
// emoji bar, tinted row), a tap opens photos, videos and files and does nothing on
// plain text, and the old inline action rows with badge icons are gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');

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

test('the old inline action row, its badge icons and the reaction picker are gone', () => {
  for (const name of ['msgActionBtn', 'buildMsgActionsHtml', 'toggleMsgActions', 'MSG_ACTION_ICONS']) {
    assert.doesNotMatch(client, new RegExp(name), name);
    assert.doesNotMatch(groups, new RegExp(name), name);
  }
  assert.doesNotMatch(extract(client, 'renderMessageRecord'), /msg-actions|reaction-picker/);
  assert.doesNotMatch(client, /<div class="select-bar"|class="group-select-bar"|msg-select-badge"/);
  assert.doesNotMatch(client, /body\.select-mode \.chat-ftr\{display:none\}/, 'the composer stays visible while selecting');
});

test('long-press selects; a tap on text does nothing unless a selection is under way', () => {
  assert.match(client, /else if \(selectMode\) toggleMessageSelection\(msgId\); else enterSelectMode\(msgId\);/);
  const wire = extract(client, 'wireMsgActions');
  assert.match(wire, /if \(media\) attachLongPress\(media, msgId\);\s*if \(textBubble\) attachLongPress\(textBubble, msgId\);/);
  assert.match(wire, /if \(wasJustLongPressed\(\)\) return;\s*if \(selectMode\) toggleMessageSelection\(msgId\);/);
  assert.doesNotMatch(wire, /toggleMsgActions|actions\.querySelector/);
});

test('photos, videos and files still open on a tap, and toggle instead while selecting', () => {
  for (const fn of ['handleImageTap', 'handleAlbumImageTap']) {
    assert.match(extract(client, fn), /if \(selectMode\) \{ toggleMessageSelection\(msgId\); return; \}/, fn);
  }
  assert.match(groups, /if \(groupSelectMode\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); togglePrivateGroupSelection\(id\); \}/);
});

test('the selection bar has back, count, reply, delete, forward and more; the emoji bar floats above the message', () => {
  const ui = extract(client, 'ensureMessageSelectionUi');
  for (const action of ['cancel', 'reply', 'delete', 'forward', 'more']) assert.match(ui, new RegExp(`data-sel="${action}"`), action);
  assert.match(ui, /id="msg-selection-count"/);
  assert.match(extract(client, 'positionMessageReactionBar'), /let y = anchor\.top - size\.height - 8;\s*if \(y < barBottom \+ 6\) y = Math\.min\(anchor\.bottom \+ 8/);
  // The emoji bar only shows for a single message; reply and forward likewise.
  assert.match(extract(client, 'positionMessageReactionBar'), /state\.count !== 1 \|\| !state\.anchor/);
  assert.match(client, /\.msg\.msg-selected::before,\.group-msg\.msg-selected::before\{content:'';position:absolute;z-index:-1/);
});

test('the bar takes over the chat header at its size and never steals the keyboard', () => {
  const show = extract(client, 'showMessageSelection');
  assert.match(show, /ui\.bar\.style\.height = box && box\.height/);
  assert.match(show, /active\.blur\(\)/);
  assert.match(extract(client, 'ensureMessageSelectionUi'), /addEventListener\('mousedown', event => event\.preventDefault\(\)\)/);
  assert.match(client, /showMessageSelection\(directSelectionController\(\), '#s-chat \.chat-hdr'\)/);
  assert.match(groups, /showMessageSelection\(groupSelectionController\(\), '#group-chat \.group-chat-head'\)/);
});

test('reply and forward rules', () => {
  const context = vm.createContext({});
  vm.runInContext(`${extract(client, 'messageReplyable')}\n${extract(client, 'messageForwardable')}`, context);
  const replyable = kind => vm.runInContext(`messageReplyable({ kind:'${kind}' })`, context);
  assert.equal(replyable('text'), true);
  assert.equal(replyable('file'), true);
  for (const kind of ['blocked', 'attachment-loading', 'attachment-unavailable', 'sys']) assert.equal(replyable(kind), false, kind);
  const forwardable = rec => vm.runInContext(`messageForwardable(${JSON.stringify(rec)})`, context);
  assert.equal(forwardable({ kind:'text' }), true);
  assert.equal(forwardable({ kind:'file' }), true);
  assert.equal(forwardable({ kind:'album' }), true);
  assert.equal(forwardable({ kind:'file', viewOnce:true }), false, 'view-once media is never forwarded');
  assert.equal(forwardable({ kind:'voice' }), false);
});

test('a photo opens with a top bar (back, who, when, save, forward) and a bottom bar (reply, quick reactions)', () => {
  const chrome = extract(client, 'buildViewerChrome');
  for (const marker of ['data-v="back"', 'data-v="save"', 'data-v="forward"', 'class="viewer-reply" data-v="reply"', 'data-v="react"']) assert.ok(chrome.includes(marker), marker);
  assert.match(chrome, /const preferred = \['❤️', '😂'\]/);
  assert.match(extract(client, 'handleImageTap'), /viewImage\(original \|\| src, context && !context\.rec\.viewOnce \? \{ info: viewerInfoForRec\(context\.room, context\.rec\) \} : undefined\)/);
  assert.match(extract(client, 'handleAlbumImageTap'), /info: rec\.viewOnce \? undefined : viewerInfoForRec\(room, rec\)/);
  assert.match(groups, /viewImage\(src, \{ zIndex:PRIVATE_GROUP_VIEWER_Z, info:group && message \? privateGroupViewerInfo\(group, message\) : undefined \}\)/);
  const view = extract(client, 'viewImage');
  assert.match(view, /if \(!effectiveHideDownload && !info\)/, 'the old corner Save button gives way to the bar');
  assert.match(view, /if \(e\.target\.closest\('\[data-viewer-ui\]'\)\) return; \/\/ the bars handle their own taps/);
  // View-once photos get no bars, and no way to save or forward them.
  assert.doesNotMatch(client, /viewImage\(safeSrc, \{\s*hideDownload: true,\s*info/);
});

test('"52 minutes ago" wording', () => {
  const context = vm.createContext({ Number, Math, Date, formatFullDateTime: () => 'FULL DATE' });
  vm.runInContext(extract(client, 'describeMessageAge'), context);
  const age = (ms, now = 1e12) => vm.runInContext(`describeMessageAge(${now - ms}, ${now})`, context);
  assert.equal(age(20 * 1000), 'Just now');
  assert.equal(age(60 * 1000), '1 minute ago');
  assert.equal(age(52 * 60 * 1000), '52 minutes ago');
  assert.equal(age(60 * 60 * 1000), '1 hour ago');
  assert.equal(age(5 * 3600 * 1000), '5 hours ago');
  assert.equal(age(30 * 3600 * 1000), 'FULL DATE');
  assert.equal(vm.runInContext('describeMessageAge(0)', context), '');
});

test('closing anything that used to close an action row now ends selection in both chats', () => {
  const close = extract(client, 'closeAllMsgActions');
  assert.match(close, /exitSelectMode\(\)/);
  assert.match(close, /exitPrivateGroupSelectMode\(\)/);
});

test('the delete dialogs sit above the selection bar, the emoji bar and the More menu', () => {
  const layers = { bar: 10040, react: 10041, menu: 10042 };
  const css = name => Number(new RegExp(`\\.${name}\\{[^}]*z-index:(\\d+)`).exec(client)[1]);
  assert.equal(css('msg-selection-bar'), layers.bar);
  assert.equal(css('msg-reaction-bar'), layers.react);
  assert.equal(css('msg-more-menu'), layers.menu);
  assert.ok(css('group-delete-overlay') > layers.menu, 'group delete dialog');
  const direct = client.slice(client.indexOf("overlay.id = 'delete-msg-overlay';"));
  assert.ok(Number(/z-index:(\d+)/.exec(direct.slice(0, 400))[1]) > layers.menu, 'direct delete dialog');
});

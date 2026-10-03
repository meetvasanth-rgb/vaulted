'use strict';

// Web links in messages are drawn as tappable anchors for sent and received
// messages, in 1:1 chats and groups. Text is E2E encrypted and only rendered on
// the device, so detection lives in the client. It must escape everything,
// accept only http(s), and never turn ordinary text (emails, file names,
// version numbers) into a link.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');

const start = client.indexOf('function escHtml(s)');
const end = client.indexOf('// A tap on a link must not also run');
assert.ok(start !== -1 && end > start, 'link helpers present');
const context = vm.createContext({ URL, String, RegExp });
vm.runInContext(client.slice(start, end), context);
const linkify = text => context.linkifyHtml(text);
const hrefs = html => [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);

test('http(s) links, www. links and bare domains become openable links that open outside the app', () => {
  const html = linkify('see https://vaultlix.com/get-app and www.example.com plus bit.ly/3xYz');
  assert.deepEqual(hrefs(html), ['https://vaultlix.com/get-app', 'https://www.example.com/', 'https://bit.ly/3xYz']);
  assert.match(html, /<a class="msg-link" href="[^"]+" target="_blank" rel="noopener noreferrer nofollow">/);
  assert.match(html, /^see <a/);
});

test('the text shown is what was typed, and trailing punctuation stays outside the link', () => {
  assert.match(linkify('visit www.example.com.'), />www\.example\.com<\/a>\.$/);
  assert.match(linkify('Hello!!! https://x.com!!!'), />https:\/\/x\.com<\/a>!!!$/);
  assert.match(linkify('"https://y.com"'), /&quot;<a [^>]+>https:\/\/y\.com<\/a>&quot;/);
  assert.deepEqual(hrefs(linkify('see (https://en.wikipedia.org/wiki/Foo_(bar)) ok')), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.match(linkify('see (https://en.wikipedia.org/wiki/Foo_(bar)) ok'), /\) ok$/);
});

test('query strings and fragments survive, ampersands are escaped in the HTML', () => {
  const html = linkify('https://a.com/x?a=1&b=2#frag, then more');
  assert.match(html, /href="https:\/\/a\.com\/x\?a=1&amp;b=2#frag"/);
  assert.match(html, /, then more$/);
});

test('only http(s) is ever linked: no javascript:, data:, ftp:, and no embedded credentials', () => {
  for (const text of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.com/file', 'https://user:pass@evil.com/login', 'vbscript:x']) {
    assert.equal(hrefs(linkify(text)).length, 0, text);
  }
});

test('markup in a message is escaped, including right next to a link', () => {
  const html = linkify('<img src=x onerror=alert(1)> http://x.io/<b>');
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /^&lt;img src=x onerror=alert\(1\)&gt; <a /);
  assert.deepEqual(hrefs(html), ['http://x.io/']);
  assert.equal(linkify('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('ordinary text is left alone: emails, file names, versions, decimals, abbreviations', () => {
  for (const text of ['mail me@site.com please', 'file.txt and 3.5 and e.g. and v1.2.3 ok', 'a.b/c.com', 'Hello there', '', 'ok.']) {
    assert.equal(hrefs(linkify(text)).length, 0, text);
  }
  assert.equal(linkify('mail me@site.com please'), 'mail me@site.com please');
});

test('IP addresses with a port and paths on well-known hosts are links', () => {
  assert.deepEqual(hrefs(linkify('http://192.168.1.10:3000/path')), ['http://192.168.1.10:3000/path']);
  assert.deepEqual(hrefs(linkify('docs.google.com/document/d/abc')), ['https://docs.google.com/document/d/abc']);
});

test('the Google Maps share link from the bug report is a link, with or without https://', () => {
  assert.deepEqual(hrefs(linkify('https://maps.app.goo.gl/oYFX7HUXGdYYAbjC7')), ['https://maps.app.goo.gl/oYFX7HUXGdYYAbjC7']);
  assert.deepEqual(hrefs(linkify('maps.app.goo.gl/oYFX7HUXGdYYAbjC7')), ['https://maps.app.goo.gl/oYFX7HUXGdYYAbjC7']);
  assert.match(linkify('Meet here https://maps.app.goo.gl/oYFX7HUXGdYYAbjC7'), /^Meet here <a /);
});

test('null and non-string input never throws', () => {
  assert.equal(linkify(null), '');
  assert.equal(linkify(undefined), '');
  assert.equal(linkify(42), '42');
});

test('no regex lookbehind (unsupported by iOS 15 web views, it would break the whole script)', () => {
  assert.doesNotMatch(client.slice(start, end), /\(\?<[=!]/);
});

test('1:1 text, 1:1 captions, group text and group captions all go through the link renderer', () => {
  assert.match(client, /class="bubble\$\{rec\.jumbo \? ' emoji-jumbo' : ''\}" oncontextmenu="return false">\$\{linkifyHtml\(rec\.content\)\}<\/div>/);
  assert.equal((client.match(/<div class="msg-caption-text">\$\{linkifyHtml\(rec\.caption\)\}<\/div>/g) || []).length, 2);
  assert.match(groups, /<div class="group-message-text">\$\{linkifyHtml\(visibleText\)\}<\/div>/);
  assert.match(groups, /<div class="group-message-text">\$\{linkifyHtml\(message\.attachment\.caption\)\}<\/div>/);
  assert.doesNotMatch(client, /oncontextmenu="return false">\$\{escHtml\(rec\.content\)\}<\/div>/);
});

test('a tap on a link does not also run the message actions, and is ignored while selecting or right after a long-press', () => {
  const handler = client.slice(end, client.indexOf('}, true);', end) + 9);
  assert.match(handler, /closest\?\.\('a\.msg-link'\)/);
  assert.match(handler, /event\.stopPropagation\(\)/);
  assert.match(handler, /selectMode \|\| \(typeof groupSelectMode !== 'undefined' && groupSelectMode\) \|\| wasJustLongPressed\(\)\) event\.preventDefault\(\)/);
});

test('links are readable on every bubble colour, including the dark burgundy group bubble', () => {
  assert.match(client, /\.msg-link\{color:#0B63C5;text-decoration:underline/);
  assert.match(client, /\.group-message\.mine \.msg-link\{color:#FFD9E5\}/);
});

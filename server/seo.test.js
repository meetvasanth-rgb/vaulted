'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSeo } = require('./seo');

const FIXTURE = `<!DOCTYPE html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet" media="print" onload="this.media='all'"/>
<style>.screen{display:none}.screen.active{display:flex}.legal-title{font-size:28px}</style>
</head><body>
<div id="s-landing" class="screen active">landing</div>
<div id="s-privacy" class="screen">
  <div class="legal-card">
    <button class="legal-back" onclick="goBack()">← Back to Vaultlix</button>
    <div class="legal-title">Privacy Policy</div>
    <div class="legal-section"><h3>What we collect</h3><p>Nothing readable.</p></div>
  </div>
</div>
<div id="s-terms" class="screen">
  <div class="legal-card">
    <div class="legal-title">Terms of Service</div>
    <p>See our <span style="color:var(--gold);cursor:pointer;" onclick="showScreen('s-privacy')">Privacy Policy</span>.</p>
  </div>
</div>
<div id="s-faq" class="screen"><div class="legal-card"><div class="legal-title">Frequently Asked Questions</div></div></div>
</body></html>`;

function makeSeo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-seo-'));
  fs.writeFileSync(path.join(dir, 'index.html'), FIXTURE);
  return createSeo({ clientDir: dir, now: () => new Date('2026-09-17T00:00:00Z') });
}

function call(seo, url, method = 'GET', headers = {}) {
  const out = { status: null, headers: {}, body: '' };
  const res = {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    writeHead(status, h = {}) { out.status = status; for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v; },
    end(b) { out.body = b ? String(b) : ''; },
  };
  const handled = seo.handle({ url, method, headers }, res);
  return { handled, ...out };
}

test('robots.txt points at the sitemap and blocks the API', () => {
  const r = call(makeSeo(), '/robots.txt');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /text\/plain/);
  assert.match(r.body, /Disallow: \/api\//);
  assert.match(r.body, /Sitemap: https:\/\/vaultlix\.com\/sitemap\.xml/);
});

test('sitemap.xml is XML and lists only public pages', () => {
  const r = call(makeSeo(), '/sitemap.xml');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /application\/xml/);
  for (const p of ['/', '/faq', '/privacy', '/terms']) assert.ok(r.body.includes(`<loc>https://vaultlix.com${p}</loc>`), p);
  assert.ok(!/join|admin|api/.test(r.body));
});

test('/privacy is a real page built from the in-app screen', () => {
  const r = call(makeSeo(), '/privacy');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /<title>Privacy Policy \| Vaultlix<\/title>/);
  assert.match(r.body, /<link rel="canonical" href="https:\/\/vaultlix\.com\/privacy">/);
  assert.match(r.body, /<h1 class="legal-title">Privacy Policy<\/h1>/);
  assert.match(r.body, /id="s-privacy" class="screen active seo-page"/);
  assert.match(r.body, /<a class="legal-back" href="\/"/);
  assert.ok(!/onclick=/.test(r.body), 'no app-only handlers left');
  assert.match(r.body, /Nothing readable\./);
});

test('in-screen cross links become crawlable links with the same style', () => {
  const r = call(makeSeo(), '/terms');
  assert.match(r.body, /<a href="\/privacy" style="color:var\(--gold\);cursor:pointer;;text-decoration:none">Privacy Policy<\/a>/);
});

test('pages reuse the app stylesheet, served long-cached', () => {
  const seo = makeSeo();
  const cssPath = seo._cssPath();
  assert.ok(call(seo, '/faq').body.includes(`href="${cssPath}"`));
  const css = call(seo, cssPath);
  assert.strictEqual(css.status, 200);
  assert.match(css.body, /\.legal-title\{font-size:28px\}/);
  assert.match(css.headers['cache-control'], /immutable/);
  const again = call(seo, cssPath, 'GET', { 'if-none-match': css.headers.etag });
  assert.strictEqual(again.status, 304);
});

test('trailing slash redirects to the canonical page URL', () => {
  const r = call(makeSeo(), '/privacy/?x=1');
  assert.strictEqual(r.status, 301);
  assert.strictEqual(r.headers.location, '/privacy?x=1');
});

test('private entry points get noindex but are left to the app', () => {
  const seo = makeSeo();
  for (const url of ['/join/amber-frost-42', '/9876543210', '/admin', '/admin.html']) {
    const r = call(seo, url);
    assert.strictEqual(r.handled, false, url);
    assert.match(r.headers['x-robots-tag'], /noindex/, url);
  }
  assert.strictEqual(call(seo, '/').headers['x-robots-tag'], undefined);
});

test('app shell routes are recognised; everything else is not', () => {
  const seo = makeSeo();
  for (const p of ['/', '/index.html', '/join/amber-frost-42', '/join/abc/', '/234567', '/9876543210']) assert.ok(seo.isAppShellRoute(p), p);
  for (const p of ['/nonexistent-page-xyz', '/blog', '/llms.txt', '/123456', '/join/', '/12345678901']) assert.ok(!seo.isAppShellRoute(p), p);
});

test('404 page is a real 404 with noindex', () => {
  const seo = makeSeo();
  const out = {};
  seo.sendNotFound({ method: 'GET', headers: {} }, {
    writeHead(s, h) { out.status = s; out.headers = h; },
    end(b) { out.body = b; },
  });
  assert.strictEqual(out.status, 404);
  assert.strictEqual(out.headers['X-Robots-Tag'], 'noindex');
});

test('HEAD requests send headers only; other methods are ignored', () => {
  const seo = makeSeo();
  assert.strictEqual(call(seo, '/robots.txt', 'HEAD').body, '');
  assert.strictEqual(call(seo, '/robots.txt', 'POST').handled, false);
});

test('content pages are served in the shared layout with one H1 and no app handlers', () => {
  const seo = makeSeo();
  for (const [p, h1] of [
    ['/messaging-without-phone-number', 'Message and call without sharing your phone number'],
    ['/how-vaultlix-numbers-work', 'How your Vaultlix number works'],
    ['/use-cases/online-dating', 'Get to know a match without giving out your number'],
    ['/compare/vaultlix-vs-zangi', 'Vaultlix vs Zangi'],
  ]) {
    const r = call(seo, p);
    assert.strictEqual(r.status, 200, p);
    assert.match(r.body, new RegExp(`<link rel="canonical" href="https://vaultlix.com${p}">`));
    assert.strictEqual((r.body.match(/<h1\b/g) || []).length, 1, `${p} has one H1`);
    assert.ok(r.body.includes(h1), p);
    assert.match(r.body, /class="legal-card"/);
    assert.match(r.body, /class="seo-cta" href="\/"/);
    assert.ok(!/onclick=/.test(r.body), p);
  }
  const sitemap = call(seo, '/sitemap.xml').body;
  assert.ok(sitemap.includes('<loc>https://vaultlix.com/messaging-without-phone-number</loc>'));
  assert.ok(sitemap.includes('<loc>https://vaultlix.com/how-vaultlix-numbers-work</loc>'));
});

test('content pages only make product claims that appear in the app itself', { skip: !fs.existsSync(path.join(__dirname, '../client/index.html')) }, () => {
  const app = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
  for (const claim of [
    'Vaultlix is not a cellular number', 'cannot receive SMS', 'does not search contacts or suggest people',
    'Choose the username people will see', 'A conversation appears after they accept', 'Vaultlix cannot recover this passcode',
    'losing both this device and the recovery code permanently loses', 'Your password and recovery code belong to you',
    'restored on another device', 'Recover account', 'Emergency Exit', 'Hide the active conversation immediately', 'Report and block', 'Emergency Exit',
  ]) assert.ok(app.includes(claim), `app still says: ${claim}`);
});

test('builds pages from the real client/index.html when present', { skip: !fs.existsSync(path.join(__dirname, '../client/index.html')) }, () => {
  const seo = createSeo({ clientDir: path.join(__dirname, '../client') });
  for (const p of ['/privacy', '/terms', '/faq']) {
    const r = call(seo, p);
    assert.strictEqual(r.status, 200, p);
    assert.strictEqual((r.body.match(/<h1\b/g) || []).length, 1, `${p} has one H1`);
  }
});

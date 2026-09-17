#!/usr/bin/env node
'use strict';
// Applies the SEO Phase 1 edits to the LATEST Vaultlix source.
//
//   node scripts/apply-seo-patch.js [repoRoot]          # dry run: reports what would change
//   node scripts/apply-seo-patch.js [repoRoot] --write  # applies the edits
//
// Every edit is an exact find/replace taken from production (vaultlix.com,
// 17 Sep 2026). If an anchor isn't found, that edit is skipped and reported,
// never guessed. Running it twice is safe: already-applied edits are detected.
//
// Design and app behaviour stay the same: no visual change, no change to what
// any click does. The only user-visible difference is the browser tab text.
// Requires server/seo.js to be present.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const write = args.includes('--write');
const root = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..'));

const SW_HELPER = `// Only the app shell may be stored as the offline /index.html. Public pages
// such as /privacy, /terms and /faq are separate HTML documents; caching them
// under /index.html would replace the offline app with a legal page.
function isAppShellNavigation(pathname) {
  return pathname === '/' || pathname === '/index.html'
    || /^\\/join\\/[a-z0-9-]+\\/?$/i.test(pathname)
    || /^\\/[2-9][0-9]{5,9}\\/?$/.test(pathname);
}

self.addEventListener('fetch', (event) => {`;

const EDITS = [
  // ---------------- client/index.html ----------------
  {
    file: 'client/index.html',
    name: 'Homepage <title> names the product category',
    find: '<title>Vaultlix – Your Private Line</title>',
    // Keeps the settled "Your Private Line" positioning (private-line-positioning.test.js)
    // and adds the words people search for. The meta description is left as is:
    // that test pins its "prestigious secondary private number" wording.
    replace: '<title>Vaultlix – Your Private Line, No Phone Number Needed</title>',
  },
  {
    file: 'client/index.html',
    name: 'og:url matches the canonical URL',
    find: '<meta property="og:url" content="https://vaultlix.com">',
    replace: '<meta property="og:url" content="https://vaultlix.com/">',
  },
  {
    file: 'client/index.html',
    name: 'Unread badge keeps the real page title instead of replacing it with "Vaultlix"',
    find: "document.title = total > 0 ? `(${total}) Vaultlix` : 'Vaultlix';",
    replace: "window.__vaultlixBaseTitle = window.__vaultlixBaseTitle || document.title.replace(/^\\(\\d+\\)\\s*/, '');\n  document.title = total > 0 ? `(${total}) ${window.__vaultlixBaseTitle}` : window.__vaultlixBaseTitle;",
  },
  {
    file: 'client/index.html',
    name: 'Landing footer "Privacy" is a crawlable link (same look, same click)',
    find: `<span style="cursor:pointer;text-decoration:underline;text-underline-offset:2px;" onclick="showScreen('s-privacy')">Privacy</span>`,
    replace: `<a href="/privacy" style="cursor:pointer;text-decoration:underline;text-underline-offset:2px;color:inherit !important;" onclick="showScreen('s-privacy');return false;">Privacy</a>`,
  },
  {
    file: 'client/index.html',
    name: 'Landing footer "Terms" is a crawlable link (same look, same click)',
    find: `<span style="cursor:pointer;text-decoration:underline;text-underline-offset:2px;" onclick="showScreen('s-terms')">Terms</span>`,
    replace: `<a href="/terms" style="cursor:pointer;text-decoration:underline;text-underline-offset:2px;color:inherit !important;" onclick="showScreen('s-terms');return false;">Terms</a>`,
  },
  {
    file: 'client/index.html',
    name: 'H1 words separated by real spaces (ignored by the flex layout, readable to Google)',
    find: '</span><span class="landing-reveal-word"',
    replace: '</span> <span class="landing-reveal-word"',
    all: true,
    expectCount: 4,
  },
  // ---------------- client/sw.js ----------------
  {
    file: 'client/sw.js',
    name: 'Service worker only caches app-shell navigations as /index.html',
    find: "self.addEventListener('fetch', (event) => {",
    replace: SW_HELPER,
    appliedMarker: 'function isAppShellNavigation(',
  },
  {
    file: 'client/sw.js',
    name: 'Service worker navigation cache uses the app-shell check',
    find: "        if (response.ok) {\n          const cache = await caches.open(APP_SHELL_CACHE);\n          await cache.put('/index.html', response.clone());",
    replace: "        if (response.ok && isAppShellNavigation(url.pathname)) {\n          const cache = await caches.open(APP_SHELL_CACHE);\n          await cache.put('/index.html', response.clone());",
  },
  // ---------------- server/index.js ----------------
  {
    file: 'server/index.js',
    name: 'Load the SEO module',
    find: "const fs = require('fs');\n",
    replace: "const fs = require('fs');\nconst { createSeo } = require('./seo');\nconst seo = createSeo({ clientDir: path.join(__dirname, '../client') });\n",
    appliedMarker: "require('./seo')",
    note: "Needs `path` to be required before `fs`. If it isn't, add these two lines after both requires by hand.",
  },
  {
    file: 'server/index.js',
    name: 'robots.txt, sitemap.xml, security.txt and /privacy /terms /faq pages',
    find: 'function serveStatic(req, res) {\n',
    replace: 'function serveStatic(req, res) {\n  if (seo.handle(req, res)) return;\n',
    appliedMarker: 'if (seo.handle(req, res)) return;',
  },
  {
    file: 'server/index.js',
    name: 'Unknown paths return 404 instead of the app (app routes unchanged)',
    // Production (codex/scalable-v2) checks vendorFile first; older copies don't.
    find: "      if (vendorFile) { res.writeHead(404); res.end(); return; }\n      fs.readFile(path.join(__dirname,'../client/index.html'), (e,d) => {",
    replace: "      if (vendorFile) { res.writeHead(404); res.end(); return; }\n      if (!seo.isAppShellRoute(req.url.split('?')[0])) { seo.sendNotFound(req, res); return; }\n      fs.readFile(path.join(__dirname,'../client/index.html'), (e,d) => {",
    appliedMarker: 'seo.sendNotFound(req, res)',
  },
];

function count(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

const contents = {};
const results = [];
for (const edit of EDITS) {
  const abs = path.join(root, edit.file);
  if (!(edit.file in contents)) {
    contents[edit.file] = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  }
  const text = contents[edit.file];
  if (text === null) { results.push(['MISSING FILE', edit]); continue; }
  // Git on Windows (core.autocrlf) checks files out with CRLF; match either style.
  if (text.includes('\r\n')) {
    const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
    edit.find = crlf(edit.find);
    edit.replace = crlf(edit.replace);
  }
  const alreadyApplied = edit.appliedMarker ? text.includes(edit.appliedMarker) : (count(text, edit.replace) > 0 && count(text, edit.find) === 0);
  if (alreadyApplied) { results.push(['ALREADY APPLIED', edit]); continue; }
  const n = count(text, edit.find);
  if (n === 0 || (!edit.all && n > 1) || (edit.expectCount && n !== edit.expectCount)) {
    results.push([`ANCHOR NOT MATCHED (found ${n})`, edit]);
    continue;
  }
  contents[edit.file] = edit.all ? text.split(edit.find).join(edit.replace) : text.replace(edit.find, () => edit.replace);
  results.push([write ? 'APPLIED' : 'WOULD APPLY', edit]);
}

if (!fs.existsSync(path.join(root, 'server/seo.js'))) {
  results.push(['MISSING FILE', { file: 'server/seo.js', name: 'SEO module (copy it into server/ first)' }]);
}

let failures = 0;
for (const [status, edit] of results) {
  const bad = status.startsWith('ANCHOR') || status.startsWith('MISSING');
  if (bad) failures++;
  console.log(`${bad ? '✗' : '✓'} [${status}] ${edit.file}: ${edit.name}${bad && edit.note ? `\n    ${edit.note}` : ''}`);
}

if (write) {
  if (failures) {
    console.log(`\n${failures} edit(s) could not be matched. Nothing was written. Fix or apply those by hand, then re-run.`);
    process.exit(1);
  }
  for (const [file, text] of Object.entries(contents)) {
    if (text !== null) fs.writeFileSync(path.join(root, file), text);
  }
  console.log('\nDone. Now run: node -c server/index.js && node --test server/seo.test.js');
} else {
  console.log(`\nDry run${failures ? `: ${failures} edit(s) need attention` : ': all edits match'}. Re-run with --write to apply.`);
  if (failures) process.exit(1);
}

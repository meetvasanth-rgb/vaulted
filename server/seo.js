'use strict';
// Search-engine plumbing for vaultlix.com.
//
// Why this exists: every path used to fall through to index.html with a 200,
// so Google saw one URL, an HTML "sitemap", and endless soft-404s. This module
// gives crawlers real answers without touching how the app itself behaves:
//
//   * /robots.txt, /sitemap.xml, /.well-known/security.txt
//   * /privacy, /terms, /faq as real, indexable pages. They are built at
//     startup from the SAME markup and CSS as the in-app screens in
//     index.html, so they look identical and never drift from the app copy.
//   * X-Robots-Tag: noindex for private entry points (/join/*, /<number>, /admin)
//   * 404 (instead of the app shell) for paths that are not app routes.
//
// Nothing here runs for /api/*, for real files, or for routes the server
// already handles explicitly — it is only consulted before static serving and
// in the "file not found" fallback.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORIGIN = 'https://vaultlix.com';

// Paths that legitimately boot the single-page app. Keep in sync with the
// client's own path parsing (parseJoinLinkCode / parsePublicPrivateNumber) and
// with the Universal Link / App Link paths in .well-known.
const APP_SHELL_ROUTES = [
  /^\/$/,
  /^\/index\.html$/,
  /^\/join\/[a-z0-9-]+\/?$/i,
  /^\/[2-9][0-9]{5,9}\/?$/,
];

// Private by nature: must never be indexed, even though they return the app.
const NOINDEX_ROUTES = [
  /^\/join\//i,
  /^\/[2-9][0-9]{5,9}\/?$/,
  /^\/admin(\.html|\.js|\.css)?$/,
];

const PAGES = {
  '/delete-account': {
    file: 'delete-account.html',
    title: 'Delete Your Vaultlix Account and Data',
    description: 'Delete your Vaultlix account in the app or contact Vaultlix to request account and associated data deletion.',
    breadcrumb: 'Delete account',
    lastmod: '2026-09-17',
  },
  '/privacy': {
    screen: 's-privacy',
    title: 'Privacy Policy | Vaultlix',
    description: 'How Vaultlix handles your data: no phone number, email address or real name is required, and messages are end-to-end encrypted so the server cannot read them.',
    lastmod: '2026-09-16',
  },
  '/terms': {
    screen: 's-terms',
    title: 'Terms of Service | Vaultlix',
    description: 'The terms for using Vaultlix, including acceptable use, abuse reports, legal process and how to contact us.',
    lastmod: '2026-09-16',
  },
  '/faq': {
    screen: 's-faq',
    title: 'Vaultlix FAQ: Private Numbers, Encryption & Privacy',
    description: 'Answers about Vaultlix private numbers, end-to-end encryption, how connections work, and why no phone number or email address is needed.',
    lastmod: '2026-09-17',
  },
  // Content pages: written in server/seo-pages/*.html and rendered inside the
  // same legal-card layout and stylesheet as the pages above.
  '/messaging-without-phone-number': {
    file: 'messaging-without-phone-number.html',
    title: 'Messaging Without a Phone Number | Vaultlix',
    description: 'Chat and call one-to-one without sharing your phone number, email or contacts. How Vaultlix works, what it doesn\'t do, and how other options compare.',
    breadcrumb: 'Messaging without a phone number',
    lastmod: '2026-09-17',
  },
  '/how-vaultlix-numbers-work': {
    file: 'how-vaultlix-numbers-work.html',
    title: 'How Vaultlix Numbers Work (and What They Can\'t Do)',
    description: 'Your Vaultlix number is a permanent private number for one-to-one messages and calls inside Vaultlix. How to get one, share it and keep it safe.',
    breadcrumb: 'How Vaultlix numbers work',
    lastmod: '2026-09-17',
  },
  '/use-cases/online-dating': {
    file: 'online-dating.html',
    title: 'Talk to Dating Matches Without Sharing Your Number | Vaultlix',
    description: 'Share a Vaultlix number with dating matches instead of your phone number. Message and call one-to-one, approve who connects, and erase the conversation for both.',
    breadcrumb: 'Online dating',
    lastmod: '2026-09-17',
  },
  '/compare/vaultlix-vs-zangi': {
    file: 'vaultlix-vs-zangi.html',
    title: 'Vaultlix vs Zangi: Private Number Messengers Compared',
    description: 'Vaultlix vs Zangi: both replace your phone number with a private number. Compare password recovery, who can contact you, safety controls, groups, calls and devices.',
    breadcrumb: 'Vaultlix vs Zangi',
    lastmod: '2026-09-17',
  },
};

// Indexable URLs for sitemap.xml. Only public marketing/legal pages — never
// app routes, invitations, profiles, admin or API paths.
const SITEMAP_PATHS = ['/', '/delete-account', '/messaging-without-phone-number', '/how-vaultlix-numbers-work', '/use-cases/online-dating', '/compare/vaultlix-vs-zangi', '/faq', '/privacy', '/terms', '/install', '/get-app'];

const SCREEN_TO_PATH = Object.fromEntries(Object.entries(PAGES).filter(([, cfg]) => cfg.screen).map(([p, cfg]) => [cfg.screen, p]));

// Content pages sit on the same ground and card as the in-app legal screens
// (#s-privacy/#s-terms/#s-faq), and their H2s reuse the legal-section H3 look.
const CONTENT_PAGE_STYLE = '.seo-content{background:#FBF7F8;padding:24px 16px}'
  + '.legal-section h2{font-size:13px;font-weight:600;margin-bottom:8px;letter-spacing:.04em;text-transform:uppercase}'
  + '.legal-section ol{font-size:13px;color:#5F5B55;line-height:1.75;padding-left:18px}.legal-section ol li{margin-bottom:4px}'
  + '.legal-section a{color:var(--gold)}'
  // Comparison tables: legal-section text size and colours, legal-highlight border tone.
  + '.seo-table{overflow-x:auto;margin:8px 0}.seo-table table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.55;color:#5F5B55}'
  + '.seo-table th,.seo-table td{text-align:left;vertical-align:top;padding:9px 8px;border-bottom:.5px solid #E8E2DA}'
  + '.seo-table thead th{color:var(--vx-ink,#271D25);font-weight:600}.seo-table tbody th{color:var(--vx-ink,#271D25);font-weight:600;width:28%}'
  // Same values as the homepage "Create my number" button (#s-landing .landing-hero-action).
  + '.seo-cta{display:inline-flex;align-items:center;justify-content:center;gap:9px;margin:28px 0 8px;padding:13px 18px;border:1px solid #682C43;border-radius:999px;background:#682C43;color:#fff;font:750 12px/1 \'Manrope\',sans-serif;box-shadow:0 10px 24px rgba(104,44,67,.22);text-decoration:none;transition:transform .18s ease,box-shadow .18s ease,background .18s ease}'
  + '.seo-cta:hover{background:#542237;box-shadow:0 13px 28px rgba(104,44,67,.27);transform:translateY(-2px)}'
  + '@media(max-width:760px){.seo-cta{font-size:14px;padding:15px 20px}}';

// Every public web page (legal + content). The in-app legal screens are
// designed mobile-first: their card only gets inner padding under 640px and
// nothing centres it, so on a desktop browser text ran into the card edge and
// the card hugged the left side. These rules apply to the web pages only.
const PUBLIC_PAGE_STYLE = '.seo-page{justify-content:center;align-items:flex-start}'
  + '.seo-page .legal-contact{line-height:1.8}.seo-page .legal-contact a{color:var(--gold)}'
  + '.seo-page .legal-back{margin-bottom:24px}'
  + '@media(min-width:641px){.screen.seo-page{padding:48px 24px 72px!important}.seo-page .legal-card{padding:40px 48px 36px!important}}'
  // Content pages use H3 only for questions under a section heading.
  + '.seo-content .legal-section h3{font-size:14px;font-weight:600;text-transform:none;letter-spacing:0;margin:18px 0 4px}'
  + '.seo-content .legal-section h2+h3{margin-top:10px}.seo-content .legal-section{margin-bottom:30px}.seo-content .legal-highlight{margin:12px 0 30px}.seo-content .legal-section ol+p,.seo-content .legal-section ul+p{margin-top:10px}';

function renderContentPage(fragment) {
  return `<div class="screen active seo-content seo-page">
  <div class="legal-card">
    <a class="legal-back" href="/" style="text-decoration:none;width:fit-content">← Back to Vaultlix</a>
    <div class="legal-logo">
      <div class="rule"></div>
      <span>Vaultlix</span>
    </div>
${fragment}
  </div>
</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Returns the complete <div id="..."> ... </div> element, balancing nested divs.
function extractElementById(html, id) {
  const marker = `id="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.lastIndexOf('<div', at);
  if (start < 0) return null;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, re.lastIndex);
  }
  return null;
}

function extractStyles(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
}

function extractFontLink(html) {
  const m = html.match(/<link href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)" rel="stylesheet"/);
  return m ? m[1] : null;
}

// Turns an in-app screen into static page markup that renders identically.
function staticizeScreen(screenHtml) {
  return screenHtml
    // The screen is shown by adding .active in the app; do the same statically.
    .replace(/class="screen"/, 'class="screen active seo-page"')
    // "Back to Vaultlix" button -> real link home. Same class, so same look.
    .replace(
      /<button class="legal-back" onclick="goBack\(\)">([\s\S]*?)<\/button>/,
      '<a class="legal-back" href="/" style="text-decoration:none;width:fit-content">$1</a>',
    )
    // The visual page title becomes the page's single H1 (the app's CSS
    // reset zeroes heading margins, and .legal-title sets size/weight).
    .replace(/<div class="legal-title">([\s\S]*?)<\/div>/, '<h1 class="legal-title">$1</h1>')
    // In-screen cross links (e.g. Terms -> Privacy Policy) become crawlable links.
    .replace(
      /<span style="([^"]*)" onclick="showScreen\('(s-[a-z]+)'\)">([\s\S]*?)<\/span>/g,
      (whole, style, screen, text) => (SCREEN_TO_PATH[screen]
        ? `<a href="${SCREEN_TO_PATH[screen]}" style="${style};text-decoration:none">${text}</a>`
        : whole),
    )
    // Any other inline handler would reference app functions that don't exist here.
    .replace(/\son[a-z]+="[^"]*"/g, '');
}

function buildPage(routePath, cfg, parts) {
  const url = `${ORIGIN}${routePath}`;
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Vaultlix', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: cfg.breadcrumb || cfg.title.split(' | ')[0].split(':')[0], item: url },
    ],
  };
  const fonts = parts.fontLink
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="${escapeHtml(parts.fontLink)}" rel="stylesheet"/>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
<meta name="color-scheme" content="light"/>
<meta name="theme-color" content="#682C43"/>
<title>${escapeHtml(cfg.title)}</title>
<meta name="description" content="${escapeHtml(cfg.description)}">
<link rel="canonical" href="${url}">
<link rel="icon" type="image/svg+xml" href="/icons/icon-master.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" href="/icons/icon-1024.png?v=20260806"/>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vaultlix">
<meta property="og:title" content="${escapeHtml(cfg.title)}">
<meta property="og:description" content="${escapeHtml(cfg.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/icons/icon-512.png?v=20260904">
${fonts}
<link rel="stylesheet" href="${parts.cssPath}">
<style>${PUBLIC_PAGE_STYLE}${cfg.file ? CONTENT_PAGE_STYLE : ''}</style>
<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
</head>
<body>
${cfg.file ? renderContentPage(parts.fragments[cfg.file]) : parts.screens[cfg.screen]}
</body>
</html>
`;
}

function createSeo({ clientDir, now = () => new Date() } = {}) {
  const indexPath = path.join(clientDir, 'index.html');
  let css = { body: '', path: '/seo-site.css', etag: '' };
  let pages = {};

  function build() {
    const html = fs.readFileSync(indexPath, 'utf8');
    const cssBody = extractStyles(html);
    const cssHash = crypto.createHash('sha1').update(cssBody).digest('hex').slice(0, 12);
    css = { body: cssBody, path: `/seo-site.${cssHash}.css`, etag: `"${cssHash}"` };
    const screens = {};
    const fragments = {};
    for (const cfg of Object.values(PAGES)) {
      if (cfg.file) {
        try { fragments[cfg.file] = fs.readFileSync(path.join(__dirname, 'seo-pages', cfg.file), 'utf8'); } catch (e) { /* reported below */ }
        continue;
      }
      const el = extractElementById(html, cfg.screen);
      if (el) screens[cfg.screen] = staticizeScreen(el);
    }
    const parts = { screens, fragments, cssPath: css.path, fontLink: extractFontLink(html) };
    pages = {};
    for (const [routePath, cfg] of Object.entries(PAGES)) {
      if (cfg.file && !fragments[cfg.file]) {
        console.warn(`[seo] server/seo-pages/${cfg.file} not found; ${routePath} is not served.`);
        continue;
      }
      if (!cfg.file && !screens[cfg.screen]) {
        console.warn(`[seo] screen #${cfg.screen} not found in index.html; ${routePath} falls back to the app.`);
        continue;
      }
      const body = buildPage(routePath, cfg, parts);
      pages[routePath] = { body, etag: `"${crypto.createHash('sha1').update(body).digest('hex')}"` };
    }
  }

  function send(req, res, status, headers, body) {
    res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function sendCached(req, res, contentType, entry, cacheControl) {
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, { ETag: entry.etag, 'Cache-Control': cacheControl });
      res.end();
      return;
    }
    send(req, res, 200, { 'Content-Type': contentType, ETag: entry.etag, 'Cache-Control': cacheControl }, entry.body);
  }

  function robotsTxt() {
    return 'User-agent: *\nDisallow: /api/\nAllow: /\n\nSitemap: https://vaultlix.com/sitemap.xml\n';
  }

  function sitemapXml() {
    const lastmod = (p) => (PAGES[p] && PAGES[p].lastmod ? `<lastmod>${PAGES[p].lastmod}</lastmod>` : '');
    const urls = SITEMAP_PATHS
      .filter((p) => !PAGES[p] || pages[p])
      .map((p) => `  <url><loc>${ORIGIN}${p}</loc>${lastmod(p)}</url>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  }

  function securityTxt() {
    const expires = new Date(now().getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
    return `Contact: mailto:legal@vaultlix.com\nExpires: ${expires}\nPreferred-Languages: en\nCanonical: ${ORIGIN}/.well-known/security.txt\nPolicy: ${ORIGIN}/terms\n`;
  }

  function isAppShellRoute(pathname) {
    return APP_SHELL_ROUTES.some((r) => r.test(pathname));
  }

  function isNoindexRoute(pathname) {
    return NOINDEX_ROUTES.some((r) => r.test(pathname));
  }

  // Call first in serveStatic. Returns true when the response has been sent.
  function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const pathname = (req.url || '/').split('?')[0];

    if (isNoindexRoute(pathname)) res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    if (pathname === '/robots.txt') {
      send(req, res, 200, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, robotsTxt());
      return true;
    }
    if (pathname === '/sitemap.xml') {
      send(req, res, 200, { 'Content-Type': 'application/xml;charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, sitemapXml());
      return true;
    }
    if (pathname === '/.well-known/security.txt') {
      send(req, res, 200, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'public, max-age=86400' }, securityTxt());
      return true;
    }
    if (pathname === css.path) {
      sendCached(req, res, 'text/css;charset=utf-8', css, 'public, max-age=31536000, immutable');
      return true;
    }
    if (pages[pathname]) {
      sendCached(req, res, 'text/html;charset=utf-8', pages[pathname], 'no-cache');
      return true;
    }
    // One canonical form per page: /privacy/ -> /privacy
    if (pathname.length > 1 && pathname.endsWith('/') && pages[pathname.slice(0, -1)]) {
      const qs = (req.url || '').includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, { Location: pathname.slice(0, -1) + qs });
      res.end();
      return true;
    }
    return false;
  }

  // Call in the "file not found" branch instead of always serving index.html.
  function sendNotFound(req, res) {
    const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Page not found | Vaultlix</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="${css.path}"></head>
<body><div class="screen active" style="align-items:center;justify-content:center;padding:24px 16px">
<div class="legal-card"><h1 class="legal-title">Page not found</h1>
<p class="legal-date">This page doesn't exist on vaultlix.com.</p>
<a class="legal-back" href="/" style="text-decoration:none">← Back to Vaultlix</a></div></div></body></html>
`;
    send(req, res, 404, { 'Content-Type': 'text/html;charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-cache' }, body);
  }

  try {
    build();
  } catch (e) {
    console.warn('[seo] could not build static pages:', e.message);
  }

  return { handle, sendNotFound, isAppShellRoute, isNoindexRoute, rebuild: build, _pages: () => pages, _cssPath: () => css.path };
}

module.exports = { createSeo, APP_SHELL_ROUTES, NOINDEX_ROUTES, PAGES, staticizeScreen, extractElementById };

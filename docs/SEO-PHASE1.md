# SEO Phase 1 — deploy guide

Goal: get vaultlix.com indexed properly and ranking first for "Vaultlix", with
no design or app-behavior changes.

## What changes

| Area | Change | Visible to users? |
| --- | --- | --- |
| `server/seo.js` (new) | `/robots.txt` with sitemap, `/sitemap.xml`, `/.well-known/security.txt` | No |
| `server/seo.js` (new) | `/privacy`, `/terms`, `/faq` as real pages, built at startup from the in-app screens and CSS in `index.html` (identical look) | New URLs only |
| `server/index.js` | Unknown paths return 404; `/`, `/join/*`, `/<number>` still load the app | Only for broken URLs |
| `server/seo.js` | `X-Robots-Tag: noindex` on `/join/*`, `/<number>`, `/admin` | No |
| `client/index.html` | Title; `og:url` slash; unread badge keeps the title; footer Privacy/Terms become `<a href>` (same style, same click); H1 word spacing (layout unaffected) | Browser tab text only |
| `client/sw.js` | Only app routes are cached as the offline app shell (prevents `/privacy` overwriting it offline) | No |

## Apply (on the latest repo, not this copy)

This folder is older than production, so apply to the up-to-date Git checkout:

```bash
cp <this folder>/server/seo.js <this folder>/server/seo.test.js <repo>/server/
mkdir -p <repo>/scripts && cp <this folder>/scripts/apply-seo-patch.js <repo>/scripts/
cd <repo>
node scripts/apply-seo-patch.js .            # dry run — every line must show ✓
node scripts/apply-seo-patch.js . --write
node -c server/index.js && node --test server/seo.test.js
```

Then the usual verification ritual from `CLAUDE.md` (inline script `node --check`,
div/svg balance), commit, and push.

## Check after deploy

```bash
curl -sI https://vaultlix.com/nonexistent-page-xyz   # 404
curl -s  https://vaultlix.com/sitemap.xml            # XML
curl -sI https://vaultlix.com/join/test-code         # 200 + X-Robots-Tag: noindex
curl -sI https://vaultlix.com/privacy                # 200 text/html
```

Also open the installed PWA once, then open `/privacy` and go offline: the app
must still load from `/`.

## Google / Bing (same day)

1. Search Console → add a **Domain** property for `vaultlix.com` (DNS TXT record).
2. Sitemaps → submit `https://vaultlix.com/sitemap.xml`.
3. URL Inspection → `https://vaultlix.com/` → Test live URL → confirm the
   rendered title is "Vaultlix – Your Private Line, No Phone Number Needed" →
   Request indexing. Repeat for `/faq`, `/privacy`, `/terms`.
4. Bing Webmaster Tools → Import from Search Console.
5. DNS: add `www` (CNAME to the Railway domain) and attach it in Railway so
   `www.vaultlix.com` resolves and redirects to `vaultlix.com`.

## Brand ranking (weeks 1–6)

"Vaultix" brands currently fill results for "vaultlix". Signals that help Google
connect the name to this site:

- Consistent name + link on every profile you own (X, LinkedIn, Instagram,
  Product Hunt, AlternativeTo, app store listings when public).
- Add those profile URLs to the Organization JSON-LD `sameAs` once they exist.
- A few real mentions (launch posts, directories, founder interviews).

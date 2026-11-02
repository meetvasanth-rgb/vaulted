const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CRITICAL_CSS_END = '@media(prefers-reduced-motion:reduce){#restore-skeleton-overlay{transition:none}.startup-pulse span{animation:none;opacity:.7}}';
const MAIN_SCRIPT_MARKER = '// ── HTTP POLLING MESSENGER — MULTI-ROOM (Phase 1) ──────────────────────';

function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function extractInlineScript(html, marker, label) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${label} marker in client/index.html`);
  const openIndex = html.lastIndexOf('<script>', markerIndex);
  const contentStart = openIndex + '<script>'.length;
  const closeIndex = html.indexOf('</script>', markerIndex);
  if (openIndex < 0 || closeIndex < 0) throw new Error(`Could not extract ${label} from client/index.html`);
  return {
    content: html.slice(contentStart, closeIndex),
    start: openIndex,
    end: closeIndex + '</script>'.length,
  };
}

function compileClientShell({ clientDir }) {
  const sourcePath = path.join(clientDir, 'index.html');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const styles = [];
  const stylePattern = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi;
  let styleMatch;
  while ((styleMatch = stylePattern.exec(source))) styles.push(styleMatch[1]);
  if (!styles.length) throw new Error('Could not find CSS in client/index.html');

  const criticalEndIndex = styles[0].indexOf(CRITICAL_CSS_END);
  if (criticalEndIndex < 0) throw new Error('Could not find startup critical CSS in client/index.html');
  const criticalEnd = criticalEndIndex + CRITICAL_CSS_END.length;
  const criticalCss = styles[0].slice(0, criticalEnd).trim();
  const deferredCss = [styles[0].slice(criticalEnd), ...styles.slice(1)]
    .map(value => value.trim())
    .filter(Boolean)
    .join('\n\n');
  const cssPath = `/app-shell.${contentHash(deferredCss)}.css`;

  let styleNumber = 0;
  let html = source.replace(stylePattern, () => {
    styleNumber += 1;
    if (styleNumber !== 1) return '';
    return `<style>\n${criticalCss}\n</style>\n<link rel="stylesheet" href="${cssPath}">`;
  });

  const qrScript = extractInlineScript(html, 'var qrcode=(()=>', 'QR encoder');
  const qrPath = `/vendor/qrcode.${contentHash(qrScript.content)}.js`;
  html = html.slice(0, qrScript.start)
    + `<script defer src="${qrPath}"></script>`
    + html.slice(qrScript.end);

  const mainScript = extractInlineScript(html, MAIN_SCRIPT_MARKER, 'application script');
  const appPath = `/app-core.${contentHash(mainScript.content)}.js`;
  html = html.slice(0, mainScript.start)
    + `<script defer src="${appPath}"></script>`
    + html.slice(mainScript.end);

  // Discover the large application file from the head rather than after the
  // browser has parsed the full body. Execution still waits for the ordered
  // deferred script tags below; this only starts its transfer sooner.
  html = html.replace('</head>', `<link rel="preload" as="script" href="${appPath}">\n</head>`);

  // Every executable script now comes from a same-origin URL. `defer` keeps
  // their document order while allowing the browser to download the large
  // application code in parallel with parsing the much smaller HTML shell.
  html = html.replace(/<script src="(\/vendor\/jsQR\.js|\/number-card\.js|\/groups\.js|\/walkthrough-player\.js)"><\/script>/g,
    '<script defer src="$1"></script>');

  const assets = new Map([
    [cssPath, { body:Buffer.from(deferredCss), contentType:'text/css;charset=utf-8' }],
    [qrPath, { body:Buffer.from(qrScript.content), contentType:'text/javascript;charset=utf-8' }],
    [appPath, { body:Buffer.from(mainScript.content), contentType:'text/javascript;charset=utf-8' }],
  ]);

  return {
    html: Buffer.from(html),
    assets,
    paths:{ css:cssPath, qr:qrPath, app:appPath },
    sourceBytes:Buffer.byteLength(source),
    shellBytes:Buffer.byteLength(html),
  };
}

module.exports = { compileClientShell, CRITICAL_CSS_END, MAIN_SCRIPT_MARKER };

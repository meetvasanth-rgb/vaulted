'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_STORE_URL = 'https://apps.apple.com/in/app/vaultlix/id6798266989';
const OUTPUT = path.join(ROOT, 'client', 'media', 'vaultlix-ios-app-store-card.svg');

function createQrMatrix(text) {
  const sandbox = {
    navigator: { userAgent: '' },
    document: { documentElement: { tagName: 'html' } },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'client', 'vendor', 'qrcode.min.js'), 'utf8'),
    sandbox,
  );
  const placeholder = {
    childNodes: [{ offsetWidth: 512, offsetHeight: 512, style: {} }],
    style: {},
    innerHTML: '',
  };
  const qr = new sandbox.QRCode(placeholder, {
    text,
    width: 512,
    height: 512,
    correctLevel: sandbox.QRCode.CorrectLevel.H,
  });
  const model = qr._oQRCode;
  return Array.from({ length: model.getModuleCount() }, (_, row) =>
    Array.from({ length: model.getModuleCount() }, (_, column) => model.isDark(row, column)));
}

function qrPath(matrix, x, y, size) {
  const quietZone = 4;
  const cell = size / (matrix.length + quietZone * 2);
  let output = '';
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < matrix.length; column += 1) {
      if (!matrix[row][column]) continue;
      const left = x + (column + quietZone) * cell;
      const top = y + (row + quietZone) * cell;
      output += `M${left.toFixed(2)} ${top.toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
    }
  }
  return output;
}

const matrix = createQrMatrix(APP_STORE_URL);
const modules = qrPath(matrix, 274, 590, 532);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <title>Download Vaultlix for iPhone</title>
  <desc>Scan the QR code to open Vaultlix directly in the Apple App Store.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#84324F"/><stop offset=".5" stop-color="#682C43"/><stop offset="1" stop-color="#35101F"/></linearGradient>
    <radialGradient id="halo"><stop stop-color="#F8DDE6" stop-opacity=".28"/><stop offset="1" stop-color="#F8DDE6" stop-opacity="0"/></radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="22" stdDeviation="25" flood-color="#1E0711" flood-opacity=".48"/></filter>
    <style>.brand{font:700 31px Inter,Arial,sans-serif;letter-spacing:12px;fill:#FFF8FA}.kicker{font:700 20px Inter,Arial,sans-serif;letter-spacing:6px;fill:#EFC7D4}.headline{font:700 70px Inter,Arial,sans-serif;letter-spacing:-2px;fill:#FFF8FA}.copy{font:500 25px Inter,Arial,sans-serif;fill:#F3DCE4}.cta{font:700 21px Inter,Arial,sans-serif;letter-spacing:4px;fill:#682C43}.url{font:600 20px Inter,Arial,sans-serif;fill:#FFF8FA}.fine{font:600 17px Inter,Arial,sans-serif;letter-spacing:3px;fill:#E9C3CF}</style>
  </defs>
  <rect width="1080" height="1350" fill="url(#background)"/>
  <circle cx="910" cy="120" r="350" fill="url(#halo)"/><circle cx="100" cy="1210" r="300" fill="url(#halo)" opacity=".7"/>
  <path d="M72 76h936M72 1280h936" stroke="#F6D6E1" stroke-opacity=".24"/>
  <g transform="translate(76 112)"><rect width="64" height="64" rx="19" fill="#FFF8FA" fill-opacity=".14" stroke="#FFF" stroke-opacity=".24"/><text x="32" y="45" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-weight="700" font-size="37" fill="#FFF">V</text><text x="91" y="43" class="brand">VAULTLIX</text></g>
  <text x="76" y="262" class="kicker">NOW ON THE APP STORE</text>
  <text x="76" y="350" class="headline">Your private line.</text>
  <text x="76" y="430" class="headline">Ready on iPhone.</text>
  <text x="78" y="490" class="copy">Private chats and calls. No phone number needed.</text>
  <g filter="url(#shadow)"><rect x="242" y="558" width="596" height="596" rx="52" fill="#FFF"/><path d="${modules}" fill="#35101F"/></g>
  <g transform="translate(344 1138)"><rect width="392" height="64" rx="32" fill="#FFF8FA"/><text x="196" y="41" text-anchor="middle" class="cta">SCAN FOR APP STORE</text></g>
  <text x="540" y="1245" text-anchor="middle" class="url">apps.apple.com · Vaultlix</text>
  <text x="540" y="1312" text-anchor="middle" class="fine">NO SIM · NO CONTACT UPLOAD</text>
</svg>`;

fs.writeFileSync(OUTPUT, svg);
process.stdout.write(`${OUTPUT}\n${APP_STORE_URL}\n${matrix.length}x${matrix.length} QR matrix\n`);

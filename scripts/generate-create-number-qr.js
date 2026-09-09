'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const TARGET_URL = 'https://vaultlix.com/?create=1';
const OUTPUT = path.join(ROOT, 'client', 'media', 'vaultlix-create-number-qr.svg');

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

const matrix = createQrMatrix(TARGET_URL);
const modules = qrPath(matrix, 250, 610, 580);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <title>Create your Vaultlix number</title>
  <desc>Scan the QR code to open Vaultlix account creation.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#8A3152"/><stop offset=".48" stop-color="#6B1F3A"/><stop offset="1" stop-color="#340B1B"/>
    </linearGradient>
    <radialGradient id="halo"><stop stop-color="#F8D9E4" stop-opacity=".3"/><stop offset="1" stop-color="#F8D9E4" stop-opacity="0"/></radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#1C0710" flood-opacity=".45"/></filter>
    <style>
      .brand{font:700 31px Inter,Arial,sans-serif;letter-spacing:12px;fill:#FFF8FA}.kicker{font:700 20px Inter,Arial,sans-serif;letter-spacing:7px;fill:#F0C8D5}.headline{font:700 74px Inter,Arial,sans-serif;letter-spacing:-2px;fill:#FFF8FA}.copy{font:500 25px Inter,Arial,sans-serif;fill:#F4DCE4}.cta{font:700 21px Inter,Arial,sans-serif;letter-spacing:5px;fill:#6B1F3A}.url{font:600 22px Inter,Arial,sans-serif;fill:#FFF8FA}.fine{font:600 17px Inter,Arial,sans-serif;letter-spacing:3px;fill:#EBC5D1}
    </style>
  </defs>
  <rect width="1080" height="1350" fill="url(#background)"/>
  <circle cx="900" cy="150" r="330" fill="url(#halo)"/>
  <circle cx="100" cy="1180" r="300" fill="url(#halo)" opacity=".7"/>
  <g opacity=".18" fill="none" stroke="#FFF" stroke-width="2">
    <circle cx="930" cy="160" r="92"/><circle cx="930" cy="160" r="132"/><circle cx="930" cy="160" r="172"/>
  </g>
  <path d="M72 76h936M72 1280h936" stroke="#F6D6E1" stroke-opacity=".24"/>
  <g transform="translate(76 112)">
    <rect width="64" height="64" rx="19" fill="#FFF8FA" fill-opacity=".13" stroke="#FFF" stroke-opacity=".22"/>
    <text x="32" y="45" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-weight="700" font-size="37" fill="#FFF">V</text>
    <text x="91" y="43" class="brand">VAULTLIX</text>
  </g>
  <text x="76" y="262" class="kicker">YOUR SECOND NUMBER</text>
  <text x="76" y="352" class="headline">Create your</text>
  <text x="76" y="432" class="headline">Vaultlix number.</text>
  <text x="78" y="489" class="copy">No SIM. No phone number. No email.</text>
  <g filter="url(#shadow)">
    <rect x="218" y="578" width="644" height="644" rx="54" fill="#FFF"/>
    <path d="${modules}" fill="#421124"/>
  </g>
  <g transform="translate(374 1168)">
    <rect width="332" height="62" rx="31" fill="#FFF8FA"/>
    <text x="166" y="39" text-anchor="middle" class="cta">SCAN TO CREATE</text>
  </g>
  <text x="540" y="1262" text-anchor="middle" class="url">vaultlix.com/?create=1</text>
  <text x="540" y="1312" text-anchor="middle" class="fine">YOUR NUMBER · YOUR CHOICE</text>
</svg>`;

fs.writeFileSync(OUTPUT, svg);
process.stdout.write(`${OUTPUT}\n${TARGET_URL}\n${matrix.length}x${matrix.length} QR matrix\n`);

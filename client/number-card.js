(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaultlixNumberCard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIDTH = 1080;
  const HEIGHT = 1350;
  const BRAND = '#6B1F3A';

  function escapeXml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;',
    })[character]);
  }

  function formatNumber(value) {
    const number = String(value || '').replace(/\D/g, '');
    if (number.length <= 7) return `${number.slice(0, 2)}-${number.slice(2, 6)}${number.length > 6 ? `-${number.slice(6)}` : ''}`;
    return `${number.slice(0, 2)}-${number.slice(2, 6)}-${number.slice(6)}`;
  }

  function qrPath(matrix, x, y, size) {
    const count = Array.isArray(matrix) ? matrix.length : 0;
    if (!count) return '';
    const quiet = 4;
    const cell = size / (count + quiet * 2);
    let path = '';
    for (let row = 0; row < count; row++) {
      for (let column = 0; column < count; column++) {
        if (matrix[row]?.[column]) {
          const left = x + (column + quiet) * cell;
          const top = y + (row + quiet) * cell;
          path += `M${left.toFixed(2)} ${top.toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
        }
      }
    }
    return path;
  }

  function createNumberCardSvg({ number, username, tier = 'standard', qrMatrix = [] }) {
    const safeNumber = escapeXml(formatNumber(number));
    const safeUsername = escapeXml(username || 'Vaultlix identity');
    const badge = tier === 'reserve' ? 'RESERVE' : (tier === 'founding' ? 'FOUNDING MEMBER' : '');
    const badgeMarkup = badge
      ? `<g transform="translate(540 655)"><rect x="-150" y="-28" width="300" height="56" rx="28" fill="#F2D8E1" fill-opacity=".16" stroke="#F7DCE5" stroke-opacity=".52"/><text text-anchor="middle" y="7" class="badge">${badge}</text></g>`
      : '';
    const modules = qrPath(qrMatrix, 375, 805, 330);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7B2947"/><stop offset=".52" stop-color="${BRAND}"/><stop offset="1" stop-color="#3D1022"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="#F6DCE5" stop-opacity=".22"/><stop offset="1" stop-color="#F6DCE5" stop-opacity="0"/></radialGradient>
    <filter id="emboss" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="2" flood-color="#260713" flood-opacity=".75"/><feDropShadow dx="0" dy="-2" stdDeviation="1" flood-color="#FFDCE8" flood-opacity=".45"/></filter>
    <style>.brand{font:700 34px Inter,Arial,sans-serif;letter-spacing:12px;fill:#FFF5F8}.eyebrow{font:700 22px Inter,Arial,sans-serif;letter-spacing:7px;fill:#EDC5D2}.number{font:700 86px Inter,Arial,sans-serif;letter-spacing:5px;fill:#FFF7FA}.name{font:600 38px Inter,Arial,sans-serif;fill:#FFF7FA}.badge{font:700 20px Inter,Arial,sans-serif;letter-spacing:4px;fill:#FFF7FA}.copy{font:500 24px Inter,Arial,sans-serif;fill:#F3DDE5}.small{font:500 19px Inter,Arial,sans-serif;letter-spacing:2px;fill:#E9C5D1}</style>
  </defs>
  <rect width="1080" height="1350" fill="url(#bg)"/>
  <circle cx="540" cy="420" r="470" fill="url(#glow)"/>
  <path d="M80 84h920M80 1266h920" stroke="#F6DCE5" stroke-opacity=".24"/>
  <g text-anchor="middle">
    <text x="540" y="150" class="brand">VAULTLIX</text>
    <text x="540" y="260" class="eyebrow">MY PRIVATE LINE</text>
    <text x="540" y="420" class="number" filter="url(#emboss)">${safeNumber}</text>
    <text x="540" y="510" class="name">${safeUsername}</text>
    ${badgeMarkup}
  </g>
  <rect x="354" y="784" width="372" height="372" rx="42" fill="#FFF"/>
  <path d="${modules}" fill="#2D0C18"/>
  <text x="540" y="1210" text-anchor="middle" class="copy">Scan to extend a private line</text>
  <text x="540" y="1270" text-anchor="middle" class="small">NO SIM · NO PHONE NUMBER · YOUR CHOICE</text>
</svg>`;
  }

  return { WIDTH, HEIGHT, BRAND, createNumberCardSvg };
});

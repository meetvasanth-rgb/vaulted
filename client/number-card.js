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

  function createNumberCardSvg({ number, username, qrMatrix = [] }) {
    const safeNumber = escapeXml(formatNumber(number));
    const displayUsername = String(username || 'Vaultlix identity');
    const safeUsername = escapeXml(displayUsername);
    const usernameSize = displayUsername.length > 24 ? 27 : (displayUsername.length > 17 ? 32 : 38);
    const modules = qrPath(qrMatrix, 128, 570, 450);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="night" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#170F14"/><stop offset=".55" stop-color="#25171F"/><stop offset="1" stop-color="#42162A"/></linearGradient>
    <radialGradient id="wine" cx="0" cy=".2" r="1"><stop stop-color="#7E2549" stop-opacity=".75"/><stop offset="1" stop-color="#25171F" stop-opacity="0"/></radialGradient>
    <filter id="card-shadow" x="-15%" y="-15%" width="130%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#10070C" flood-opacity=".38"/></filter>
    <filter id="qr-emboss" x="-25%" y="-25%" width="150%" height="160%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#5A2339" flood-opacity=".24"/><feDropShadow dx="0" dy="-3" stdDeviation="3" flood-color="#FFFFFF" flood-opacity=".95"/></filter>
    <style>.brand{font:500 58px Georgia,serif;fill:#FFF9FA}.pill{font:800 18px Inter,Arial,sans-serif;letter-spacing:4px;fill:#FFF7F9}.eyebrow{font:800 23px Inter,Arial,sans-serif;letter-spacing:4px;fill:#9B4565}.number{font:900 80px Inter,Arial,sans-serif;letter-spacing:1px;fill:${BRAND}}.name{font:800 38px Inter,Arial,sans-serif;fill:#261820}.copy{font:700 28px Inter,Arial,sans-serif;fill:#4A3440}.micro{font:700 20px Inter,Arial,sans-serif;letter-spacing:2px;fill:#A36A80}</style>
  </defs>
  <rect width="1080" height="1350" fill="url(#night)"/>
  <rect width="1080" height="1350" fill="url(#wine)"/>
  <text x="80" y="125" class="brand">Vaultlix</text>
  <rect x="695" y="69" width="305" height="66" rx="33" fill="none" stroke="#FFF7F9" stroke-opacity=".65" stroke-width="3"/>
  <text x="848" y="111" text-anchor="middle" class="pill">PRIVATE BY DESIGN</text>
  <rect x="64" y="220" width="952" height="1040" rx="54" fill="#FFF9FA" filter="url(#card-shadow)"/>
  <rect x="64" y="220" width="20" height="1040" rx="10" fill="#EE9DBA"/>
  <text x="128" y="330" class="eyebrow">MY PRIVATE NUMBER</text>
  <text x="128" y="438" class="number">${safeNumber}</text>
  <path d="M128 490H952" stroke="#DABFC9" stroke-width="4" stroke-dasharray="12 12"/>
  <g filter="url(#qr-emboss)"><rect x="128" y="570" width="450" height="450" rx="32" fill="#FFF"/><path d="${modules}" fill="#24151D"/></g>
  <rect x="128" y="570" width="450" height="450" rx="32" fill="none" stroke="#EADDE2" stroke-width="3"/>
  <text x="630" y="678" class="name" style="font-size:${usernameSize}px">${safeUsername}</text>
  <text x="630" y="734" class="copy">Scan to connect</text>
  <text x="630" y="780" class="copy">on Vaultlix</text>
  <rect x="630" y="856" width="250" height="62" rx="31" fill="${BRAND}"/>
  <text x="755" y="896" text-anchor="middle" class="pill">PRIVATE</text>
  <text x="128" y="1165" class="micro">NO PHONE NUMBER SHARED</text>
</svg>`;
  }

  function createPrivateInviteCardSvg({ username, inviteUrl, qrMatrix = [] }) {
    const displayUsername = String(username || 'A Vaultlix member').trim().slice(0, 32);
    const safeUsername = escapeXml(displayUsername);
    const headlineSize = displayUsername.length > 24 ? 36 : (displayUsername.length > 18 ? 44 : 56);
    const safeInviteUrl = escapeXml(inviteUrl || 'https://vaultlix.com');
    const modules = qrPath(qrMatrix, 314, 438, 452);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="invite-bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7B2947"/><stop offset=".52" stop-color="${BRAND}"/><stop offset="1" stop-color="#3D1022"/></linearGradient>
    <radialGradient id="invite-glow"><stop stop-color="#F6DCE5" stop-opacity=".22"/><stop offset="1" stop-color="#F6DCE5" stop-opacity="0"/></radialGradient>
    <style>.brand{font:700 34px Inter,Arial,sans-serif;letter-spacing:12px;fill:#FFF5F8}.eyebrow{font:700 22px Inter,Arial,sans-serif;letter-spacing:7px;fill:#EDC5D2}.headline{font:700 56px Inter,Arial,sans-serif;fill:#FFF7FA}.copy{font:600 31px Inter,Arial,sans-serif;fill:#F3DDE5}.url{font:700 32px Inter,Arial,sans-serif;fill:#FFF7FA}.small{font:700 25px Inter,Arial,sans-serif;letter-spacing:4px;fill:#E9C5D1}</style>
  </defs>
  <rect width="1080" height="1350" fill="url(#invite-bg)"/>
  <circle cx="540" cy="420" r="470" fill="url(#invite-glow)"/>
  <path d="M80 84h920M80 1320h920" stroke="#F6DCE5" stroke-opacity=".24"/>
  <g text-anchor="middle">
    <text x="540" y="150" class="brand">VAULTLIX</text>
    <text x="540" y="230" class="eyebrow">PRIVATE INVITATION</text>
    <text x="540" y="325" class="headline" style="font-size:${headlineSize}px">${safeUsername} invited you</text>
    <text x="540" y="382" class="copy">Connect without sharing your mobile number</text>
  </g>
  <rect x="300" y="424" width="480" height="480" rx="48" fill="#FFF"/>
  <path d="${modules}" fill="#2D0C18"/>
  <text x="540" y="982" text-anchor="middle" class="copy">Scan to connect privately</text>
  <text x="540" y="1052" text-anchor="middle" class="small">SINGLE USE · VALID FOR 24 HOURS</text>
  <text x="540" y="1143" text-anchor="middle" class="url">${safeInviteUrl}</text>
  <text x="540" y="1252" text-anchor="middle" class="small">PRIVATE BY DESIGN</text>
</svg>`;
  }

  return { WIDTH, HEIGHT, BRAND, createNumberCardSvg, createPrivateInviteCardSvg };
});

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

  function createNumberCardSvg({ number, shareCode, username, tier = 'standard', qrMatrix = [] }) {
    const safeNumber = escapeXml(formatNumber(number));
    const safeSharePath = escapeXml(String(number || '').replace(/\D/g, ''));
    const safeUsername = escapeXml(username || 'Vaultlix identity');
    const badge = tier === 'reserve' ? 'RESERVE' : (tier === 'founding' ? 'FOUNDING MEMBER' : '');
    const badgeMarkup = badge
      ? `<g transform="translate(780 849)"><rect x="-176" y="-32" width="352" height="64" rx="32" fill="#7A2343"/><text text-anchor="middle" y="7" class="badge">${badge}</text></g>`
      : '';
    const modules = qrPath(qrMatrix, 82, 560, 470);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#54172E"/><stop offset=".55" stop-color="${BRAND}"/><stop offset="1" stop-color="#2E0B19"/></linearGradient>
    <filter id="card-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#250812" flood-opacity=".28"/></filter>
    <style>.brand{font:600 48px Georgia,serif;fill:#FFF8FA}.brand-pill{font:700 15px Inter,Arial,sans-serif;letter-spacing:4px;fill:#FFF8FA}.eyebrow{font:700 21px Inter,Arial,sans-serif;letter-spacing:5px;fill:#A04D6C}.number{font:800 82px Inter,Arial,sans-serif;letter-spacing:4px;fill:#681F3A}.name{font:650 35px Inter,Arial,sans-serif;fill:#32151F}.badge{font:700 18px Inter,Arial,sans-serif;letter-spacing:3px;fill:#FFF9FB}.copy{font:650 32px Inter,Arial,sans-serif;fill:#34242A}.fallback{font:700 34px Inter,Arial,sans-serif;fill:#681F3A}.small{font:700 19px Inter,Arial,sans-serif;letter-spacing:4px;fill:#9A536C}</style>
  </defs>
  <rect width="1080" height="1350" fill="url(#frame)"/>
  <text x="64" y="102" class="brand">Vaultlix</text>
  <rect x="708" y="55" width="306" height="66" rx="33" fill="none" stroke="#F7DCE5" stroke-width="2"/>
  <text x="861" y="96" text-anchor="middle" class="brand-pill">PRIVATE BY DESIGN</text>
  <rect x="38" y="160" width="1004" height="1118" rx="46" fill="#FFF9FA" filter="url(#card-shadow)"/>
  <rect x="38" y="160" width="18" height="1118" rx="9" fill="#F08AB1"/>
  <text x="104" y="264" class="eyebrow">YOUR PRIVATE LINE</text>
  <text x="104" y="382" class="number">${safeNumber}</text>
  <text x="104" y="448" class="name">${safeUsername}</text>
  <path d="M104 492H974" stroke="#D9AABD" stroke-width="2" stroke-dasharray="9 10"/>
  <rect x="82" y="560" width="470" height="470" rx="34" fill="#FFF" stroke="#E8D9DF" stroke-width="2"/>
  <path d="${modules}" fill="#2D0C18"/>
  <text x="604" y="665" class="copy"><tspan x="604">Scan to connect</tspan><tspan x="604" dy="44">privately on Vaultlix</tspan></text>
  ${badgeMarkup}
  <text x="604" y="948" class="fallback">vaultlix.com/${safeSharePath}</text>
  <text x="104" y="1188" class="small">NO SIM REQUIRED · PRIVATE BY DESIGN</text>
</svg>`;
  }

  function createPrivateInviteCardSvg({ username, inviteUrl, qrMatrix = [] }) {
    const displayUsername = String(username || 'A Vaultlix member').trim().slice(0, 32);
    const safeUsername = escapeXml(displayUsername);
    const headlineSize = displayUsername.length > 24 ? 36 : (displayUsername.length > 18 ? 44 : 56);
    const safeInviteUrl = escapeXml(inviteUrl || 'https://vaultlix.com');
    const safeInviteCode = escapeXml(String(inviteUrl || '').split('/').pop().slice(0, 12));
    const modules = qrPath(qrMatrix, 82, 548, 470);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <desc>Private invitation to ${safeInviteUrl}</desc>
  <defs>
    <linearGradient id="invite-frame" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#54172E"/><stop offset=".55" stop-color="${BRAND}"/><stop offset="1" stop-color="#2E0B19"/></linearGradient>
    <filter id="invite-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#250812" flood-opacity=".28"/></filter>
    <style>.brand{font:600 48px Georgia,serif;fill:#FFF8FA}.brand-pill{font:700 15px Inter,Arial,sans-serif;letter-spacing:4px;fill:#FFF8FA}.eyebrow{font:700 21px Inter,Arial,sans-serif;letter-spacing:5px;fill:#A04D6C}.headline{font:750 56px Inter,Arial,sans-serif;fill:#681F3A}.copy{font:600 29px Inter,Arial,sans-serif;fill:#34242A}.url{font:700 29px Inter,Arial,sans-serif;fill:#681F3A}.small{font:700 19px Inter,Arial,sans-serif;letter-spacing:4px;fill:#9A536C}.hours{font:700 18px Inter,Arial,sans-serif;letter-spacing:4px;fill:#FFF9FB}</style>
  </defs>
  <rect width="1080" height="1350" fill="url(#invite-frame)"/>
  <text x="64" y="102" class="brand">Vaultlix</text>
  <rect x="708" y="55" width="306" height="66" rx="33" fill="none" stroke="#F7DCE5" stroke-width="2"/>
  <text x="861" y="96" text-anchor="middle" class="brand-pill">PRIVATE BY DESIGN</text>
  <rect x="38" y="160" width="1004" height="1118" rx="46" fill="#FFF9FA" filter="url(#invite-shadow)"/>
  <rect x="38" y="160" width="18" height="1118" rx="9" fill="#F08AB1"/>
  <text x="104" y="264" class="eyebrow">PRIVATE INVITATION</text>
  <text x="104" y="370" class="headline" style="font-size:${headlineSize}px">${safeUsername} invited you</text>
  <text x="104" y="430" class="copy">Connect without sharing your mobile number</text>
  <path d="M104 482H974" stroke="#D9AABD" stroke-width="2" stroke-dasharray="9 10"/>
  <rect x="82" y="548" width="470" height="470" rx="34" fill="#FFF" stroke="#E8D9DF" stroke-width="2"/>
  <path d="${modules}" fill="#2D0C18"/>
  <text x="604" y="648" class="copy"><tspan x="604">Scan to connect directly</tspan><tspan x="604" dy="44">No approval needed</tspan></text>
  <rect x="604" y="790" width="290" height="64" rx="32" fill="#7A2343"/>
  <text x="749" y="830" text-anchor="middle" class="hours">24 HOURS</text>
  <text x="604" y="916" class="url"><tspan x="604">vaultlix.com/invite/</tspan><tspan x="604" dy="38">${safeInviteCode}</tspan></text>
  <text x="104" y="1188" class="small">ONE PERSON · PRE-APPROVED · EXPIRES IN 24 HOURS</text>
</svg>`;
  }

  return { WIDTH, HEIGHT, BRAND, createNumberCardSvg, createPrivateInviteCardSvg };
});

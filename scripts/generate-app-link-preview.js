'use strict';

const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const output = path.join(root, 'client', 'media', 'vaultlix-app-preview.png');
const icon = path.join(root, 'client', 'icons', 'icon-512.png');

const text = Buffer.from(`
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <text x="430" y="250" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="86" font-weight="700" letter-spacing="3">VAULTLIX</text>
  <text x="434" y="325" fill="#f4e9ed" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="600">Your mobile number stays yours.</text>
  <text x="434" y="390" fill="#ead7de" font-family="Arial, Helvetica, sans-serif" font-size="28">Private encrypted messages and calls</text>
  <text x="434" y="435" fill="#ead7de" font-family="Arial, Helvetica, sans-serif" font-size="28">for iPhone and Android</text>
</svg>`);

async function main() {
  const logo = await sharp(icon).resize(260, 260).png().toBuffer();
  await sharp({
    create: {
      width: 1200,
      height: 630,
      channels: 3,
      background: '#682c43'
    }
  })
    .composite([
      { input: logo, left: 92, top: 185 },
      { input: text, left: 0, top: 0 }
    ])
    .png({ compressionLevel: 9 })
    .toFile(output);
  console.log(output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

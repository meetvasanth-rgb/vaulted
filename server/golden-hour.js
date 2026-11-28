'use strict';

const sharp = require('sharp');

// A photographic grade only: no model, spatial filter, skin smoothing or
// reconstructed pixels. The same colour receives the same treatment everywhere.
async function gradeGoldenHour(bytes, width, height) {
  const { data, info } = await sharp(bytes, { limitInputPixels:60 * 1000 * 1000 })
    .resize(width, height, { fit:'cover', position:'centre' })
    .flatten({ background:'#ffffff' }).toColourspace('srgb').removeAlpha()
    .raw().toBuffer({ resolveWithObject:true });
  let totalChange = 0;
  let changedPixels = 0;
  const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    // Lift midtones and shadow detail, tapering at black and white to retain
    // contrast and highlight headroom. Warmth is bounded to avoid orange skin.
    const envelope = 4 * y * (1 - y);
    const lift = 15 * envelope;
    const warmth = 10 * envelope;
    data[i] = clamp(r + lift + warmth * (1 - r / 255));
    data[i + 1] = clamp(g + lift + warmth * 0.12);
    data[i + 2] = clamp(b + lift - warmth * 0.85);
    const dr = Math.abs(data[i] - r), dg = Math.abs(data[i + 1] - g), db = Math.abs(data[i + 2] - b);
    totalChange += dr + dg + db;
    if (Math.max(dr, dg, db) >= 8) changedPixels++;
  }
  // Check actual colour changes before JPEG encoding; compression noise must
  // never count as an edit. Throw before the route completes the quota claim.
  const pixels = info.width * info.height;
  if (totalChange / data.length < 5 || changedPixels / pixels < 0.2) {
    throw new Error('golden-hour-no-visible-change');
  }
  return sharp(data, { raw:{ width:info.width, height:info.height, channels:3 } })
    .jpeg({ quality:92, chromaSubsampling:'4:4:4' }).toBuffer();
}

module.exports = { gradeGoldenHour };

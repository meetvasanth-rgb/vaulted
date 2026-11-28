'use strict';

const sharp = require('sharp');

// A photographic grade only: no model, spatial filter, skin smoothing or
// reconstructed pixels. A broad light field adds afternoon direction without
// moving or synthesizing any scene detail.
async function gradeGoldenHour(bytes, width, height) {
  const { data, info } = await sharp(bytes, { limitInputPixels:60 * 1000 * 1000 })
    .resize(width, height, { fit:'cover', position:'centre' })
    .flatten({ background:'#ffffff' }).toColourspace('srgb').removeAlpha()
    .raw().toBuffer({ resolveWithObject:true });
  let totalChange = 0;
  let changedPixels = 0;
  let totalWarmthChange = 0;
  let visiblyWarmPixels = 0;
  const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    // Screen-relative light is resolution independent. This deliberately uses
    // a broad field, not simulated beams, flares, or invented face highlights.
    const x = (i / 3 % info.width) / Math.max(1, info.width - 1);
    const light = 1 - x;
    const envelope = 4 * y * (1 - y);
    const lift = (10 + 18 * light * light) * envelope;
    // Bound the colour shift uniformly; colour-based skin guesses can introduce
    // discontinuities in real skin texture and vary across skin tones.
    const warmth = 24 * envelope;
    data[i] = clamp(r + lift + warmth * 0.6 * (1 - r / 255));
    data[i + 1] = clamp(g + lift + warmth * 0.1);
    data[i + 2] = clamp(b + lift - warmth * 0.85);
    const dr = Math.abs(data[i] - r), dg = Math.abs(data[i + 1] - g), db = Math.abs(data[i + 2] - b);
    totalChange += dr + dg + db;
    if (Math.max(dr, dg, db) >= 8) changedPixels++;
    const warmthChange = (data[i] - data[i + 2]) - (r - b);
    totalWarmthChange += warmthChange;
    if (warmthChange >= 10) visiblyWarmPixels++;
  }
  // Check actual colour changes before JPEG encoding; compression noise must
  // never count as an edit. Throw before the route completes the quota claim.
  const pixels = info.width * info.height;
  if (totalChange / data.length < 8 || changedPixels / pixels < 0.2 ||
      totalWarmthChange / pixels < 8 || visiblyWarmPixels / pixels < 0.2) {
    throw new Error('golden-hour-no-visible-change');
  }
  return sharp(data, { raw:{ width:info.width, height:info.height, channels:3 } })
    .jpeg({ quality:92, chromaSubsampling:'4:4:4' }).toBuffer();
}

module.exports = { gradeGoldenHour };

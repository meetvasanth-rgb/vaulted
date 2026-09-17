'use strict';

const sharp = require('sharp');

const DAILY_LOOK_WATERMARK_VERSION = 1;

async function watermarkDailyLookOutput(source) {
  const metadata = await sharp(source, { failOn:'error' }).metadata();
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.height) || 0;
  if (!width || !height) throw new Error('image-watermark-metadata');
  const unit = Math.min(width, height);
  const fontSize = Math.max(18, Math.round(unit * .027));
  const padX = Math.round(fontSize * .62);
  const padY = Math.round(fontSize * .42);
  const margin = Math.round(unit * .022);
  const wordmarkScale = fontSize / 12;
  const wordmarkWidth = Math.round(52 * wordmarkScale);
  const badgeWidth = wordmarkWidth + padX * 2;
  const badgeHeight = fontSize + padY * 2;
  const radius = Math.round(fontSize * .55);
  const left = Math.max(0, width - badgeWidth - margin);
  const top = Math.max(0, height - badgeHeight - margin);
  const wordmarkTop = (badgeHeight - 12 * wordmarkScale) / 2;
  // Draw the wordmark as paths, never as a font-backed text element. Railway's lean production
  // image intentionally carries no system fonts, so a font-backed SVG can
  // render the pill but silently omit its letters. These paths are portable
  // vector geometry and therefore rasterize identically in every container.
  const badge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${badgeWidth}" height="${badgeHeight}"><rect width="100%" height="100%" rx="${radius}" fill="#25141d" fill-opacity=".58"/><g transform="translate(${padX} ${wordmarkTop}) scale(${wordmarkScale})" fill="none" stroke="#fff" stroke-opacity=".94" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M0 1l3.5 10L7 1"/><path d="M16 5v6m0-3.2C14.5 4.3 9 5 9 8s5.5 3.7 7 0"/><path d="M18 5v3.4c0 3.6 7 3.6 7 0V5"/><path d="M28 1v10"/><path d="M34 2v7c0 1.5.8 2 2 2M31 5h5"/><path d="M39 1v10"/><path d="M42 5v6m0-9.3v.1"/><path d="M45 5l7 6m0-6-7 6"/></g></svg>`);
  return sharp(source, { failOn:'error' })
    .composite([{ input:badge, left, top }])
    .jpeg({ quality:94 })
    .toBuffer();
}

module.exports = { DAILY_LOOK_WATERMARK_VERSION, watermarkDailyLookOutput };

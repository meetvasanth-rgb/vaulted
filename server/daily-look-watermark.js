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
  const badgeWidth = Math.round(fontSize * 4.35 + padX * 2);
  const badgeHeight = fontSize + padY * 2;
  const radius = Math.round(fontSize * .55);
  const left = Math.max(0, width - badgeWidth - margin);
  const top = Math.max(0, height - badgeHeight - margin);
  const badge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${badgeWidth}" height="${badgeHeight}"><rect width="100%" height="100%" rx="${radius}" fill="#25141d" fill-opacity=".58"/><text x="${padX}" y="50%" dy=".35em" fill="#fff" fill-opacity=".94" font-family="Arial,DejaVu Sans,sans-serif" font-size="${fontSize}" font-weight="700">Vaultlix</text></svg>`);
  return sharp(source, { failOn:'error' })
    .composite([{ input:badge, left, top }])
    .jpeg({ quality:94 })
    .toBuffer();
}

module.exports = { DAILY_LOOK_WATERMARK_VERSION, watermarkDailyLookOutput };

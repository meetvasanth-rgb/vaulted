'use strict';

// All five message tones are levelled to the same loudness (-12 LUFS) so none is
// quieter than another and a tone picker never makes a message hard to hear. The
// replacement chime once shipped about 20 dB quieter than the call ringtones
// because nothing measured it. This measures the bundled files with the BS.1770
// K-weighting and gating that ffmpeg's ebur128 uses (short tones are looped so
// the 400 ms window has enough signal, the same way they were levelled).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// The tones offered in Settings -> Message sound ship as vault_tone_<id> files.
const PICKER_TONE_IDS = ['glow', 'bright', 'sweet', 'notify', 'soft', 'whistle', 'triplet', 'ripple', 'spark', 'lantern', 'harp', 'marimba', 'droplet'];
const TONES = ['chime', 'note', 'soft', 'glass', 'pulse', ...PICKER_TONE_IDS.map(id => `tone_${id}`)];
const TARGET_LUFS = -12;
const TOLERANCE = 0.6;
const CEILING_DBFS = -1;

const androidPath = tone => path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'res', 'raw', `vault_${tone}.wav`);
const iosPath = tone => path.join(root, 'mobile', 'ios', 'App', 'App', 'Sounds', `vault_${tone}.caf`);

function wavPcm(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  let offset = 12, format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { channels:buffer.readUInt16LE(offset + 10), rate:buffer.readUInt32LE(offset + 12), bits:buffer.readUInt16LE(offset + 22) };
    if (id === 'data') return { ...format, data:buffer.subarray(offset + 8, offset + 8 + size) };
    offset += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

function cafPcm(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'caff');
  let offset = 8, format = null;
  while (offset + 12 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = Number(buffer.readBigInt64BE(offset + 4));
    if (id === 'desc') {
      const flags = buffer.readUInt32BE(offset + 12 + 20);
      format = { rate:buffer.readDoubleBE(offset + 12), channels:buffer.readUInt32BE(offset + 12 + 24), bits:buffer.readUInt32BE(offset + 12 + 28), littleEndian:Boolean(flags & 2) };
    }
    if (id === 'data') return { ...format, data:buffer.subarray(offset + 12 + 4, offset + 12 + size) };
    offset += 12 + size;
  }
  throw new Error('no data chunk');
}

function samples(pcm) {
  assert.equal(pcm.bits, 16);
  assert.equal(pcm.channels, 1, 'message tones are mono');
  const out = new Float64Array(pcm.data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (pcm.littleEndian === false ? pcm.data.readInt16BE(i * 2) : pcm.data.readInt16LE(i * 2)) / 32768;
  return out;
}

function biquad(input, b, a) {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function kWeight(input, rate) {
  const f1 = 1681.974450955533, g = 3.999843853973347, q1 = 0.7071752369554196;
  let k = Math.tan(Math.PI * f1 / rate);
  const vh = 10 ** (g / 20), vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q1 + k * k;
  const shelf = biquad(input,
    [(vh + vb * k / q1 + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q1 + k * k) / a0],
    [1, 2 * (k * k - 1) / a0, (1 - k / q1 + k * k) / a0]);
  const f2 = 38.13547087602444, q2 = 0.5003270373238773;
  k = Math.tan(Math.PI * f2 / rate);
  a0 = 1 + k / q2 + k * k;
  return biquad(shelf, [1, -2, 1], [1, 2 * (k * k - 1) / a0, (1 - k / q2 + k * k) / a0]);
}

function integratedLufs(input, rate) {
  let signal = input;
  const seconds = input.length / rate;
  if (seconds < 1.2) {
    const copies = Math.max(2, Math.ceil(3 / seconds));
    signal = new Float64Array(input.length * copies);
    for (let i = 0; i < copies; i++) signal.set(input, i * input.length);
  }
  const weighted = kWeight(signal, rate);
  const block = Math.round(0.4 * rate), step = Math.round(0.1 * rate);
  const energies = [];
  for (let start = 0; start + block <= weighted.length; start += step) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += weighted[i] * weighted[i];
    energies.push(sum / block);
  }
  const lufs = energy => -0.691 + 10 * Math.log10(energy);
  const absolute = energies.filter(energy => lufs(energy) > -70);
  const relativeGate = lufs(absolute.reduce((a, b) => a + b, 0) / absolute.length) - 10;
  const gated = absolute.filter(energy => lufs(energy) > relativeGate);
  return lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}

test('every message tone is levelled to -12 LUFS', () => {
  for (const tone of TONES) {
    const pcm = wavPcm(fs.readFileSync(androidPath(tone)));
    const loudness = integratedLufs(samples(pcm), pcm.rate);
    assert.ok(Math.abs(loudness - TARGET_LUFS) <= TOLERANCE, `${tone} measures ${loudness.toFixed(2)} LUFS, expected ${TARGET_LUFS} ±${TOLERANCE}`);
  }
});

test('no tone clips or comes close: sample peaks stay below -1 dBFS', () => {
  for (const tone of TONES) {
    const pcm = wavPcm(fs.readFileSync(androidPath(tone)));
    const peak = Math.max(...samples(pcm).map(Math.abs));
    const dbfs = 20 * Math.log10(peak);
    assert.ok(dbfs <= CEILING_DBFS, `${tone} peaks at ${dbfs.toFixed(2)} dBFS`);
  }
});

test('the iOS and Android copies of each tone carry exactly the same audio', () => {
  for (const tone of TONES) {
    const android = wavPcm(fs.readFileSync(androidPath(tone)));
    const ios = cafPcm(fs.readFileSync(iosPath(tone)));
    assert.equal(ios.rate, android.rate, `${tone} sample rate`);
    assert.ok(ios.data.equals(android.data), `${tone}: iOS and Android audio differ`);
  }
});

test('the web chime ships next to the native ones and is cached by the service worker', () => {
  const mp3 = path.join(root, 'client', 'vault_chime.mp3');
  assert.ok(fs.statSync(mp3).size > 10000);
  assert.match(fs.readFileSync(path.join(root, 'client', 'sw.js'), 'utf8'), /'\/vault_chime\.mp3'/);
});

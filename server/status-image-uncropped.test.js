'use strict';

// Status photos used to go through the profile-picture compressor, which centre-crops to a 512px
// square, so a normal photo arrived cropped and small. They now keep their whole frame and
// proportions at a higher resolution, under the same size ceiling.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFunction(name, prefix = 'async function') {
  const start = client.indexOf(`${prefix} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

function harness({ width, height, sizeFor = () => 100 }) {
  const canvases = [];
  class FakeImage {
    set src(value) { this.naturalWidth = width; this.naturalHeight = height; setTimeout(() => this.onload(), 0); }
  }
  const context = vm.createContext({
    Image: FakeImage, setTimeout, Math, Promise, Error,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    document: { createElement: () => {
      const canvas = { drawCalls:[], getContext: () => ({ fillRect() {}, drawImage: (...args) => canvas.drawCalls.push(args), set fillStyle(v) {} }),
        toDataURL: (type, quality) => 'x'.repeat(sizeFor(canvas, quality)) };
      canvases.push(canvas);
      return canvas;
    } },
  });
  const source = ['const STATUS_IMAGE_MAX_DATA_URL', 'const STATUS_IMAGE_LONG_SIDES', 'const STATUS_IMAGE_QUALITIES']
    .map(name => client.slice(client.indexOf(name), client.indexOf(';', client.indexOf(name)) + 1)).join('\n');
  vm.runInContext(source + '\n' + extractFunction('compressStatusImage'), context);
  return { context, canvases };
}

const photo = { name:'p.jpg', type:'image/jpeg' };

test('a landscape photo keeps its proportions and is not cropped to a square', async () => {
  const { context, canvases } = harness({ width:4000, height:3000 });
  await context.compressStatusImage(photo);
  const canvas = canvases[0];
  assert.equal(canvas.width, 1280);
  assert.equal(canvas.height, 960);
  // The whole source frame is drawn: no source rectangle, so nothing is cut off.
  assert.deepEqual(canvas.drawCalls[0].slice(1), [0, 0, 1280, 960]);
});

test('a portrait photo keeps its proportions too', async () => {
  const { context, canvases } = harness({ width:3000, height:4000 });
  await context.compressStatusImage(photo);
  assert.equal(canvases[0].width, 960);
  assert.equal(canvases[0].height, 1280);
});

test('a small photo is never enlarged', async () => {
  const { context, canvases } = harness({ width:400, height:300 });
  await context.compressStatusImage(photo);
  assert.equal(canvases[0].width, 400);
  assert.equal(canvases[0].height, 300);
});

test('too-large results step the quality and then the size down until they fit the ceiling', async () => {
  const ceiling = 341 * 1024;
  // Only the 720px version at the lowest quality tried first for that size is small enough.
  const { context, canvases } = harness({ width:4000, height:3000,
    sizeFor: (canvas, quality) => canvas.width <= 720 && quality >= .82 ? ceiling - 1 : ceiling + 1 });
  const result = await context.compressStatusImage(photo);
  assert.ok(result.length <= ceiling);
  assert.equal(canvases.at(-1).width, 720);
});

test('an image that cannot be reduced enough is refused rather than sent oversized', async () => {
  const { context } = harness({ width:4000, height:3000, sizeFor: () => 10_000_000 });
  await assert.rejects(context.compressStatusImage(photo), /could not be reduced enough/);
});

test('non-images are refused', async () => {
  const { context } = harness({ width:10, height:10 });
  await assert.rejects(context.compressStatusImage({ name:'x.txt', type:'text/plain' }), /Choose a photo/);
});

test('the status composer uses it, and the profile picture still uses the square crop', () => {
  const prepare = client.slice(client.indexOf('async function prepareStatusMedia'), client.indexOf('async function publishStatus'));
  assert.match(prepare, /await compressStatusImage\(file\)/);
  assert.doesNotMatch(prepare, /compressProfileImage/);
  assert.match(client, /canvas\.width = 512; canvas\.height = 512;/);
});

test('the viewer shows the whole image (contain), the same as video', () => {
  assert.match(client, /\.status-stage>img,\.status-stage>video\{[^}]*object-fit:contain/);
});

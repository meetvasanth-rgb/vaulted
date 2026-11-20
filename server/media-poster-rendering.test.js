const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../client/index.html'), 'utf8');
const start = source.indexOf('function buildAlbumGridHtml(rec)');
const end = source.indexOf('// replyData travels', start);
const context = vm.createContext({
  safeImageDataUri: (_mime, data) => data ? `data:image/jpeg;base64,${data}` : null,
  safeMessageImagePreview: value => value || null,
  escHtml: value => String(value),
});
vm.runInContext(source.slice(start, end), context);
function album(thumb) {
  return context.buildAlbumGridHtml({ id:'album', pending:true, isMe:true,
    images:[{id:'video', kind:'video', mime:'video/mp4', localPreviewUrl:'blob:local', videoThumb:thumb}] });
}
test('ready video poster renders as an image even while the source object URL exists', () => {
  const html = album('poster');
  assert.match(html, /<img class="msg-album-video-thumb"/);
  assert.doesNotMatch(html, /<video/);
});
test('a pending video without a poster has a shimmer rather than a browser play surface', () => {
  const html = album(null);
  assert.match(html, /msg-image-preview-loading/);
  assert.doesNotMatch(html, /<video|msg-album-video-play/);
});

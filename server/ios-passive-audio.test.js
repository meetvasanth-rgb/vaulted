const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../client/index.html'), 'utf8');
function extract(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(next, source.indexOf(`function ${name}(`)));
}
test('ordinary iOS interaction never creates or resumes an audio context', () => {
  const context = vm.createContext({ nativePlatform:() => 'ios' });
  vm.runInContext(extract('unlockAudio', "['touchend'"), context);
  // No Web Audio globals exist: reaching them would throw outside the guard.
  context.unlockAudio();
});
test('passive iOS chimes do not acquire audio focus', () => {
  const context = vm.createContext({ nativePlatform:() => 'ios' });
  vm.runInContext(extract('playChime', '// ── TAB VISIBILITY'), context);
  context.playChime();
});
test('iOS thumbnail decoding seeks without playing; Android retains playback fallback', () => {
  for (const platform of ['ios', 'android']) {
    let plays = 0;
    const video = { style:{}, setAttribute(){}, load(){}, play(){ plays++; return Promise.resolve(); } };
    const context = vm.createContext({ nativePlatform:() => platform,
      URL:{ createObjectURL:() => 'blob:test' },
      document:{ createElement:() => video, body:{appendChild(){}} },
      setTimeout:() => 1, requestAnimationFrame:() => {},
    });
    vm.runInContext(extract('createVideoAttachmentThumbnail', 'function createVideoAttachmentThumbnailFromBase64'), context);
    context.createVideoAttachmentThumbnail({});
    video.onseeked();
    assert.equal(plays, platform === 'ios' ? 0 : 1);
  }
});

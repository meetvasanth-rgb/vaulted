'use strict';

// Settings > Storage shows what this device holds, lets the person choose how
// much downloaded media to keep, and clears downloads without touching messages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

function world(storage = {}) {
  const context = vm.createContext({
    Number, Math, Array, Object, Set, JSON, String,
    localStorage: { getItem: key => (key in storage ? storage[key] : null), setItem: (key, value) => { storage[key] = String(value); } },
    settingsCategory: null,
    attachmentCacheTrim: () => Promise.resolve(),
    renderStoragePage: () => Promise.resolve(),
  });
  vm.runInContext(`
    const ATTACHMENT_CACHE_MAX_BYTES = 600 * 1024 * 1024;
    const ATTACHMENT_CACHE_LIMIT_KEY = 'vaultlix_attachment_cache_limit_mb';
    const ATTACHMENT_CACHE_LIMIT_CHOICES_MB = [200, 600, 1024, 2048];`, context);
  for (const name of ['attachmentCacheLimitBytes', 'setAttachmentCacheLimitMb', 'formatStorageBytes', 'groupBytesByRoom', 'groupCountByRoom']) {
    vm.runInContext(extract(client, name), context);
  }
  return { context, storage };
}
const MB = 1024 * 1024;
const call = (w, expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, w.context));

test('the download limit defaults to 600 MB and honours only the offered choices', () => {
  assert.equal(call(world(), 'attachmentCacheLimitBytes()'), 600 * MB);
  assert.equal(call(world({ vaultlix_attachment_cache_limit_mb:'200' }), 'attachmentCacheLimitBytes()'), 200 * MB);
  assert.equal(call(world({ vaultlix_attachment_cache_limit_mb:'2048' }), 'attachmentCacheLimitBytes()'), 2048 * MB);
  for (const junk of ['0', '-5', '999999', 'lots', '', 'NaN']) {
    assert.equal(call(world({ vaultlix_attachment_cache_limit_mb:junk }), 'attachmentCacheLimitBytes()'), 600 * MB, `junk value ${junk}`);
  }
});

test('choosing a limit stores it under its own key, ignores anything not offered, and trims at once', async () => {
  const w = world();
  let trimmed = 0;
  w.context.attachmentCacheTrim = () => { trimmed++; return Promise.resolve(); };
  vm.runInContext('setAttachmentCacheLimitMb(1024)', w.context);
  assert.equal(w.storage.vaultlix_attachment_cache_limit_mb, '1024');
  assert.equal(call(w, 'attachmentCacheLimitBytes()'), 1024 * MB);
  vm.runInContext('setAttachmentCacheLimitMb(12345)', w.context);
  assert.equal(w.storage.vaultlix_attachment_cache_limit_mb, '1024', 'an unoffered value changes nothing');
  await Promise.resolve();
  assert.equal(trimmed, 1);
});

test('sizes are shown in KB, MB or GB', () => {
  const fmt = bytes => call(world(), `formatStorageBytes(${JSON.stringify(bytes)})`);
  assert.equal(fmt(0), '0 KB');
  assert.equal(fmt(300 * 1024), '300 KB');
  assert.equal(fmt(5 * MB), '5.0 MB');
  assert.equal(fmt(120 * MB), '120 MB');
  assert.equal(fmt(1.5 * 1024 * MB), '1.5 GB');
  assert.equal(fmt(-4), '0 KB');
  assert.equal(fmt('junk'), '0 KB');
});

test('downloads are totalled per conversation and junk rows are ignored', () => {
  const w = world();
  const result = call(w, `groupBytesByRoom([{code:'a',size:100},{code:'a',size:50},{code:'b',size:7},{code:'c',size:0},{size:9},null,{code:'d',size:'x'}])`);
  assert.deepEqual(result, { byRoom:{ a:150, b:7 }, total:157 });
  assert.deepEqual(call(w, 'groupBytesByRoom(undefined)'), { byRoom:{}, total:0 });
});

test('saved messages are counted per conversation from their keys', () => {
  const w = world();
  assert.deepEqual(call(w, `groupCountByRoom([['a','1'],['a','2'],['b','1'],'bad',null,[]])`), { byRoom:{ a:2, b:1 }, total:3 });
  assert.deepEqual(call(w, 'groupCountByRoom(undefined)'), { byRoom:{}, total:0 });
});

test('Storage is a settings page: a menu row, a section, and the page switching', () => {
  assert.match(client, /onclick="openSettingsCategory\('storage'\)"[\s\S]{0,700}Saved messages and downloaded attachments/);
  assert.match(client, /<div id="settings-storage-section" class="settings-category-page">/);
  assert.match(client, /storage:'Storage'/);
  assert.match(client, /category === 'share' \|\| category === 'calls' \|\| category === 'storage' \|\| category === 'language'/);
  assert.match(client, /if \(category === 'storage'\) renderStoragePage\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(client, /document\.getElementById\('settings-storage-section'\)\.style\.display = 'none';/);
});

test('clearing downloads never touches messages, and asks first', () => {
  const clearRoom = extract(client, 'clearRoomDownloads');
  const clearAll = extract(client, 'clearAllDownloads');
  for (const source of [clearRoom, clearAll]) {
    assert.match(source, /confirm\(/);
    assert.doesNotMatch(source, /historyStore|removeMessageRecord|deleteMessage/);
  }
  assert.match(clearRoom, /attachmentCacheClearRoom\(code\)/);
  assert.match(clearAll, /attachmentCacheClearAll\(\)/);
  assert.match(client, /store\.clear\(\)/);
});

test('the limit uses its own storage key and the trim uses the chosen limit', () => {
  assert.match(client, /const ATTACHMENT_CACHE_LIMIT_KEY = 'vaultlix_attachment_cache_limit_mb';/);
  assert.match(client, /const limit = attachmentCacheLimitBytes\(\);\s*\n\s*if \(total <= limit\) return;/);
  const setter = extract(client, 'setAttachmentCacheLimitMb');
  assert.doesNotMatch(setter, /persistRoom|roomStorageKey/);
});

test('the system is asked, best effort, not to clear this data', () => {
  assert.match(client, /navigator\.storage\?\.persist\?\.\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(client, /if \(saved\) \{ requestPersistentStorage\(\); attachmentCacheTrim\(\)/);
  assert.match(client, /The system may clear it if this device runs very low on space\./);
});

test('no raw noncharacter is left in the source (the range end uses the escape)', () => {
  assert.equal(client.includes(String.fromCharCode(0xFFFF)), false);
  assert.equal((client.match(/\\uffff/g) || []).length >= 2, true);
});

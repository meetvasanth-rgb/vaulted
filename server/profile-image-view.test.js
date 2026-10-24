'use strict';

// Your own profile picture can be opened full size from your profile: tap the picture, or "View full size".
// It uses the same full-screen viewer as chat photos, raised above the account panel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

function harness(profileImage) {
  const attributes = new Map();
  const preview = {
    classes:new Set(), children:[], textContent:'', onclick:null, onkeydown:null, tabIndex:-1,
    classList:{ toggle: (name, on) => { on ? preview.classes.add(name) : preview.classes.delete(name); }, contains: name => preview.classes.has(name) },
    replaceChildren() { preview.children = []; preview.textContent = ''; },
    appendChild: child => preview.children.push(child),
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    getAttribute: name => attributes.get(name),
  };
  const view = { hidden:true }, change = { textContent:'' }, remove = { hidden:true };
  const toasts = [], viewed = [];
  const byId = { 'account-profile-photo-preview':preview, 'account-profile-photo-view':view, 'account-profile-photo-change':change, 'account-profile-photo-remove':remove };
  const context = vm.createContext({
    document: { getElementById: id => byId[id] || null, createElement: () => ({}) },
    loadAccountState: () => ({ displayName:'Vasanth', profileImage }),
    safeProfileImageUri: value => typeof value === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null,
    toast: message => toasts.push(message),
    viewImage: (src, options) => viewed.push({ src, options }),
    String,
  });
  vm.runInContext(extractFunction('renderAccountProfilePhoto') + '\n' + extractFunction('viewOwnProfileImage'), context);
  context.renderAccountProfilePhoto();
  return { context, preview, view, change, remove, toasts, viewed, attributes };
}

const IMAGE = 'data:image/jpeg;base64,AAAA';

test('with a profile image, the picture is a button and "View full size" is offered', () => {
  const h = harness(IMAGE);
  assert.equal(h.preview.classes.has('has-image'), true);
  assert.equal(h.attributes.get('role'), 'button');
  assert.equal(h.preview.tabIndex, 0);
  assert.equal(h.view.hidden, false);
  assert.equal(h.change.textContent, 'Change image');
  assert.equal(h.remove.hidden, false);
});

test('tapping the picture or pressing Enter or Space opens it full size above the account panel', () => {
  const h = harness(IMAGE);
  h.preview.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.viewed)), [{ src:IMAGE, options:{ zIndex:14000 } }]);
  let prevented = 0;
  h.preview.onkeydown({ key:'Enter', preventDefault: () => prevented++ });
  h.preview.onkeydown({ key:' ', preventDefault: () => prevented++ });
  h.preview.onkeydown({ key:'a', preventDefault: () => prevented++ });
  assert.equal(h.viewed.length, 3);
  assert.equal(prevented, 2);
  // Above the account overlay (z-index 12000) and the Daily Look/share sheets (13000-13050).
  assert.ok(14000 > 13050 && /\.account-overlay\{position:fixed;inset:0;z-index:12000/.test(client));
});

test('without a profile image the picture is not a button, and nothing opens', () => {
  const h = harness(null);
  assert.equal(h.preview.classes.has('has-image'), false);
  assert.equal(h.attributes.has('role'), false);
  assert.equal(h.preview.onclick, null);
  assert.equal(h.view.hidden, true);
  assert.equal(h.change.textContent, 'Add image');
  h.context.viewOwnProfileImage();
  assert.equal(h.viewed.length, 0);
  assert.deepEqual(h.toasts, ['Add a profile image first']);
});

test('an unsafe stored value is never shown', () => {
  const h = harness('javascript:alert(1)');
  assert.equal(h.preview.onclick, null);
  h.context.viewOwnProfileImage();
  assert.equal(h.viewed.length, 0);
});

test('the profile editor has the View full size button, wired and hidden until there is an image', () => {
  assert.match(client, /<button class="profile-photo-action" id="account-profile-photo-view" type="button" onclick="viewOwnProfileImage\(\)" hidden>View full size<\/button>/);
  assert.match(client, /\.profile-photo-preview\.has-image\{cursor:zoom-in\}/);
});

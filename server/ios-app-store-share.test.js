'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const getApp = fs.readFileSync(path.join(root, 'client', 'get-app.html'), 'utf8');
const generator = fs.readFileSync(path.join(root, 'scripts', 'generate-ios-app-store-card.js'), 'utf8');
const png = fs.readFileSync(path.join(root, 'client', 'media', 'vaultlix-ios-app-store-card.png'));
const appStoreBadge = fs.readFileSync(path.join(root, 'client', 'media', 'download-on-the-app-store.svg'), 'utf8');
const playStoreBadge = fs.readFileSync(path.join(root, 'client', 'media', 'get-it-on-google-play.png'));

const APP_STORE_URL = 'https://apps.apple.com/in/app/vaultlix/id6798266989';

test('website and get-app page link directly to the released iPhone app', () => {
  assert.match(client, new RegExp(APP_STORE_URL.replaceAll('/', '\\/')));
  assert.match(getApp, new RegExp(APP_STORE_URL.replaceAll('/', '\\/')));
  assert.doesNotMatch(getApp, /Coming soon|submitted for App Store review/);
});

test('Get the app QR routes each phone to its correct store', () => {
  assert.match(client, /openWebsiteGetApp\(\)/);
  assert.match(client, /id="website-get-app-qr"/);
  assert.match(client, /renderQrCanvas\(document\.getElementById\('website-get-app-qr'\), VAULTLIX_PUBLIC_APP_LINK\)/);
  assert.match(getApp, /iPhone\|iPad\|iPod/);
  assert.match(getApp, /Android/);
  assert.match(getApp, /https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.vaultlix\.app/);
  assert.match(getApp, /location\.replace/);
});

test('website uses official black store badge artwork at matching visual sizes', () => {
  assert.match(appStoreBadge, /Download_on_the_App_Store_Badge/);
  assert.equal(playStoreBadge.subarray(1, 4).toString(), 'PNG');
  for (const page of [client, getApp]) {
    assert.match(page, /\/media\/download-on-the-app-store\.svg/);
    assert.match(page, /\/media\/get-it-on-google-play\.png/);
    assert.match(page, /apps\.apple\.com\/in\/app\/vaultlix\/id6798266989/);
    assert.match(page, /play\.google\.com\/store\/apps\/details\?id=com\.vaultlix\.app/);
  }
  assert.match(client, /official-store-badge apple/);
  assert.match(client, /official-store-badge google/);
});

test('iPhone share card QR contains only the public App Store destination', () => {
  assert.match(generator, new RegExp(`APP_STORE_URL = '${APP_STORE_URL.replaceAll('/', '\\/')}'`));
  assert.match(generator, /correctLevel: sandbox\.QRCode\.CorrectLevel\.H/);
  assert.match(client, /vaultlix-ios-app-store-card\.png/);
  assert.match(client, /function shareIosAppStoreCard/);
  assert.match(client, /function saveIosAppStoreCard/);
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1350);
});

test('mobile settings keeps all sharing in one submenu without profile duplicates', () => {
  const menu = client.slice(client.indexOf('<div class="settings-menu"'), client.indexOf('<div id="settings-general-section">'));
  const profile = client.slice(client.indexOf('<div id="settings-profile-controls"'), client.indexOf('<div id="settings-share-section"'));
  const share = client.slice(client.indexOf('<div id="settings-share-section"'), client.indexOf('<div id="settings-calls-section"'));
  assert.match(menu, /openSettingsCategory\('share'\)/);
  assert.doesNotMatch(menu, /onclick="openShareVaultlix\(\)"/);
  assert.doesNotMatch(profile, /shareOwnPrivateNumber|showOwnPrivateNumberQr/);
  assert.match(share, /shareOwnPrivateNumber\(\)/);
  assert.match(share, /openShareVaultlix\(\)/);
  assert.equal((share.match(/class="settings-row"/g) || []).length, 2);
  assert.match(client, /shareSection\.classList\.toggle\('active', category === 'share'\)/);
});

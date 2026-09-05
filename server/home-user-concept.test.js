const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('home page explains the private-number user model', () => {
  assert.match(client, /Your private number\.<br>No SIM required\./);
  assert.match(client, /Get my Vaultlix number/);
  assert.equal((client.match(/Get your own Vaultlix Private Number and connect privately—without sharing your phone number\./g) || []).length, 2);
  assert.match(client, /<span>No SIM<\/span><span>No phone number<\/span><span>No email<\/span><span>No contact upload<\/span>/);
  assert.match(client, /01 · Identify/);
  assert.match(client, /02 · Approve/);
  assert.match(client, /03 · Connect/);
  assert.match(client, /People must know the exact number and you decide whether to connect/);
});

test('home page footer does not repeat the FAQ section', () => {
  const footer = client.match(/<div class="landing-footer">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.equal((footer.match(/showScreen\('s-faq'\)/g) || []).length, 0);
});

test('home page explains privacy without infrastructure jargon', () => {
  const marketing = client.match(/<div class="landing-marketing"[\s\S]*?<\/main>/)?.[0] || '';
  assert.match(marketing, /Strong 256-bit encryption protects every message/);
  assert.match(marketing, /Vaultlix cannot listen to or record them/);
  for (const jargon of ['WebRTC', 'DTLS-SRTP', 'TURN service', 'ciphertext', 'Operational metadata', 'client-encrypted account bundle']) {
    assert.equal(marketing.includes(jargon), false, `homepage jargon remains: ${jargon}`);
  }
});

test('user-facing legacy vault labels are replaced with conversation language', () => {
  for (const legacy of [
    'Create a vault',
    'Vault ready',
    'Label this vault',
    'Tap to open vault',
    'Private vault',
    'Vault erased',
    'Start a new vault',
    'Make this a permanent vault?',
  ]) assert.equal(client.includes(legacy), false, `legacy label remains: ${legacy}`);
});

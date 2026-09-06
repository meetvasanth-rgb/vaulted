const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('an original private-line animation welcomes empty conversations', () => {
  assert.match(client, /function privateLineWelcomeMarkup\(\)/);
  assert.match(client, /Your private line is open/);
  assert.match(client, /private-line-thread/);
  assert.match(client, /private-line-particle/);
  assert.match(client, /private-line-core-backdrop/);
  assert.match(client, /private-line-core-backdrop\{fill:#6B1F3A;opacity:\.88/);
  assert.match(client, /hasConversationContent = room\.messages\.some/);
  assert.match(client, /document\.getElementById\('private-line-welcome'\)\?\.remove\(\)/);
});

test('welcome motion remains lightweight and accessibility-aware', () => {
  assert.match(client, /SVG \+ transforms/);
  assert.match(client, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(client, /jitter\.video|instagram\.com/i);
  assert.match(client, /aria-label="Your private line is open\. Say hello when you are ready\."/);
});

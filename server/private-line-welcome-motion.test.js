const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('chat does not inject the retired two-circle connection animation', () => {
  assert.doesNotMatch(client, /function privateLineWelcomeMarkup\(\)/);
  assert.doesNotMatch(client, /privateLineWelcomeMarkup\(\)/);
  assert.match(client, /body\.innerHTML = '<div class="typing-indicator"/);
});

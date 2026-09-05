'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const server = readFileSync(join(__dirname, 'index.js'), 'utf8');

test('free Private Numbers use a two-year inactivity clock with staged warnings', () => {
  assert.match(server, /const FREE_NUMBER_INACTIVITY_MS = 730 \* DAY_MS/);
  for (const stage of ['6-months', '3-months', '30-days', '7-days']) {
    assert.match(server, new RegExp(`id:'${stage}'`));
  }
  assert.match(server, /touchAccountActivity\(accountId, account\)/);
  assert.match(server, /account\.reclaimWarnings = \[\]/);
});

test('Premium and special-number protection cannot be supplied by an untrusted registration client', () => {
  assert.match(server, /const reservedCategory = d\.reservationToken[\s\S]*verifyPrivateNumberReservation/);
  assert.match(server, /numberProtection:reservedCategory === 'standard' \? 'free' : 'promotional'/);
  assert.doesNotMatch(server, /numberProtection:d\.numberProtection|premiumUntil:d\.premiumUntil/);
  assert.match(server, /protection === 'purchased' \|\| protection === 'promotional'/);
  assert.match(server, /premiumUntil > now/);
});

test('reclaimed free numbers are quarantined and protected special numbers are retired', () => {
  assert.match(server, /const RECLAIM_QUARANTINE_MS = 365 \* DAY_MS/);
  assert.match(server, /status:permanent \? 'retired' : 'quarantined'/);
  assert.match(server, /await postgresStore\.releasePrivateNumber/);
  assert.match(server, /Opening a notification alone does not reset inactivity/);
});

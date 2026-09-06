'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NUMBER_TIERS,
  normalizePrivateNumber,
  assignAccountTier,
  allocateUniqueStandardNumber,
  isNumberAvailable,
} = require('./private-number-policy');

test('concurrent generation claims each standard number once', async () => {
  const claimed = new Set();
  let candidate = 2_000_000_000;
  const generate = () => String(candidate++);
  const claim = async number => {
    await new Promise(resolve => setImmediate(resolve));
    if (claimed.has(number)) return false;
    claimed.add(number);
    return true;
  };
  const numbers = await Promise.all(Array.from({ length:100 }, () =>
    allocateUniqueStandardNumber(claim, { generate })));
  assert.equal(new Set(numbers).size, 100);
  assert.ok(numbers.every(number => /^\d{10}$/.test(number)));
});

test('founding tier is permanently determined by account creation order', () => {
  assert.deepEqual(assignAccountTier({ creationOrder:1 }), { tier:NUMBER_TIERS.FOUNDING, isFounding:true });
  assert.deepEqual(assignAccountTier({ creationOrder:10_000 }), { tier:NUMBER_TIERS.FOUNDING, isFounding:true });
  assert.deepEqual(assignAccountTier({ creationOrder:10_001 }), { tier:NUMBER_TIERS.STANDARD, isFounding:false });
  assert.deepEqual(assignAccountTier({ creationOrder:7, reservationTier:NUMBER_TIERS.RESERVE }), { tier:NUMBER_TIERS.RESERVE, isFounding:true });
});

test('the model accepts future short Reserve numbers without allocating them', () => {
  assert.equal(normalizePrivateNumber('23-4567'), '234567');
  assert.equal(normalizePrivateNumber('12345'), '');
});

test('deleted numbers never return to the allocation pool', () => {
  const number = '2345678901';
  const lifecycle = new Map([[number, { status:'retired', reason:'account-deleted' }]]);
  assert.equal(isNumberAvailable(number, { activeNumbers:new Map(), lifecycle }), false);
  lifecycle.delete(number);
  assert.equal(isNumberAvailable(number, { activeNumbers:new Map(), lifecycle }), true);
});

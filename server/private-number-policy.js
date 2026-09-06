'use strict';

const crypto = require('crypto');

const NUMBER_TIERS = Object.freeze({
  STANDARD:'standard',
  RESERVE:'reserve',
  FOUNDING:'founding',
});
const FOUNDING_ACCOUNT_LIMIT = 10_000;

function normalizePrivateNumber(value) {
  const number = String(value || '').replace(/\D/g, '');
  return /^[2-9][0-9]{5,9}$/.test(number) ? number : '';
}

function generateStandardNumber(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(10);
  let number = String(2 + (bytes[0] % 8));
  for (let index = 1; index < bytes.length; index++) number += String(bytes[index] % 10);
  return number;
}

function assignAccountTier({ creationOrder, reservationTier = NUMBER_TIERS.STANDARD }) {
  const isFounding = Number(creationOrder) > 0 && Number(creationOrder) <= FOUNDING_ACCOUNT_LIMIT;
  const tier = reservationTier === NUMBER_TIERS.RESERVE
    ? NUMBER_TIERS.RESERVE
    : (isFounding ? NUMBER_TIERS.FOUNDING : NUMBER_TIERS.STANDARD);
  return { tier, isFounding };
}

async function allocateUniqueStandardNumber(claim, { generate = generateStandardNumber, maxAttempts = 100 } = {}) {
  if (typeof claim !== 'function') throw new TypeError('claim must be a function');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const privateNumber = generate();
    if (!normalizePrivateNumber(privateNumber) || privateNumber.length !== 10) continue;
    if (await claim(privateNumber)) return privateNumber;
  }
  throw new Error('Could not allocate a Vaultlix Private Number');
}

function isNumberAvailable(privateNumber, { activeNumbers, lifecycle }) {
  const number = normalizePrivateNumber(privateNumber);
  if (!number) return false;
  return !activeNumbers?.has(number) && !lifecycle?.has(number);
}

module.exports = {
  NUMBER_TIERS,
  FOUNDING_ACCOUNT_LIMIT,
  normalizePrivateNumber,
  generateStandardNumber,
  assignAccountTier,
  allocateUniqueStandardNumber,
  isNumberAvailable,
};

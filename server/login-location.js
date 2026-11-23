'use strict';

const { isIP } = require('node:net');
const geoip = require('geoip-lite');
const { detectClientKind } = require('./account-clients');

// Resolve locally. Do not persist the IP, coordinates, or user-agent string.
// This is a network estimate, never evidence of the person's physical location.
function loginLocation(ip, userAgent, lookup = geoip.lookup) {
  const address = String(ip || '').replace(/^::ffff:/i, '');
  let geo = null;
  try { if (isIP(address)) geo = lookup(address); } catch { /* Sign-in must still work. */ }
  const text = value => typeof value === 'string' ? value.slice(0, 100) : null;
  return {
    at:Date.now(), platform:detectClientKind(userAgent),
    city:text(geo?.city), region:text(geo?.region), country:text(geo?.country),
    approximate:true,
  };
}

module.exports = { loginLocation };

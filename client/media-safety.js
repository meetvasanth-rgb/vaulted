/* Native iOS and Android image checks. No network access; only approval fingerprints are persisted locally. */
(function(root) {
  'use strict';
  const enabled = /VaultlixImageSafety\/1/.test(root.navigator?.userAgent || '') || root.__vaultlixLocalImageSafety === true;
  const pending = new Map(), cache = new Map();
  // Bump this policy whenever either bundled model, preprocessing or thresholds change.
  const policy = 'nsfw-ios-android-v1';
  const storageKey = 'vaultlix:image-approvals:' + policy + ':' + (/Android/.test(root.navigator?.userAgent || '') ? 'android' : 'ios');
  const maxAge = 30 * 24 * 60 * 60 * 1000;
  let approvals = new Map(), generation = 0;
  try {
    const entries = JSON.parse(root.localStorage?.getItem(storageKey) || '[]');
    if (Array.isArray(entries)) for (const entry of entries.slice(-512)) {
      if (Array.isArray(entry) && /^[a-f0-9]{64}$/.test(entry[0]) && Number.isFinite(entry[1]) && entry[1] <= Date.now() && Date.now() - entry[1] < maxAge) approvals.set(entry[0], entry[1]);
    }
  } catch (_) {}
  function remember(key) {
    approvals.delete(key); approvals.set(key, Date.now());
    while (approvals.size > 512) approvals.delete(approvals.keys().next().value);
    try { root.localStorage?.setItem(storageKey, JSON.stringify([...approvals])); } catch (_) {}
  }
  function clear() {
    generation++; approvals.clear(); cache.clear();
    try { root.localStorage?.removeItem(storageKey); } catch (_) {}
  }
  let serial = Promise.resolve(), sequence = 0, lastFailure = null;
  function unavailable(reason) { lastFailure = reason; return 'unavailable'; }
  function failureMessage() {
    const messages = {
      'bridge-missing':'The on-device checker is not ready. Close and reopen Vaultlix, then try again.',
      'bridge-error':'The on-device checker could not start. Close and reopen Vaultlix, then try again.',
      'timeout':'The on-device check timed out. Please try again.',
      'input':'This image is too large or could not be read. Try a smaller still image.',
      'hash':'The image could not be prepared for its on-device check. Close and reopen Vaultlix, then try again.',
      'native':'The on-device checker could not read this image. Try a JPEG or PNG photo.',
    };
    return messages[lastFailure] || 'The on-device check could not finish. Please try again.';
  }
  root.addEventListener('vaultlix:image-safety-result', event => {
    const { requestId, status } = event.detail || {};
    pending.get(requestId)?.(status);
  });
  function nativeCheck(base64) {
    return new Promise(resolve => {
      const requestId = 'image-' + Date.now().toString(36) + '-' + (++sequence);
      const finish = (status, reason = 'native') => {
        clearTimeout(timer); pending.delete(requestId);
        resolve(['allowed','blocked'].includes(status) ? status : unavailable(reason));
      };
      const timer = setTimeout(() => finish('unavailable', 'timeout'), 25000);
      pending.set(requestId, finish);
      try {
        if (typeof root.VaultlixAndroid?.screenImage === 'function') {
          root.VaultlixAndroid.screenImage(requestId, base64);
          return;
        }
        const bridge = root.webkit?.messageHandlers?.vaultlixCall;
        if (!bridge) return finish('unavailable', 'bridge-missing');
        bridge.postMessage({ action:'screenImage', requestId, base64 });
      } catch (_) { finish('unavailable', 'bridge-error'); }
    });
  }
  async function check(data, { persist = true } = {}) {
    if (!enabled) return 'unsupported';
    if (typeof data !== 'string' || !data || data.length > 14 * 1024 * 1024) return unavailable('input');
    const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
    const epoch = generation;
    let key;
    try {
      const hash = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64));
      key = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
    } catch (_) { return unavailable('hash'); }
    if (epoch !== generation) return unavailable('native');
    if (persist && approvals.has(key) && Date.now() - approvals.get(key) < maxAge) return 'allowed';
    // Separate ephemeral checks so view-once media never reads/writes persistent approvals.
    const memoryKey = (persist ? 'saved:' : 'ephemeral:') + key;
    if (cache.has(memoryKey)) return cache.get(memoryKey);
    // Serialize inference to avoid frame drops and unbounded native image allocations.
    const result = serial.then(() => nativeCheck(base64));
    serial = result.catch(() => 'unavailable');
    cache.set(memoryKey, result);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    const status = await result;
    if (status === 'unavailable') cache.delete(memoryKey);
    if (status === 'allowed' && persist && generation === epoch) remember(key);
    return status;
  }
  root.VaultlixMediaSafety = { enabled, check, failureMessage, clear };
})(globalThis);

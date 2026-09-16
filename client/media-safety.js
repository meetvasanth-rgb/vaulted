/* Native iOS image checks. This module has no network or storage access. */
(function(root) {
  'use strict';
  const enabled = /VaultlixImageSafety\/1/.test(root.navigator?.userAgent || '') || root.__vaultlixLocalImageSafety === true;
  const pending = new Map(), cache = new Map();
  let serial = Promise.resolve(), sequence = 0;
  root.addEventListener('vaultlix:image-safety-result', event => {
    const { requestId, status } = event.detail || {};
    pending.get(requestId)?.(status);
  });
  function nativeCheck(base64) {
    return new Promise(resolve => {
      const requestId = 'image-' + Date.now().toString(36) + '-' + (++sequence);
      const finish = status => {
        clearTimeout(timer); pending.delete(requestId);
        resolve(['allowed','blocked'].includes(status) ? status : 'unavailable');
      };
      const timer = setTimeout(() => finish('unavailable'), 25000);
      pending.set(requestId, finish);
      try {
        const bridge = root.webkit?.messageHandlers?.vaultlixCall;
        if (!bridge) return finish('unavailable');
        bridge.postMessage({ action:'screenImage', requestId, base64 });
      } catch (_) { finish('unavailable'); }
    });
  }
  async function check(data) {
    if (!enabled) return 'unsupported';
    if (typeof data !== 'string' || !data || data.length > 14 * 1024 * 1024) return 'unavailable';
    const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
    let key;
    try {
      const hash = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64));
      key = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
    } catch (_) { return 'unavailable'; }
    if (cache.has(key)) return cache.get(key);
    // Serialize inference to avoid frame drops and unbounded native image allocations.
    const result = serial.then(() => nativeCheck(base64));
    serial = result.catch(() => 'unavailable');
    cache.set(key, result);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    const status = await result;
    if (status === 'unavailable') cache.delete(key);
    return status;
  }
  root.VaultlixMediaSafety = { enabled, check };
})(globalThis);

// Vaultlix service worker — exists solely to receive Web Push events and show
// a notification. It does NOT cache app files (this app has no offline mode;
// every session needs a live connection to relay E2E-encrypted messages), so
// there's no fetch handler here beyond letting requests pass straight through.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// The server never sees plaintext (that's the whole point of E2E encryption),
// so the push payload only ever carries generic metadata — never message
// content. Do not add anything here that would require the server to know
// what was said.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = data.title || 'Vaultlix';
  const body = data.body || 'New message';
  const tag = data.tag || 'vaultlix-message';
  const isCall = !!data.isCall;

  event.waitUntil((async () => {
    // If the room is already open and focused, the in-app chime/UI already
    // covers it — skip the system notification to avoid a duplicate ping.
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasFocusedClient = clientsList.some(c => c.focused);
    if (hasFocusedClient) return;

    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Incoming calls get treated like a ring, not a ping: stay on screen
      // until the person deals with it (default notifications on some
      // platforms auto-dismiss after a few seconds) and vibrate in a
      // phone-ringing-ish pattern rather than a single buzz.
      requireInteraction: isCall,
      vibrate: isCall ? [300, 150, 300, 150, 300, 150, 600] : undefined,
      data: { url: '/', isCall },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsList) {
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

// iOS/WebKit can silently invalidate a push subscription while the app sits
// idle in the background — unlike Android, which is backed by Google's
// always-on FCM and doesn't have this problem. That's exactly the reported
// symptom: notifications work right after subscribing, then stop once the
// room's been idle a while, Android unaffected. pushsubscriptionchange is
// the platform's hook for this: it fires when the browser/OS rotates or
// drops a subscription, giving us a chance to get a new one and tell the
// server before the old one goes fully dead. The service worker has no
// access to the page's JS variables (roomCode/myToken), so those are read
// from IndexedDB, written by the page whenever it successfully subscribes.
const VAPID_PUBLIC_KEY = 'BKd1545VKC8Tw1NB9SHbPaNGIBwKMft3oaH0USMJxrpUYEY_Mgcvn_XGL-BA6njGg-nts1z7YDsU-0txzezxfXA';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Multi-room: the page can have several rooms open at once, and the push
// subscription itself is one-per-browser (not one-per-room), so what the
// page writes here is now a LIST of {roomCode, myToken} pairs — one per open
// room — instead of a single session. Storing just one used to mean that
// whichever room subscribed last silently overwrote the others; if the
// subscription then rotated while idle, only that last room got reported to
// the server and every other open room went dark on push until the app was
// manually reopened.
function idbGetSessions() {
  return new Promise((resolve) => {
    const req = indexedDB.open('vaulted-push', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readonly');
      const getReq = tx.objectStore('kv').get('sessions');
      getReq.onsuccess = () => resolve(Array.isArray(getReq.result) ? getReq.result : []);
      getReq.onerror = () => resolve([]);
    };
    req.onerror = () => resolve([]);
  });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const sessions = await idbGetSessions();
      if (!sessions.length) return;

      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      // One new subscription, reported to the server once per open room.
      await Promise.all(sessions.map(s =>
        fetch('/api/push-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: s.roomCode, token: s.myToken, subscription: sub.toJSON() }),
        }).catch(() => {})
      ));
    } catch (e) {
      // Nothing more we can do from here — the page will re-subscribe
      // normally next time it's opened in the foreground.
    }
  })());
});

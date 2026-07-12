// Vaulted service worker — exists solely to receive Web Push events and show
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

  const title = data.title || 'Vaulted';
  const body = data.body || 'New message';
  const tag = data.tag || 'vaulted-message';

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
      data: { url: '/' },
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

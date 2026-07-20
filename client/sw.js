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
    // iOS Safari REQUIRES every push event to result in a visible
    // notification (that's what userVisibleOnly:true in the subscribe call
    // promises the platform). Skipping showNotification() here — as the
    // previous version did whenever the room was already focused, to avoid
    // a duplicate ping — counts as a "silent push". Safari tracks these,
    // and after a small number of them (observed as few as 3) it silently
    // revokes the entire push subscription with no error surfaced anywhere
    // in this app. That matches the reported symptom exactly: notifications
    // work for a while, then calls AND messages both go dark, because the
    // subscription itself is dead — not because any individual push failed.
    // So: always show it now. If the app is already open and focused, we
    // still show it (to satisfy the platform contract) but close it again a
    // moment later so it doesn't linger as a visible duplicate of the
    // in-app chime/UI.
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasFocusedClient = clientsList.some(c => c.focused);
    // Any open window (focused or not) means the page's own poll loop is
    // almost certainly still alive and will fire its own in-app chime for
    // this message via notifyMsg()/playChime() in index.html. Without this,
    // the person hears BOTH that chime AND this OS notification's own sound
    // for the same message — reported as "two notification sounds" on
    // Android. Muting this notification's sound (not its visibility — it
    // still shows, still satisfies the iOS anti-revocation contract above)
    // whenever a window is open removes the duplicate there.
    //
    // This assumption does NOT hold on iOS: Safari suspends a backgrounded
    // tab's JS almost immediately, so the in-app chime this mute is
    // deferring to never actually fires there, even though the tab still
    // counts as an open "client" to the service worker. Muting universally
    // made iOS go completely silent on every push whenever the app had ever
    // been opened and not force-quit — reported separately as "chime not
    // working for iOS notifications". So: only apply the mute on platforms
    // where the in-app chime can realistically still be alive to cover for
    // it (i.e. not iOS). Calls are exempt on every platform — a missed ring
    // is worse than a duplicate ping, and they don't go through notifyMsg's
    // chime gate at all.
    const hasAnyClient = clientsList.length > 0;
    const isIOS = /iPhone|iPad|iPod/.test(self.navigator.userAgent || '');

    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      silent: !isCall && hasAnyClient && !isIOS,
      icon: '/icons/icon-192.png',
      // Android renders the status-bar/notification-tray icon as a plain
      // alpha-mask silhouette — it ignores color entirely and only looks at
      // which pixels are opaque. icon-192.png is a fully-opaque flattened
      // PNG (solid white background, no transparency at all — see the
      // adaptive-icon fix that gave it that white background), so that
      // mask sees "the entire square is opaque" and renders a solid white
      // block instead of the lock glyph. Some OEMs (OnePlus) are lenient
      // about this and show the real icon anyway; Samsung's One UI enforces
      // the mask strictly, which is why the bug only showed up there.
      // icon-badge-192.png is a purpose-built badge asset: transparent
      // background, lock+bubble glyph (now ringed, like a coin badge) as
      // solid opaque white — exactly the shape Android's silhouette mask
      // needs to render correctly. Serving the 192px source (rather than a
      // pre-shrunk 96px one) instead of relying on Chrome to upscale a
      // smaller source keeps edges crisp at whatever size Android actually
      // renders the status-bar icon at — pixel dimensions here don't change
      // the on-screen size (Android always scales to its own fixed slot),
      // only the sharpness.
      badge: '/icons/icon-badge-192.png',
      // Incoming calls get treated like a ring, not a ping: stay on screen
      // until the person deals with it (default notifications on some
      // platforms auto-dismiss after a few seconds) and vibrate in a
      // phone-ringing-ish pattern rather than a single buzz.
      requireInteraction: isCall,
      vibrate: isCall ? [300, 150, 300, 150, 300, 150, 600] : undefined,
      // code (present on both message and call/missed-call pushes) is what
      // lets notificationclick below jump straight to the room this
      // notification is actually about, instead of whatever room the app
      // happens to open to — see notificationclick for how it's used.
      data: { url: '/', isCall, code: data.code || null },
    });

    if (hasFocusedClient) {
      const shown = await self.registration.getNotifications({ tag });
      shown.forEach(n => n.close());
    }

    // Report delivery straight from here, independent of whether the
    // page's own poll loop ever gets a chance to run — this push handler
    // fires anytime a notification is shown, including a fully backgrounded
    // or locked device where the page's JS may be throttled/suspended long
    // before that would stop happening. Only regular messages carry
    // code/msgId (call pushes don't map to a single message); the
    // recipient's own token for that room is looked up from IndexedDB the
    // same way pushsubscriptionchange below already does, since the push
    // payload itself never carries anything that could authenticate a
    // request on its own.
    if (data.code && data.msgId) {
      try {
        const sessions = await idbGetSessions();
        const session = sessions.find(s => s.roomCode === data.code);
        if (session) {
          // A device that just woke from deep sleep to handle this push may
          // not have a fully-reconnected radio yet — without a hard cap, a
          // slow/hanging fetch here would keep this whole event.waitUntil()
          // open longer than it needs to be. showNotification has already
          // resolved by this point regardless (this block runs strictly
          // after it), so a timeout here only trims this best-effort
          // follow-up call short — it can never delay the notification
          // that's already on screen.
          const ac = new AbortController();
          const timeout = setTimeout(() => ac.abort(), 4000);
          await fetch('/api/mark-delivered', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: data.code, token: session.myToken, msgId: data.msgId }),
            signal: ac.signal,
          }).finally(() => clearTimeout(timeout));
        }
      } catch (e) {
        // Best-effort — the page's own poll loop is still the fallback.
      }
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const code = (event.notification.data && event.notification.data.code) || null;
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clientsList.length > 0) {
      const c = clientsList[0];
      if ('focus' in c) await c.focus();
      // Focusing an already-open tab doesn't navigate it — this app is a
      // single-page multi-room client, so "open the right room" means
      // telling the already-running page's own JS to switch rooms, not
      // loading a different URL. The page listens for this in its own
      // 'message' handler and calls setActiveRoom() if it has that room;
      // if the room list hasn't finished restoring yet, it queues the
      // code and applies it once that finishes instead of dropping it.
      if (code && 'postMessage' in c) c.postMessage({ type: 'notification-click', code });
      return;
    }
    // No window open at all — same idea, but the page doesn't exist yet to
    // postMessage to, so the target room rides along as a URL param instead.
    // The page reads this on boot, after its own room-restore sequence
    // finishes (see the `?room=` handling in index.html).
    if (self.clients.openWindow) {
      return self.clients.openWindow(code ? `/?room=${encodeURIComponent(code)}` : '/');
    }
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
      // Close the connection once the read settles either way — every
      // message push now calls this (see the mark-delivered fetch in the
      // push handler above), so leaving connections open on every call
      // means one per message received, for as long as this service worker
      // instance stays alive. Not itself the cause of a notification
      // failing to show (showNotification is awaited well before this ever
      // runs), but unnecessary overhead on every wake worth not adding.
      getReq.onsuccess = () => { resolve(Array.isArray(getReq.result) ? getReq.result : []); db.close(); };
      getReq.onerror = () => { resolve([]); db.close(); };
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

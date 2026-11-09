// The Dispatch phone app's service worker (scope /m/). It does two things:
// shows a notification for every push the daemon sends, and opens the app on
// the right item when one is tapped. It holds no credential and makes no
// request of its own: the payload is only { kind, id, title, body }, and the
// page fetches everything else over its authenticated connection.

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data === null ? {} : event.data.json();
  } catch {
    data = {};
  }
  // Every push must show a notification (Safari revokes the subscription of
  // an app that receives pushes silently), so a malformed one still does.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Dispatch', {
      body: data.body || 'Something needs you',
      // One tag: a newer notification replaces the older one rather than
      // stacking a backlog on the lock screen.
      tag: 'dispatch',
      renotify: true,
      icon: '/m/icon-256.png',
      data: { kind: data.kind || null, id: data.id || null },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { kind, id } = event.notification.data || {};
  const url =
    kind === 'decision' && typeof id === 'string'
      ? `/m/#decision=${encodeURIComponent(id)}`
      : '/m/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (windows) => {
        const open = windows.find((w) =>
          new URL(w.url).pathname.startsWith('/m/')
        );
        if (open === undefined) {
          await self.clients.openWindow(url);
          return;
        }
        open.postMessage({ type: 'open', url });
        await open.focus();
      })
  );
});

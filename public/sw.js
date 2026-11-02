// Bump the cache version when changing the offline page or its icons.
const CACHE = 'patterm-offline-v5';
const OFFLINE_ASSETS = ['/offline.html', '/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(OFFLINE_ASSETS)));
  // Let open terminals keep their current worker until their windows close.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('patterm-offline-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // API responses, uploads, and terminal traffic always go straight to the server.
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/projects' || url.pathname.startsWith('/projects/'))) {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  } else if (OFFLINE_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((cached) => cached || fetch(request)));
  }
});

// Web Push from the Patterm server. The payload carries only what the
// notification shows and where clicking it should go.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Patterm';
  const url = sameOriginPath(data.url);
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  const bot = typeof data.bot_id === 'string' && data.bot_id ? data.bot_id : null;
  // Every push must show a notification: browsers revoke subscriptions that
  // receive silent pushes. The server already skips pushes while a client is
  // focused.
  event.waitUntil((async () => self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    icon: (bot && await botAvatar(bot)) || '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag,
    // Browsers reject renotify without a tag. Each message from a bot buzzes,
    // like a text.
    renotify: Boolean(tag) && (data.urgency === 'high' || Boolean(bot)),
    requireInteraction: data.urgency === 'high',
    data: { url, id: data.id }
  }))());
});

// The app draws each bot's face into this cache (resources/js/lib/pushAvatars).
// Notification icons can't be read through the worker, so it is passed inline.
const AVATARS = 'patterm-push-avatars';

async function botAvatar(botId) {
  try {
    const cached = await (await caches.open(AVATARS)).match(`/push-avatars/${encodeURIComponent(botId)}.png`);
    if (!cached) return null;
    const bytes = new Uint8Array(await cached.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return `data:image/png;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = sameOriginPath(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'patterm:navigate', url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// Only paths on this origin; '//host' would leave the app.
function sameOriginPath(value) {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
}

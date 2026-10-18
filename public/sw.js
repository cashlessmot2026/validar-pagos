const SHELL = 'vp-shell-v1';
const INBOX = 'share-inbox';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== INBOX).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});

// Recibe SMS / correos / pantallazos compartidos desde Android ("Compartir > Validar Pagos")
async function handleShare(request) {
  const form = await request.formData();
  const inbox = await caches.open(INBOX);
  const file = form.get('image');
  const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n');
  if (file && typeof file !== 'string') {
    await inbox.put('/shared/image', new Response(file, { headers: { 'content-type': file.type || 'image/png' } }));
  }
  if (text) await inbox.put('/shared/text', new Response(text));
  return Response.redirect('/?share=1', 303);
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('/')))
  );
});

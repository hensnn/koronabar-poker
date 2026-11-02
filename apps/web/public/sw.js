/*
 * Service worker KoronaBar Poker: push upozornění a nenáročná offline podpora.
 * Hra potřebuje živé spojení, proto se NIKDY nekešuje /api ani /socket.io. Kešuje se jen obal aplikace
 * (aby se aplikace po ztrátě sítě otevřela a ukázala srozumitelnou stránku) a statické soubory.
 */
const SHELL = 'kb-shell-v2';
const ASSETS = 'kb-assets';
const SHELL_FILES = ['/', '/offline.html', '/icon.svg', '/icon-192.png'];
const ASSET_LIMIT = 150;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => undefined));
});

// Nová verze čeká, dokud ji stránka nevyzve (tlačítko „Obnovit“): rozehraná hra se nepřepne na nový kód bez vědomí hráče.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Soubory s otiskem v názvu (ASSETS) zůstávají i po aktualizaci, aby se starší otevřená stránka nerozbila.
      for (const key of await caches.keys()) if (key !== SHELL && key !== ASSETS) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - ASSET_LIMIT))) await cache.delete(k);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Živá data a spojení nikdy ze sítě nevynechávat.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  // Vývojový server (Vite): zdrojové moduly a interní adresy se nikdy nekešují, jinak se po změně kódu načte zastaralý soubor.
  if (url.pathname.startsWith('/src/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/node_modules/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Zápis do keše běží až po odeslání odpovědi; waitUntil ho nenechá přerušit ukončením workeru.
          if (res.ok && url.pathname === '/') event.waitUntil(caches.open(SHELL).then((c) => c.put('/', res.clone())));
          return res;
        })
        .catch(async () => (await caches.match('/')) || (await caches.match('/offline.html')) || Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) event.waitUntil(cache.put(req, res.clone()).then(() => trim(cache)));
        return res;
      }),
    );
    return;
  }

  // Ikony a další statické soubory: rychle z keše a na pozadí obnovit.
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res.ok) event.waitUntil(cache.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'KoronaBar Poker', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'KoronaBar Poker', {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  const target = new URL(url);
  const samePage = (c) => {
    const u = new URL(c.url);
    return u.pathname === target.pathname && u.search === target.search;
  };
  // Rozehraný stůl ani TV obrazovku upozornění nikdy neodvede jinam.
  const busy = (c) => /^\/(stul\/|tv$)/.test(new URL(c.url).pathname);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const ours = list.filter((c) => new URL(c.url).origin === self.location.origin && 'focus' in c);
      // Okno, které už je na cílové adrese, stačí zaměřit.
      const same = ours.find(samePage);
      if (same) return same.focus();
      const free = ours.find((c) => !busy(c) && 'navigate' in c);
      if (free) return free.focus().then(() => free.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', () => { self.clients.claim(); });
self.addEventListener('fetch', () => {
  // De momento no cachea nada: deja pasar todas las peticiones tal cual.
});

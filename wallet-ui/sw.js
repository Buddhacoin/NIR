const CACHE="nir-wallet-shell-v33";
const ASSETS=["./","./index.html","./style.css?v=31","./app.js?v=31","./address-book.js","./qr.js","./transaction-decoder.js","./offline-signing.js","./node-selection.js","./nodes.json","./nir-coin-icon.png?v=24","./manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request))));

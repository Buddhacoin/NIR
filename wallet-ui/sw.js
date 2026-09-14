const CACHE="nir-wallet-shell-v11";
const ASSETS=["./","./index.html","./style.css?v=11","./app.js?v=11","./nir-coin-icon.svg?v=11","./manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener("fetch",event=>event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request))));

const CACHE="nir-wallet-shell-v2";
const ASSETS=["./","./index.html","./style.css?v=2","./app.js?v=2","./icon.svg","./nir-brand.png","./nir-coin-icon.png","./manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener("fetch",event=>event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request))));

const CACHE="nir-wallet-shell-v23";
const ASSETS=["./","./index.html","./style.css?v=22","./app.js?v=23","./node-selection.js","./nodes.json","./nir-coin-icon.png?v=22","./manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener("fetch",event=>event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request))));

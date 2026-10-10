const CACHE="nir-wallet-shell-v43";
const ASSETS=["./","./index.html","./style.css?v=33","./app.js?v=41","./i18n.js","./address-book.js","./qr.js","./transaction-decoder.js","./submission-status.js","./offline-signing.js","./node-selection.js","./nir-coin-icon.png?v=24","./manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{
  if(new URL(event.request.url).pathname.endsWith("/nodes.json")){
    event.respondWith(fetch(event.request,{cache:"no-store"}));return;
  }
  event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request)));
});

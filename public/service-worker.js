const CACHE = "asmrgay-index-viewer-v3";
const ASSETS = ["./", "./index.html", "./app.js", "./styles.css", "./manifest.json", "./icon.svg"];
self.addEventListener("install", (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (event) => { if (event.request.method !== "GET" || new URL(event.request.url).pathname.endsWith("/service-worker.js")) return; event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request))); });

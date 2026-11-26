const scope = self.registration.scope;
const prefix = "planner-shell:" + scope + ":";
const version = prefix + "12";
const files = [
  "index.html", "style.css", "app.js", "model.mjs", "store.mjs", "pairing.mjs", "icons.svg", "icon.svg", "manifest.webmanifest",
  "icon-192.png", "icon-512.png"
].map(file => new URL(file, scope).href);
const entry = files[0];
const assets = new Set(files);

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(version);
    await cache.addAll(files.map(file=>new Request(file,{cache:"reload"})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(prefix) && k !== version).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  url.hash = "";
  url.search = "";
  const isHome = req.mode === "navigate" && (url.href === scope || url.href === entry);
  if (!isHome && !assets.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(version);
    const key = isHome ? entry : url.href;
    try {
      const response = await fetch(req,{cache:"no-cache"});
      if (response.ok && !response.redirected) {
        try { await cache.put(key, response.clone()); } catch { /* Storage can be full. */ }
      }
      return response.status >= 500 ? (await cache.match(key)) || response : response;
    } catch {
      return (await cache.match(key)) || Response.error();
    }
  })());
});

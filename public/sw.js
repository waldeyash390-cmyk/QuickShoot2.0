// sw.js — makes Quickshoot load instantly on repeat visits and survive flaky networks.
// Strategy: app shell = stale-while-revalidate (instant, updates in background).
// Never touches the WebSocket, TURN credentials or health endpoints.
const VERSION = "qs-v3";
const SHELL = [
  "./", "index.html", "css/style.css",
  "js/app.js", "js/signaling.js", "js/webrtc.js", "js/crypto.js", "js/filetransfer.js",
  "icon.svg", "1111.mp4"
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  if (sameOrigin && /^\/(ws|turn-credentials|healthz)/.test(url.pathname)) return;
  if (!sameOrigin && !CDN.test(req.url)) return;

  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: sameOrigin });
      const network = fetch(req)
        .then((res) => { if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      // CDN libraries never change (pinned versions) -> cache first.
      if (cached && !sameOrigin) return cached;
      return cached || network;
    })
  );
});

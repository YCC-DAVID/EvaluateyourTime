// 手机聊天页的离线外壳：Mac 没开或不在同一个 WiFi 时，主屏幕上的图标照样能打开，消息先存在手机上。
// 只缓存页面和静态资源；接口（/api/）一律不缓存。
const CACHE = "tm-mobile-v4";

/** 取页面，顺带把它引用的静态资源一起缓存 */
async function refreshShell() {
  const res = await fetch("/m/", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  const html = await res.clone().text();
  const cache = await caches.open(CACHE);
  await cache.put("/m/", res);
  const assets = [...new Set(html.match(/\/(?:assets|m)\/[^"'\s)]+\.(?:js|css|png|json)/g) ?? [])];
  await Promise.all(assets.map((a) => cache.add(a).catch(() => {})));
}

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(refreshShell().catch(() => {}));
});
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))) // 删掉旧版本的缓存
      .then(() => self.clients.claim()),
  ),
);

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate") {
    // 先试网络（最多等 3 秒），连不上就用缓存的页面
    e.respondWith(
      Promise.race([fetch(e.request), timeout(3000)])
        .then((r) => {
          if (r.ok) refreshShell().catch(() => {});
          return r;
        })
        .catch(async () => (await caches.match("/m/")) || Response.error()),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/m/")) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((r) => {
            if (r.ok) {
              const copy = r.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return r;
          }),
      ),
    );
  }
});

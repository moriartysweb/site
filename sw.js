// The reader offline: everything it needs is fetched on install, then served from here.
// web/site.py fills in the three constants; a new build changes CACHE, which is what
// makes the browser take the new files and drop the old ones.
const PREFIX = "sherlock-";
const CACHE = PREFIX + "8d29a91ff516";
const FILES = ["./", "index.html", "pages.json", "notes-extra.json", "notes-more.json", "sherlock-180.png", "sherlock-192.png", "sherlock-512.png", "sherlock.svg", "manifest.webmanifest"];
const FONTS = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=EB+Garamond:ital,wght@0,400;0,500;1,400&family=Barlow+Condensed:wght@500;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Lora:ital,wght@0,400;1,400&family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&family=Pinyon+Script&display=swap";

// Google answers the font stylesheet in every script it knows; the readers set only Latin.
const LATIN = /\/\* latin(-ext)? \*\/\s*@font-face\s*{[^}]*}/g;

async function fonts(cache) {
  const css = await (await fetch(FONTS, {mode: "cors"})).text();
  const kept = (css.match(LATIN) || []).join("\n");
  // A variable face serves several weights from one file, and addAll refuses duplicates.
  const urls = new Set([...kept.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]));
  await cache.put(FONTS, new Response(kept, {headers: {"Content-Type": "text/css"}}));
  await cache.addAll([...urls].map(url => new Request(url, {mode: "cors"})));
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES);
    // Without the faces the reader still works, set in its fallbacks.
    await fonts(cache).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // Only this reader's caches: the other reader's worker shares the origin.
    for (const name of await caches.keys())
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request, {ignoreSearch: true, ignoreVary: true});
    return hit || fetch(event.request);
  })());
});

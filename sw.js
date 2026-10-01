// Service worker：让这一盘离线可开、可装到桌面。
//
// 两条规则是刻意的：
// 1) 缓存名带版本号，activate 时把不属于当前版本的旧缓存整批删掉。手工版本号 + cache-first 会把
//    js/css 永久钉死在旧版，出新 HTML 配旧 JS，玩家看到的是"改了但没改"的鬼状态。
// 2) 同源子资源一律**网络优先、失败退缓存**（含 js/css/图）。导航请求同理，只有断网时才回落到
//    缓存里的 index.html。这样每次部署玩家第一跳就是新版，离线时才用上一版缓存兜底。

const VERSION = 'kuromasu-v1.1.1';
const RUNTIME = `${VERSION}-runtime`;
const CORE = [
  './',
  './index.html',
  './css/game.css',
  './js/main.js',
  './js/theme.js',
  './js/store.js',
  './js/audio/synth.js',
  './js/engine/kuromasu.js',
  './js/engine/generate.js',
  './js/engine/count.js',
  './js/render/board.js',
  './js/render/anim.js',
  './js/ui/game.js',
  './manifest.webmanifest',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/textures/paper-grain.png',
  './assets/textures/ink-grain.png',
  './assets/sprites/amber-burst.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(RUNTIME)
      .then((cache) => Promise.all(CORE.map((rel) => cache.add(new Request(rel, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 网络优先：拿到就顺手更新缓存；拿不到（离线/断网/5xx 之后 fetch 本身 reject）才退缓存。
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  let response = null;
  try {
    response = await fetch(request);
    if (response && response.ok && request.method === 'GET') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // 跨域一概不接管：这一盘除了同源文件什么都不加载，接管别人的响应只会把别人的缓存问题变成我的。
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

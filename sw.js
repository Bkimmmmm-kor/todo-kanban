// 항상 서버에 최신 파일이 있는지 확인하고, 오프라인일 때만 캐시를 씁니다.
// 앱을 수정해서 올릴 때마다 VERSION을 올려 주세요(폰이 새 버전을 바로 받음).
const VERSION = 'v5';
const CACHE = `kanban-${VERSION}`;
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
// 버전이 고정된 외부 라이브러리 (내용이 바뀌지 않으므로 캐시 우선)
const CDN = 'https://cdn.jsdelivr.net/npm/';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;

  if (url.startsWith(CDN)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }))
    );
    return;
  }

  // 앱 파일만 처리 (Supabase 서버 요청은 건드리지 않음)
  if (!url.startsWith(self.location.origin)) return;

  // 네트워크 우선(브라우저 HTTP 캐시 무시), 오프라인이면 캐시 사용
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

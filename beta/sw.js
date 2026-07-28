/*
 * Service Worker «Солнечного компаса».
 *
 * Стратегия:
 *   - навигация и index.html — network-first: свежая версия важнее, кэш только как
 *     подстраховка в офлайне (иначе установленное PWA залипло бы на старой сборке);
 *   - остальная статика — cache-first: иконки и манифест меняются редко.
 *
 * CACHE_NAME обязан совпадать с APP_VERSION в index.html: смена версии
 * автоматически выбрасывает старый кэш в activate.
 */
const CACHE_NAME = 'sun-compass-beta-v2.0.4';

const PRECACHE = [
    './',
    './index.html',
    './manifest.json',
    './icon.svg',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            // addAll падает целиком, если хоть один файл недоступен, — кладём по одному
            .then((cache) => Promise.all(
                PRECACHE.map((url) => cache.add(url).catch(() => null))
            ))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Чужие домены (геокодер photon.komoot.io) не кэшируем и не перехватываем:
    // название города должно приходить живым либо не приходить вовсе.
    if (url.origin !== self.location.origin) return;

    const isDocument = request.mode === 'navigate' || url.pathname.endsWith('/index.html');

    if (isDocument) {
        // Документ всегда кладём под один канонический ключ: иначе каждый заход
        // с новым `?v=...` плодил бы отдельную копию index.html в кэше.
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
                    return response;
                })
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((hit) => hit || fetch(request).then((response) => {
            if (response && response.status === 200 && response.type === 'basic') {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
        }))
    );
});

// Service Worker（network-first）
// オンライン時は最新を取りに行ってキャッシュを更新し、オフライン時やタイムアウト時はキャッシュを返す
// アプリのファイルを変えたら CACHE_NAME の番号を上げる（tools/merge_shared.py は自動で上げる）
// 理由: sw.js が1バイトも変わらないと新しい Service Worker が入らず、古いキャッシュが残り続けるため
const CACHE_NAME = "ap-qa-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./chapters.js",
  "./questions-shared.js",
  "./core.js",
  "./app.js",
  "./manifest.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];
// 電波が弱いときに待たされ続けないよう、この時間でキャッシュに切り替える
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  // cache: "reload" で HTTP キャッシュを通さず取得する（GitHub Pages は max-age=600 のため）
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" }))))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
});

function fetchWithTimeout(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS);
    fetch(url, { cache: "no-cache" }).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    // 外部への通信や GET 以外は扱わない（ブラウザに任せる）
    return;
  }
  event.respondWith(
    fetchWithTimeout(req.url)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {
            // キャッシュに書けなくても表示には影響しないため続行
          });
        } else {
          // 404 などはキャッシュしない
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => {
          if (hit) {
            return hit;
          } else if (req.mode === "navigate") {
            return caches.match("./index.html");
          } else {
            return Response.error();
          }
        })
      )
  );
});

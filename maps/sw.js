/* Service worker: offline app shell, data cache, and a local tile server.
 *   tiles/{basemap|terrain}/{z}/{x}/{y}  -> downloaded archive in IndexedDB, else the live archive online, else 204
 *   data/*                               -> cache first (filled by the offline download)
 *   everything else                      -> app shell cache first, network fallback
 */
const BUILD = 'e8f400d89602'; // replaced by tools/build-precache.mjs
const SHELL = `shell-${BUILD}`;
const DATA = 'data-v1';
importScripts('vendor/pmtiles.js', 'js/db-core.js');

const REMOTE = {
  basemap: 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles',
  terrain: 'https://download.mapterhorn.com/planet.pmtiles',
};
const TYPES = { basemap: 'application/x-protobuf', terrain: 'image/webp' };
const SCOPE = new URL(self.registration.scope).pathname;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const res = await fetch('precache.json', { cache: 'no-store' });
    const { files } = await res.json();
    const cache = await caches.open(SHELL);
    await cache.addAll(files);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'archives-changed') { local = {}; event.ports[0]?.postMessage('ok'); }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return;
  const rel = url.pathname.slice(SCOPE.length);
  const tile = /^tiles\/(basemap|terrain)\/(\d+)\/(\d+)\/(\d+)/.exec(rel);
  if (tile) { event.respondWith(serveTile(tile[1], +tile[2], +tile[3], +tile[4])); return; }
  if (rel.startsWith('data/')) { event.respondWith(dataFirst(req)); return; }
  if (rel.startsWith('assets/fonts/')) { event.respondWith(glyphs(req)); return; }
  event.respondWith(shellFirst(req, rel));
});

/* ---------- caches ---------- */
async function shellFirst(req, rel) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch (err) {
    if (req.mode === 'navigate' || rel === '' || rel.endsWith('.html')) {
      const index = await caches.match('index.html');
      if (index) return index;
    }
    throw err;
  }
}

async function dataFirst(req) {
  const cache = await caches.open(DATA);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function glyphs(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) return res;
  } catch { /* offline */ }
  // ranges we don't ship (scripts not used in Oman): an empty glyph set keeps the map quiet
  return new Response(new Uint8Array(0), { headers: { 'Content-Type': 'application/x-protobuf' } });
}

/* ---------- tiles ---------- */
class BlobSource {
  constructor(key, blobs, starts) { this.key = key; this.blobs = blobs; this.starts = starts; }
  getKey() { return this.key; }
  async getBytes(offset, length) {
    const { starts, blobs } = this;
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    const parts = [];
    let pos = offset;
    const end = offset + length;
    for (let i = lo; pos < end && i < blobs.length; i++) {
      const a = pos - starts[i], b = Math.min(blobs[i].size, end - starts[i]);
      if (b > a) parts.push(blobs[i].slice(a, b));
      pos = starts[i] + b;
      if (b < blobs[i].size) break;
    }
    return { data: await new Blob(parts).arrayBuffer() };
  }
}

let local = {};
function localArchive(id) {
  if (!(id in local)) {
    local[id] = (async () => {
      const rec = await self.OmanDB.get('archives', id);
      if (!rec || rec.status !== 'complete') return null;
      const blobs = await self.OmanDB.chunks(id);
      if (blobs.length !== rec.chunkCount) return null;
      const archive = new pmtiles.PMTiles(new BlobSource(`idb:${id}:${rec.created}`, blobs, rec.chunkStarts));
      return { archive, header: await archive.getHeader() };
    })().catch(() => null);
  }
  return local[id];
}
const remote = {};

async function serveTile(id, z, x, y) {
  const headers = { 'Content-Type': TYPES[id], 'Cache-Control': 'no-store' };
  try {
    const loc = await localArchive(id);
    if (loc && z >= loc.header.minZoom && z <= loc.header.maxZoom) {
      const t = await loc.archive.getZxy(z, x, y);
      if (t && t.data.byteLength) return new Response(t.data, { headers });
    }
  } catch { /* fall back to the network */ }
  try {
    remote[id] ||= new pmtiles.PMTiles(REMOTE[id]);
    const t = await remote[id].getZxy(z, x, y);
    if (t && t.data.byteLength) return new Response(t.data, { headers });
  } catch { /* offline or outside coverage */ }
  return new Response(null, { status: 204, headers });
}

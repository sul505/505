// Offline region manager: downloads the Oman map, terrain and data files into browser storage.
import './db-core.js';
import { RangeSource, planExtract, runExtract, chunkStarts, parseHeader } from './extract.js';

const DB = self.OmanDB;
export const DATA_CACHE = 'data-v1';
export const DATA_FILES = ['data/manifest.json', 'data/oman-roads.bin.gz', 'data/oman-places.json', 'data/oman-cameras.json',
  'data/oman-admin.json', 'data/oman-boundary.json', 'data/oman-tides.json'];

export const ARCHIVES = {
  basemap: { url: 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles', maxZoom: 15, worldMaxZoom: 4, padKm: 15, label: 'الخريطة التفصيلية', approxMB: 89 },
  terrain: { url: 'https://download.mapterhorn.com/planet.pmtiles', maxZoom: 12, worldMaxZoom: -1, padKm: 10, label: 'التضاريس والارتفاعات', approxMB: { 10: 51, 11: 113, 12: 371 } },
};

const notifySW = async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sw = reg?.active;
  if (!sw) return;
  await new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    sw.postMessage({ type: 'archives-changed' }, [ch.port2]);
    setTimeout(resolve, 1000);
  });
};

export async function status() {
  const [basemap, terrain] = await Promise.all([DB.get('archives', 'basemap'), DB.get('archives', 'terrain')]);
  let dataCached = 0;
  try {
    const cache = await caches.open(DATA_CACHE);
    for (const f of DATA_FILES) if (await cache.match(f)) dataCached++;
  } catch { /* cache storage unavailable */ }
  let storage = null, persisted = false;
  try { storage = await navigator.storage?.estimate(); persisted = await navigator.storage?.persisted(); } catch { /* ignore */ }
  return { basemap, terrain, data: { cached: dataCached, total: DATA_FILES.length }, storage, persisted };
}

async function boundary() {
  const res = await fetch('data/oman-boundary.json');
  const gj = await res.json();
  return gj.geometry.coordinates.map(p => p[0]);
}

export async function downloadData({ onProgress, force = false } = {}) {
  const cache = await caches.open(DATA_CACHE);
  let i = 0;
  for (const f of DATA_FILES) {
    if (force || !(await cache.match(f))) {
      const res = await fetch(f, { cache: 'reload' });
      if (!res.ok) throw new Error(`تعذّر تنزيل ${f}`);
      await cache.put(f, res);
    }
    onProgress?.(++i / DATA_FILES.length);
  }
}

/**
 * Download (or resume) one archive. maxZoom overrides the default (terrain quality).
 * onProgress({phase, done, total}); resolves with the stored record.
 */
export async function downloadArchive(id, { maxZoom, onProgress, signal } = {}) {
  const spec = ARCHIVES[id];
  const params = { maxZoom: maxZoom ?? spec.maxZoom, worldMaxZoom: spec.worldMaxZoom, padKm: spec.padKm };
  const polygons = await boundary();
  for (let attempt = 0; attempt < 2; attempt++) {
    const source = new RangeSource(spec.url);
    onProgress?.({ phase: 'plan', done: 0, total: 1 });
    const plan = await planExtract(source, { polygons, ...params, signal, onStatus: s => onProgress?.({ phase: 'plan', ...s }) });
    const old = await DB.get('archives', id);
    const same = old && old.status === 'partial' && old.etag === plan.etag && old.chunkCount === plan.batches.length + 1
      && old.params?.maxZoom === params.maxZoom;
    if (!same) {
      await DB.deleteArchive(id);
      await notifySW();
    }
    const rec = {
      id, status: 'partial', srcUrl: spec.url, etag: plan.etag, params, created: Date.now(),
      chunkStarts: chunkStarts(plan), chunkCount: plan.batches.length + 1, bytes: plan.stats.bytes, stats: plan.stats,
      header: { minZoom: plan.header.minZoom, maxZoom: plan.header.maxZoom, bounds: [plan.header.minLon, plan.header.minLat, plan.header.maxLon, plan.header.maxLat] },
    };
    if (!same) await DB.put('archives', rec);
    const have = new Set(same ? await DB.chunkIndexes(id) : []);
    try {
      await runExtract(source, plan, {
        signal,
        has: async i => have.has(i),
        write: async (i, bytes) => { await DB.putChunk(id, i, new Blob([bytes])); have.add(i); },
        onProgress: p => onProgress?.({ phase: 'tiles', ...p }),
      });
    } catch (err) {
      if (err.code === 'ETAG' && attempt === 0) { await DB.deleteArchive(id); continue; } // archive republished mid-download
      throw err;
    }
    const final = { ...(same ? old : rec), status: 'complete', completed: Date.now() };
    await DB.put('archives', final);
    await notifySW();
    return final;
  }
  throw new Error('download failed');
}

export async function removeArchive(id) {
  await DB.deleteArchive(id);
  await notifySW();
}

export async function removeAll() {
  await removeArchive('basemap');
  await removeArchive('terrain');
  await caches.delete(DATA_CACHE);
}

/** The stored archive as a single standard .pmtiles Blob (usable in other apps). */
export async function exportArchive(id) {
  const rec = await DB.get('archives', id);
  if (!rec || rec.status !== 'complete') throw new Error('not downloaded');
  const blobs = await DB.chunks(id);
  return new Blob(blobs, { type: 'application/vnd.pmtiles' });
}

/** Import a .pmtiles file (e.g. made with `pmtiles extract`) as the basemap or terrain archive. */
export async function importArchive(file, { onProgress } = {}) {
  const head = new Uint8Array(await file.slice(0, 127).arrayBuffer());
  const h = parseHeader(head);
  const id = h.tileType === 1 ? 'basemap' : (h.tileType === 4 || h.tileType === 2) ? 'terrain' : null;
  if (!id) throw new Error('نوع الملف غير مدعوم');
  await DB.deleteArchive(id);
  const CHUNK = 8 * 1024 * 1024;
  const starts = [];
  for (let o = 0, i = 0; o < file.size; o += CHUNK, i++) {
    starts.push(o);
    await DB.putChunk(id, i, file.slice(o, Math.min(file.size, o + CHUNK)));
    onProgress?.(Math.min(1, (o + CHUNK) / file.size));
  }
  const rec = {
    id, status: 'complete', srcUrl: `file:${file.name}`, created: Date.now(), completed: Date.now(), imported: true,
    chunkStarts: starts, chunkCount: starts.length, bytes: file.size, params: { maxZoom: h.maxZoom },
    header: { minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat] },
  };
  await DB.put('archives', rec);
  await notifySW();
  return rec;
}

export async function requestPersist() {
  try { return await navigator.storage?.persist(); } catch { return false; }
}

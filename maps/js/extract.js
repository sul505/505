// Region extractor for PMTiles v3 archives: downloads only the tiles covering a polygon from a
// remote (HTTP range) archive and lays them out as a new, standalone PMTiles archive written in
// chunks, so a download can be resumed and stored in IndexedDB.
// Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
// Works in browsers and in Node 18+ (fetch + DecompressionStream).

const MAX_BATCH_BYTES = 6 * 1024 * 1024; // one stored chunk per batch
const MAX_GAP_BYTES = 1024 * 1024; // never download more than this between two wanted tiles
const LEAF_GAP_BYTES = 128 * 1024;
const DEFAULT_OVERFETCH = 0.05;

/* ---------- tile ids (Hilbert order) ---------- */
const tzValues = [0];
for (let z = 1; z <= 27; z++) tzValues.push(tzValues[z - 1] + 4 ** (z - 1));

export function zxyToTileId(z, x, y) {
  const n = 2 ** z;
  let rx, ry, d = 0, tx = x, ty = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    rx = (tx & s) > 0 ? 1 : 0;
    ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      const t = tx; tx = ty; ty = t;
    }
  }
  return tzValues[z] + d;
}

/* ---------- binary helpers ---------- */
function readVarint(p) {
  const b = p.buf;
  let byte = b[p.pos++], val = byte & 0x7f;
  if (byte < 0x80) return val;
  let mul = 128;
  do { byte = b[p.pos++]; val += (byte & 0x7f) * mul; mul *= 128; } while (byte >= 0x80);
  return val;
}
function writeVarint(out, v) {
  while (v >= 0x80) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}
const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;
function setU64(dv, o, v) { dv.setUint32(o, v % 2 ** 32, true); dv.setUint32(o + 4, Math.floor(v / 2 ** 32), true); }

export function parseHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 7)) !== 'PMTiles' || bytes[7] !== 3) throw new Error('not a PMTiles v3 archive');
  return {
    rootDirectoryOffset: u64(dv, 8), rootDirectoryLength: u64(dv, 16),
    jsonMetadataOffset: u64(dv, 24), jsonMetadataLength: u64(dv, 32),
    leafDirectoryOffset: u64(dv, 40), leafDirectoryLength: u64(dv, 48),
    tileDataOffset: u64(dv, 56), tileDataLength: u64(dv, 64),
    numAddressedTiles: u64(dv, 72), numTileEntries: u64(dv, 80), numTileContents: u64(dv, 88),
    clustered: bytes[96] === 1, internalCompression: bytes[97], tileCompression: bytes[98], tileType: bytes[99],
    minZoom: bytes[100], maxZoom: bytes[101],
    minLon: dv.getInt32(102, true) / 1e7, minLat: dv.getInt32(106, true) / 1e7,
    maxLon: dv.getInt32(110, true) / 1e7, maxLat: dv.getInt32(114, true) / 1e7,
    centerZoom: bytes[118], centerLon: dv.getInt32(119, true) / 1e7, centerLat: dv.getInt32(123, true) / 1e7,
  };
}

function serializeHeader(h) {
  const b = new Uint8Array(127);
  const dv = new DataView(b.buffer);
  b.set([80, 77, 84, 105, 108, 101, 115, 3]); // "PMTiles" v3
  [h.rootDirectoryOffset, h.rootDirectoryLength, h.jsonMetadataOffset, h.jsonMetadataLength, h.leafDirectoryOffset,
    h.leafDirectoryLength, h.tileDataOffset, h.tileDataLength, h.numAddressedTiles, h.numTileEntries, h.numTileContents]
    .forEach((v, i) => setU64(dv, 8 + i * 8, v));
  b[96] = h.clustered ? 1 : 0; b[97] = h.internalCompression; b[98] = h.tileCompression; b[99] = h.tileType;
  b[100] = h.minZoom; b[101] = h.maxZoom;
  dv.setInt32(102, Math.round(h.minLon * 1e7), true); dv.setInt32(106, Math.round(h.minLat * 1e7), true);
  dv.setInt32(110, Math.round(h.maxLon * 1e7), true); dv.setInt32(114, Math.round(h.maxLat * 1e7), true);
  b[118] = h.centerZoom; dv.setInt32(119, Math.round(h.centerLon * 1e7), true); dv.setInt32(123, Math.round(h.centerLat * 1e7), true);
  return b;
}

export function parseDirectory(bytes) {
  const p = { buf: bytes, pos: 0 };
  const n = readVarint(p);
  const tileId = new Float64Array(n), runLength = new Float64Array(n), length = new Float64Array(n), offset = new Float64Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last += readVarint(p); tileId[i] = last; }
  for (let i = 0; i < n; i++) runLength[i] = readVarint(p);
  for (let i = 0; i < n; i++) length[i] = readVarint(p);
  for (let i = 0; i < n; i++) {
    const v = readVarint(p);
    offset[i] = v === 0 && i > 0 ? offset[i - 1] + length[i - 1] : v - 1;
  }
  return { n, tileId, runLength, length, offset };
}

function serializeDirectory(e, from, to) {
  const out = [];
  writeVarint(out, to - from);
  let last = 0;
  for (let i = from; i < to; i++) { writeVarint(out, e.tileId[i] - last); last = e.tileId[i]; }
  for (let i = from; i < to; i++) writeVarint(out, e.runLength[i]);
  for (let i = from; i < to; i++) writeVarint(out, e.length[i]);
  for (let i = from; i < to; i++) {
    if (i > from && e.offset[i] === e.offset[i - 1] + e.length[i - 1]) writeVarint(out, 0);
    else writeVarint(out, e.offset[i] + 1);
  }
  return Uint8Array.from(out);
}

export async function decompress(bytes, compression) {
  if (compression === 0 || compression === 1) return bytes;
  if (compression !== 2) throw new Error(`unsupported compression ${compression}`);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------- region -> tiles ---------- */
const mercX = (lon, n) => ((lon + 180) / 360) * n;
const mercY = (lat, n) => {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
};

/**
 * Tile rows covering a set of polygons at zoom z, dilated by `padKm`.
 * polygons: array of rings ([lon, lat] pairs). Returns Map(row -> [[x0, x1], ...]) inclusive.
 */
export function regionRows(polygons, z, padKm = 0) {
  const n = 2 ** z;
  const rings = polygons.map(r => r.map(([lon, lat]) => [mercX(lon, n), mercY(lat, n)]));
  const rows = new Map();
  const mark = (y, x0, x1) => {
    if (y < 0 || y >= n) return;
    x0 = Math.max(0, x0); x1 = Math.min(n - 1, x1);
    if (x1 < x0) return;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push([x0, x1]);
  };
  let minY = Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [, y] of ring) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  // interiors: scanline through tile-row centres
  for (let row = Math.floor(minY); row <= Math.floor(maxY); row++) {
    const yc = row + 0.5, xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[j], [x2, y2] = ring[i];
        if ((y1 > yc) !== (y2 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) mark(row, Math.ceil(xs[k] - 0.5), Math.floor(xs[k + 1] - 0.5));
  }
  // boundaries: every tile an edge passes through
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 4));
      for (let s = 0; s <= steps; s++) {
        const x = Math.floor(x1 + ((x2 - x1) * s) / steps), y = Math.floor(y1 + ((y2 - y1) * s) / steps);
        mark(y, x, x);
      }
    }
  }
  // dilation by padKm (tile size at the region's latitude)
  const latMid = polygons[0]?.length ? polygons.flat().reduce((s, p) => s + p[1], 0) / polygons.flat().length : 0;
  const tileKm = (40075 * Math.cos((latMid * Math.PI) / 180)) / n;
  const pad = Math.ceil(padKm / tileKm);
  const merged = new Map();
  for (const [y, ivs] of rows) {
    for (let dy = -pad; dy <= pad; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= n) continue;
      if (!merged.has(yy)) merged.set(yy, []);
      for (const [a, b] of ivs) merged.get(yy).push([Math.max(0, a - pad), Math.min(n - 1, b + pad)]);
    }
  }
  for (const [y, ivs] of merged) {
    ivs.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const iv of ivs) {
      const last = out[out.length - 1];
      if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
      else out.push([iv[0], iv[1]]);
    }
    merged.set(y, out);
  }
  return merged;
}

/** Sorted tile ids for the region. world: zoom levels <= world are taken whole. */
export function regionTileIds(polygons, minZoom, maxZoom, { padKm = 0, worldMaxZoom = -1 } = {}) {
  const ids = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z;
    if (z <= worldMaxZoom) {
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) ids.push(zxyToTileId(z, x, y));
      continue;
    }
    for (const [y, ivs] of regionRows(polygons, z, padKm)) for (const [a, b] of ivs) for (let x = a; x <= b; x++) ids.push(zxyToTileId(z, x, y));
  }
  const arr = Float64Array.from(ids);
  arr.sort();
  return arr;
}

/* ---------- remote access ---------- */
export class RangeSource {
  constructor(url, { fetchImpl } = {}) {
    this.url = url;
    // browsers reject fetch called as a method of another object ("Illegal invocation")
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.etag = null;
  }
  async get(offset, length, signal) {
    if (length <= 0) return new Uint8Array(0);
    const res = await this.fetchImpl(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal, cache: 'no-store' });
    if (res.status !== 206) {
      // a server that ignores Range would send the whole (huge) archive: stop reading at once
      res.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${res.status} for range ${offset}+${length}`);
    }
    const etag = res.headers.get('etag');
    if (etag) {
      if (this.etag && etag !== this.etag) { const e = new Error('remote archive changed'); e.code = 'ETAG'; throw e; }
      this.etag ||= etag;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > length ? buf.subarray(0, length) : buf;
  }
}

/* ---------- planning ---------- */
/**
 * Work out which tiles to copy and the full layout of the output archive.
 * Returns a plan whose `chunk0` (header + directories + metadata) is final and whose `batches`
 * describe the tile-data ranges to download, in order.
 */
export async function planExtract(source, { polygons, minZoom = 0, maxZoom, padKm = 10, worldMaxZoom = -1, overfetch = DEFAULT_OVERFETCH, signal, onStatus } = {}) {
  const head = await source.get(0, 16384, signal);
  const header = parseHeader(head);
  if (header.internalCompression !== 1 && header.internalCompression !== 2) throw new Error('unsupported directory compression');
  maxZoom = Math.min(maxZoom ?? header.maxZoom, header.maxZoom);
  minZoom = Math.max(minZoom, header.minZoom);
  const rootBytes = head.subarray(header.rootDirectoryOffset, header.rootDirectoryOffset + header.rootDirectoryLength);
  const root = parseDirectory(await decompress(rootBytes, header.internalCompression));
  const targets = regionTileIds(polygons, minZoom, maxZoom, { padKm, worldMaxZoom });
  onStatus?.({ phase: 'directories', targets: targets.length });

  const foundId = [], foundOff = [], foundLen = [];
  // sweep one directory against targets[lo, hi); returns leaf requests
  const sweep = (dir, lo, hi, endId) => {
    const leaves = [];
    let j = lo;
    for (let i = 0; i < dir.n && j < hi; i++) {
      const start = dir.tileId[i];
      while (j < hi && targets[j] < start) j++;
      if (dir.runLength[i] > 0) {
        const end = start + dir.runLength[i];
        while (j < hi && targets[j] < end) {
          foundId.push(targets[j]); foundOff.push(dir.offset[i]); foundLen.push(dir.length[i]); j++;
        }
      } else {
        const end = i + 1 < dir.n ? dir.tileId[i + 1] : endId;
        let k = j;
        while (k < hi && targets[k] < end) k++;
        if (k > j) leaves.push({ offset: header.leafDirectoryOffset + dir.offset[i], length: dir.length[i], lo: j, hi: k, end });
        j = k;
      }
    }
    return leaves;
  };
  let queue = sweep(root, 0, targets.length, Infinity);
  let fetchedDirs = 0;
  while (queue.length) {
    queue.sort((a, b) => a.offset - b.offset);
    const groups = [];
    for (const l of queue) {
      const g = groups[groups.length - 1];
      if (g && l.offset - g.end <= LEAF_GAP_BYTES && l.offset + l.length - g.start <= MAX_BATCH_BYTES) { g.items.push(l); g.end = Math.max(g.end, l.offset + l.length); }
      else groups.push({ start: l.offset, end: l.offset + l.length, items: [l] });
    }
    const next = [];
    for (const g of groups) {
      const bytes = await source.get(g.start, g.end - g.start, signal);
      for (const l of g.items) {
        const dir = parseDirectory(await decompress(bytes.subarray(l.offset - g.start, l.offset - g.start + l.length), header.internalCompression));
        next.push(...sweep(dir, l.lo, l.hi, l.end));
        fetchedDirs++;
      }
      onStatus?.({ phase: 'directories', fetchedDirs });
    }
    queue = next;
  }

  // sort found tiles by id
  const order = Array.from(foundId.keys()).sort((a, b) => foundId[a] - foundId[b]);
  // unique contents ordered by source offset -> new offsets in that order (stream-friendly)
  const uniq = [...new Set(foundOff)].sort((a, b) => a - b);
  const lenOf = new Map();
  foundOff.forEach((o, i) => lenOf.set(o, foundLen[i]));
  const newOff = new Map();
  let acc = 0;
  const uLen = new Float64Array(uniq.length);
  uniq.forEach((o, i) => { newOff.set(o, acc); uLen[i] = lenOf.get(o); acc += uLen[i]; });
  const tileDataLength = acc;

  // output entries with run-length merging
  const E = { tileId: [], offset: [], length: [], runLength: [] };
  let prevSrc = -1;
  for (const i of order) {
    const id = foundId[i], src = foundOff[i];
    const k = E.tileId.length - 1;
    if (k >= 0 && src === prevSrc && id === E.tileId[k] + E.runLength[k]) { E.runLength[k]++; continue; }
    E.tileId.push(id); E.offset.push(newOff.get(src)); E.length.push(foundLen[i]); E.runLength.push(1);
    prevSrc = src;
  }
  const numEntries = E.tileId.length;

  // metadata (kept as plain JSON in the output)
  let meta = {};
  try {
    const mb = await source.get(header.jsonMetadataOffset, header.jsonMetadataLength, signal);
    meta = JSON.parse(new TextDecoder().decode(await decompress(mb, header.internalCompression)));
  } catch { /* metadata is optional */ }
  meta.description = `${meta.description || ''} — regional extract`.trim();
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));

  // directories: root alone if it fits, otherwise leaves
  let rootDir = serializeDirectory(E, 0, numEntries), leafBytes = [];
  if (127 + rootDir.length > 16384) {
    let leafSize = 4096;
    for (;;) {
      leafBytes = [];
      const R = { tileId: [], offset: [], length: [], runLength: [] };
      let off = 0;
      for (let s = 0; s < numEntries; s += leafSize) {
        const lb = serializeDirectory(E, s, Math.min(numEntries, s + leafSize));
        R.tileId.push(E.tileId[s]); R.offset.push(off); R.length.push(lb.length); R.runLength.push(0);
        leafBytes.push(lb); off += lb.length;
      }
      rootDir = serializeDirectory(R, 0, R.tileId.length);
      if (127 + rootDir.length <= 16384) break;
      leafSize *= 2;
    }
  }
  const leafTotal = leafBytes.reduce((s, b) => s + b.length, 0);
  const minLon = Math.min(...polygons.flat().map(p => p[0])), maxLon = Math.max(...polygons.flat().map(p => p[0]));
  const minLat = Math.min(...polygons.flat().map(p => p[1])), maxLat = Math.max(...polygons.flat().map(p => p[1]));
  const out = {
    rootDirectoryOffset: 127, rootDirectoryLength: rootDir.length,
    jsonMetadataOffset: 127 + rootDir.length, jsonMetadataLength: metaBytes.length,
    leafDirectoryOffset: 127 + rootDir.length + metaBytes.length, leafDirectoryLength: leafTotal,
    tileDataOffset: 127 + rootDir.length + metaBytes.length + leafTotal, tileDataLength,
    numAddressedTiles: foundId.length, numTileEntries: numEntries, numTileContents: uniq.length,
    clustered: false, internalCompression: 1, tileCompression: header.tileCompression, tileType: header.tileType,
    minZoom, maxZoom, minLon, minLat, maxLon, maxLat,
    centerZoom: Math.max(minZoom, Math.min(maxZoom, 7)), centerLon: (minLon + maxLon) / 2, centerLat: (minLat + maxLat) / 2,
  };
  const chunk0 = new Uint8Array(out.tileDataOffset);
  chunk0.set(serializeHeader(out), 0);
  chunk0.set(rootDir, out.rootDirectoryOffset);
  chunk0.set(metaBytes, out.jsonMetadataOffset);
  let lp = out.leafDirectoryOffset;
  for (const lb of leafBytes) { chunk0.set(lb, lp); lp += lb.length; }

  // download batches: merge nearby contents while the wasted bytes stay within the overfetch budget
  const gaps = [];
  for (let i = 0; i + 1 < uniq.length; i++) gaps.push([uniq[i + 1] - (uniq[i] + uLen[i]), i]);
  const joined = new Uint8Array(Math.max(0, uniq.length - 1));
  let budget = overfetch * tileDataLength;
  gaps.sort((a, b) => a[0] - b[0]);
  for (const [g, i] of gaps) { if (g > 0 && (g > budget || g > MAX_GAP_BYTES)) break; budget -= g; joined[i] = 1; }
  const batches = [];
  let b0 = 0;
  for (let i = 0; i < uniq.length; i++) {
    const end = uniq[i] + uLen[i];
    const startNew = newOff.get(uniq[b0]);
    const nextSplit = i + 1 >= uniq.length || !joined[i] || (newOff.get(uniq[i + 1]) + uLen[i + 1] - startNew > MAX_BATCH_BYTES);
    if (nextSplit) {
      batches.push({ srcStart: uniq[b0], srcEnd: end, outStart: out.tileDataOffset + startNew, first: b0, last: i });
      b0 = i + 1;
    }
  }
  return {
    header: out, sourceHeader: header, etag: source.etag, chunk0, batches,
    uniqOffsets: uniq, uniqLengths: uLen,
    stats: { targets: targets.length, tiles: foundId.length, entries: numEntries, contents: uniq.length, bytes: out.tileDataOffset + tileDataLength, download: batches.reduce((s, b) => s + b.srcEnd - b.srcStart, 0), requests: batches.length + fetchedDirs + 2 },
  };
}

/** Download one batch and return its output bytes (contents back to back). */
export async function fetchBatch(source, plan, index, signal) {
  const b = plan.batches[index];
  const base = plan.sourceHeader.tileDataOffset;
  const bytes = await source.get(base + b.srcStart, b.srcEnd - b.srcStart, signal);
  let size = 0;
  for (let i = b.first; i <= b.last; i++) size += plan.uniqLengths[i];
  const out = new Uint8Array(size);
  let p = 0;
  for (let i = b.first; i <= b.last; i++) {
    const s = plan.uniqOffsets[i] - b.srcStart;
    out.set(bytes.subarray(s, s + plan.uniqLengths[i]), p);
    p += plan.uniqLengths[i];
  }
  return out;
}

/**
 * Run all batches not yet stored. `has(index)` says whether chunk index (1-based; 0 is the header
 * chunk) already exists; `write(index, bytes)` stores one. Downloads `concurrency` batches at a time.
 */
export async function runExtract(source, plan, { has, write, onProgress, signal, concurrency = 4, retries = 5 } = {}) {
  if (!(await has(0))) await write(0, plan.chunk0);
  const todo = [];
  let done = 0;
  const total = plan.stats.download;
  for (let i = 0; i < plan.batches.length; i++) {
    if (await has(i + 1)) done += plan.batches[i].srcEnd - plan.batches[i].srcStart;
    else todo.push(i);
  }
  onProgress?.({ done, total });
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = todo[next++];
      for (let attempt = 0; ; attempt++) {
        try {
          const bytes = await fetchBatch(source, plan, i, signal);
          await write(i + 1, bytes);
          done += plan.batches[i].srcEnd - plan.batches[i].srcStart;
          onProgress?.({ done, total });
          break;
        } catch (err) {
          if (signal?.aborted || err.code === 'ETAG' || attempt >= retries) throw err;
          await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
}

/** Absolute start offset of each stored chunk (chunk 0 = header + directories). */
export function chunkStarts(plan) {
  return [0, ...plan.batches.map(b => b.outStart)];
}

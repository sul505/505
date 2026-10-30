// Builds the offline Oman datasets used by the app from an OpenStreetMap extract.
//
//   node maps/tools/build-data.mjs <oman-latest.osm.pbf> <osm-timestamp>
//
// Outputs (maps/data/):
//   oman-roads.bin.gz   routing graph (edge-based A* with turn restrictions), see ROADS FORMAT below
//   oman-places.json    offline search index (places, POIs, peaks, wadis, named roads)
//   oman-cameras.json   speed cameras with speed limits and facing direction when known
//   oman-admin.json     governorates and wilayats (simplified) for offline addresses
//   oman-boundary.json  country outline used to pick which map tiles to download
//   manifest.json       versions and sizes
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPbf, nodeIndex } from './osmpbf.mjs';

const [, , pbfPath, osmTimestamp = ''] = process.argv;
if (!pbfPath) { console.error('usage: build-data.mjs <file.osm.pbf> [osm-timestamp]'); process.exit(1); }
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(OUT, { recursive: true });

console.time('parse');
const osm = readPbf(pbfPath);
console.timeEnd('parse');
const { nodes } = osm;

/* ---------- geometry helpers ---------- */
const R = 6371008.8;
const rad = d => (d * Math.PI) / 180;
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
// Douglas-Peucker on [lat, lon] points, tolerance in metres.
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const lat0 = rad(pts[0][0]);
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][1] * kx, ay = pts[a][0] * ky, bx = pts[b][1] * kx, by = pts[b][0] * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][1] * kx, py = pts[i][0] * ky;
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const coordOf = id => { const i = nodeIndex(nodes, id); return i < 0 ? null : [nodes.lat[i], nodes.lon[i]]; };
const hasArabic = s => /[؀-ۿ]/.test(s || '');
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

const wayById = new Map(osm.ways.map(w => [w.id, w]));

/* ---------- rings for boundary relations ---------- */
function assembleRings(wayRefLists) {
  const segs = wayRefLists.map(r => Array.from(r)).filter(r => r.length >= 2);
  const byEnd = new Map();
  const addEnd = (id, i) => { if (!byEnd.has(id)) byEnd.set(id, []); byEnd.get(id).push(i); };
  segs.forEach((s, i) => { addEnd(s[0], i); addEnd(s[s.length - 1], i); });
  const used = new Uint8Array(segs.length);
  const rings = [];
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    let ring = segs[start].slice();
    for (;;) {
      const end = ring[ring.length - 1];
      if (end === ring[0] && ring.length > 3) break;
      const next = (byEnd.get(end) || []).find(i => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      ring = ring.concat(s[0] === end ? s.slice(1) : s.slice(0, -1).reverse());
    }
    rings.push(ring);
  }
  return rings;
}
function relationPolygon(rel, tolMeters) {
  const outerLists = [];
  for (const m of rel.members) {
    if (m.type !== 'way' || (m.role && m.role !== 'outer')) continue;
    const w = wayById.get(m.ref);
    if (w) outerLists.push(w.refs);
  }
  const polys = [];
  for (const ring of assembleRings(outerLists)) {
    let pts = ring.map(coordOf).filter(Boolean);
    if (pts.length < 4) continue;
    pts = simplify(pts, tolMeters);
    if (pts.length < 4) continue;
    const ringLonLat = pts.map(([la, lo]) => [round(lo, 5), round(la, 5)]);
    const f = ringLonLat[0], l = ringLonLat[ringLonLat.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) ringLonLat.push(f);
    polys.push([ringLonLat]);
  }
  return polys;
}

/* ---------- 1) country outline + admin areas ---------- */
const omanRel = osm.relations.find(r => r.tags?.boundary === 'administrative' && r.tags.admin_level === '2' && r.tags['ISO3166-1'] === 'OM');
if (!omanRel) throw new Error('Oman boundary relation not found');
const omanPolys = relationPolygon(omanRel, 150);
writeFileSync(join(OUT, 'oman-boundary.json'), JSON.stringify({
  type: 'Feature',
  properties: { name: 'عُمان', source: 'OpenStreetMap relation ' + omanRel.id },
  geometry: { type: 'MultiPolygon', coordinates: omanPolys },
}));

// Known OSM labelling mistakes. Relation 19558488 carries the Jaalan Bani Bu Ali name but its
// outline covers Sur city and Ras al Hadd (the real Jaalan Bani Bu Ali is 19558567), so it is Sur.
const ADMIN_FIXES = { 19558488: { ar: 'ولاية صور', en: 'Sur Province' } };
const adminAreas = [];
for (const r of osm.relations) {
  const t = r.tags;
  if (t?.boundary !== 'administrative') continue;
  const isGov = t.admin_level === '4' && /^OM-/.test(t['ISO3166-2'] || '');
  const isWil = t.admin_level === '6' && /ولاية/.test(t.name || '');
  if (!isGov && !isWil) continue;
  const polys = relationPolygon(r, 120);
  if (!polys.length) continue;
  const fix = ADMIN_FIXES[r.id];
  adminAreas.push({
    level: isGov ? 4 : 6,
    ar: fix?.ar || (t['name:ar'] || t.name || '').trim(),
    en: fix?.en || (t['name:en'] || '').trim(),
    polys: polys.map(p => p[0].map(([lo, la]) => [round(lo, 4), round(la, 4)])),
  });
}
writeFileSync(join(OUT, 'oman-admin.json'), JSON.stringify(adminAreas));

/* ---------- 2) routing graph ---------- */
// Index order matters: the app maps class ids to speeds and permissions.
const CLASSES = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road', 'track', 'busway',
  'pedestrian', 'footway', 'path', 'cycleway', 'bridleway', 'steps'];
const CLASS_ID = new Map(CLASSES.map((c, i) => [c, i]));
const UNPAVED = new Set(['unpaved', 'gravel', 'dirt', 'sand', 'ground', 'compacted', 'fine_gravel', 'earth', 'mud', 'rock',
  'pebblestone', 'grass', 'salt', 'stone', 'stones', 'woodchips', 'clay', 'shells']);

const routable = osm.ways.filter(w => {
  const t = w.tags;
  if (!t || !CLASS_ID.has(t.highway)) return false;
  if (t.area === 'yes') return false;
  if (t.access === 'no' && t.highway !== 'track' && !t.foot && !t.motor_vehicle && !t.motorcar && !t.vehicle) return false;
  return w.refs.length >= 2;
});

function parseSpeed(v) {
  if (!v) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?/i.exec(v.trim());
  if (!m) return 0;
  let s = parseFloat(m[1]);
  if (m[2] && m[2].toLowerCase() === 'mph') s *= 1.609;
  return Math.max(0, Math.min(140, Math.round(s)));
}
const NO = new Set(['no']);
const LIMITED = new Set(['private', 'customers', 'delivery', 'agricultural', 'forestry', 'permit', 'destination', 'military']);
function motorAccess(t) {
  for (const k of ['motorcar', 'motor_vehicle', 'vehicle', 'access']) {
    const v = t[k];
    if (!v) continue;
    if (NO.has(v)) return 'no';
    if (LIMITED.has(v)) return 'limited';
    if (v === 'yes' || v === 'permissive' || v === 'designated') return 'yes';
  }
  return 'yes';
}
function footAccess(t) {
  const v = t.foot || t.access;
  if (v === 'no') return false;
  if (t.highway === 'motorway' || t.highway === 'motorway_link') return t.foot === 'yes';
  return true;
}

// Junctions: nodes shared by several routable ways, way ends, and turn-restriction vias.
const useCount = new Uint8Array(nodes.count);
const bump = i => { if (useCount[i] < 255) useCount[i]++; };
const wayNodeIdx = routable.map(w => {
  const idx = new Int32Array(w.refs.length);
  for (let k = 0; k < w.refs.length; k++) idx[k] = nodeIndex(nodes, w.refs[k]);
  return idx;
});
wayNodeIdx.forEach(idx => {
  for (let k = 0; k < idx.length; k++) if (idx[k] >= 0) bump(idx[k]);
  if (idx[0] >= 0) bump(idx[0]);
  if (idx[idx.length - 1] >= 0) bump(idx[idx.length - 1]);
  // closed ways (loops) get a split point so they don't collapse into a zero-length edge
  if (idx.length > 3 && idx[0] === idx[idx.length - 1]) { const mid = idx[idx.length >> 1]; if (mid >= 0) { bump(mid); bump(mid); } }
});
const restrictionKind = r => r.tags.restriction || r.tags['restriction:motorcar'] || '';
const restrictionRels = osm.relations.filter(r => r.tags?.type === 'restriction' && /^(no|only)_/.test(restrictionKind(r)));
for (const r of restrictionRels) {
  const via = r.members.find(m => m.role === 'via' && m.type === 'node');
  if (via) { const i = nodeIndex(nodes, via.ref); if (i >= 0) { bump(i); bump(i); } }
}
// Speed-camera nodes become graph nodes too, so cameras can be matched to the road they sit on.
const graphNodeOf = new Int32Array(nodes.count).fill(-1);
const gLat = [], gLon = [];
const toGraph = i => {
  if (graphNodeOf[i] < 0) { graphNodeOf[i] = gLat.length; gLat.push(nodes.lat[i]); gLon.push(nodes.lon[i]); }
  return graphNodeOf[i];
};

const names = [''], nameId = new Map([['', 0]]);
const internName = s => { if (!nameId.has(s)) { nameId.set(s, names.length); names.push(s); } return nameId.get(s); };
function displayName(t) {
  const n = (t['name:ar'] || t.name || t['name:en'] || '').trim();
  const ref = (t.ref || '').trim();
  if (n && ref) return `${n} (${ref})`;
  if (n) return n;
  return ref ? `طريق ${ref}` : '';
}

const E = { a: [], b: [], len: [], cls: [], flags: [], extra: [], speed: [], name: [], way: [], gStart: [0] };
const geom = []; // flat lat, lon (intermediate points only, simplified)
let rawPoints = 0;
const wayIndexOfOsmId = new Map();

routable.forEach((w, wi) => {
  const t = w.tags;
  wayIndexOfOsmId.set(w.id, wi);
  const cls = CLASS_ID.get(t.highway);
  let oneway = 0;
  const ow = t.oneway;
  if (ow === 'yes' || ow === '1' || ow === 'true') oneway = 1;
  else if (ow === '-1' || ow === 'reverse') oneway = 2;
  else if (ow !== 'no' && (t.junction === 'roundabout' || t.junction === 'circular' || t.highway === 'motorway')) oneway = 1;
  const surface = (t.surface || '').split(/[;:]/)[0];
  const grade = /^grade([1-5])$/.exec(t.tracktype || '');
  const unpaved = UNPAVED.has(surface) || (!t.surface && t.highway === 'track' && !(grade && grade[1] === '1'));
  const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
  const ma = (ow === 'reversible' || ow === 'alternating') ? 'no' : motorAccess(t);
  let flags = oneway;
  if (unpaved) flags |= 4;
  if (roundabout) flags |= 8;
  if (ma === 'no') flags |= 16;
  if (ma === 'limited') flags |= 32;
  if (!footAccess(t)) flags |= 64;
  if (t.bridge && t.bridge !== 'no') flags |= 128;
  const extra = (grade ? +grade[1] : 0) | (surface === 'sand' ? 8 : 0) | (t.tunnel && t.tunnel !== 'no' ? 16 : 0);
  const speed = parseSpeed(t.maxspeed);
  const nm = internName(displayName(t));

  const idx = wayNodeIdx[wi];
  let k = 0;
  while (k < idx.length && idx[k] < 0) k++;
  while (k < idx.length - 1) {
    const startK = k;
    const pts = [[nodes.lat[idx[k]], nodes.lon[idx[k]]]];
    let len = 0, broken = false;
    k++;
    while (k < idx.length) {
      if (idx[k] < 0) { broken = true; break; }
      const p = [nodes.lat[idx[k]], nodes.lon[idx[k]]];
      const q = pts[pts.length - 1];
      len += haversine(q[0], q[1], p[0], p[1]);
      pts.push(p);
      if (useCount[idx[k]] >= 2) break;
      k++;
    }
    if (broken) { // node missing from the extract: drop the partial piece and resume after the gap
      while (k < idx.length && idx[k] < 0) k++;
      continue;
    }
    if (k >= idx.length) break;
    const aI = idx[startK], bI = idx[k];
    if (aI !== bI && pts.length >= 2) {
      rawPoints += pts.length;
      const simp = simplify(pts, 1.5);
      for (let j = 1; j < simp.length - 1; j++) geom.push(simp[j][0], simp[j][1]);
      E.a.push(toGraph(aI)); E.b.push(toGraph(bI)); E.len.push(len);
      E.cls.push(cls); E.flags.push(flags); E.extra.push(extra); E.speed.push(speed); E.name.push(nm); E.way.push(wi);
      E.gStart.push(geom.length / 2);
    }
  }
});

// Turn restrictions (via-node only): [viaNode, fromWay, toWay, kind 0=no / 1=only]
const restr = [];
for (const r of restrictionRels) {
  const via = r.members.find(m => m.role === 'via' && m.type === 'node');
  const from = r.members.find(m => m.role === 'from' && m.type === 'way');
  const to = r.members.find(m => m.role === 'to' && m.type === 'way');
  if (!via || !from || !to) continue;
  if (r.tags.except && /motorcar/.test(r.tags.except)) continue;
  const vi = nodeIndex(nodes, via.ref);
  const fw = wayIndexOfOsmId.get(from.ref), tw = wayIndexOfOsmId.get(to.ref);
  if (vi < 0 || fw === undefined || tw === undefined || graphNodeOf[vi] < 0) continue;
  restr.push(graphNodeOf[vi], fw, tw, restrictionKind(r).startsWith('only_') ? 1 : 0);
}

/* ROADS FORMAT v2 (little-endian), gzip-compressed on disk.
 *  header  u32 magic 'OMRG', u32 version=2, u32 N nodes, u32 M edges, u32 P geometry points,
 *          u32 S names, u32 K restrictions, u32 column count
 *  columns, each: u32 encoding, u32 element count, u32 byte length, bytes (padded to 4)
 *    encoding 0 = raw bytes, 1 = int32 delta + zigzag + byte planes, 2 = uint32 byte planes
 *  column order:
 *    lat[N], lon[N]          i32 micro-degrees
 *    a[M], b[M]              edge end nodes
 *    len[M]                  decimetres
 *    way[M]                  OSM way index (for turn restrictions)
 *    name[M]                 index into names
 *    gStart[M+1]             first interior geometry point of each edge
 *    cls[M], flags[M], extra[M], speed[M]   u8
 *      flags: bit0-1 oneway (1 a→b, 2 b→a), 2 unpaved, 3 roundabout, 4 no motor vehicles,
 *             5 restricted access, 6 no foot, 7 bridge
 *      extra: bit0-2 tracktype grade (0 unknown), 3 sand, 4 tunnel
 *    glat[P], glon[P]        i32 1e-5 degrees, interior points of each edge
 *    restr[4K]               (viaNode, fromWay, toWay, kind 0=no / 1=only)
 *    nameOffsets[S+1], nameBytes (UTF-8), classNames (UTF-8, comma separated)
 */
function encodeColumn(encoding, values) {
  const n = values.length;
  let bytes;
  if (encoding === 0) bytes = values instanceof Uint8Array ? values : Uint8Array.from(values);
  else {
    const words = new Uint32Array(n);
    if (encoding === 1) {
      let prev = 0;
      for (let i = 0; i < n; i++) { const d = (values[i] - prev) | 0; prev = values[i]; words[i] = (d << 1) ^ (d >> 31); }
    } else for (let i = 0; i < n; i++) words[i] = values[i] >>> 0;
    const src = new Uint8Array(words.buffer);
    bytes = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) bytes[k * n + i] = src[i * 4 + k];
  }
  const head = Buffer.alloc(12);
  head.writeUInt32LE(encoding, 0); head.writeUInt32LE(n, 4); head.writeUInt32LE(bytes.length, 8);
  const pad = Buffer.alloc((4 - (bytes.length % 4)) % 4);
  return Buffer.concat([head, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), pad]);
}
function buildRoadsBuffer() {
  const N = gLat.length, M = E.a.length, P = geom.length / 2, S = names.length, K = restr.length / 4;
  const enc = new TextEncoder();
  const nameBufs = names.map(n => enc.encode(n));
  const nameOffsets = new Uint32Array(S + 1);
  nameBufs.forEach((b, i) => { nameOffsets[i + 1] = nameOffsets[i] + b.length; });
  const nameBytes = new Uint8Array(nameOffsets[S]);
  nameBufs.forEach((b, i) => nameBytes.set(b, nameOffsets[i]));
  const glat = new Int32Array(P), glon = new Int32Array(P);
  for (let i = 0; i < P; i++) { glat[i] = Math.round(geom[2 * i] * 1e5); glon[i] = Math.round(geom[2 * i + 1] * 1e5); }
  const cols = [
    encodeColumn(1, Int32Array.from(gLat, v => Math.round(v * 1e6))),
    encodeColumn(1, Int32Array.from(gLon, v => Math.round(v * 1e6))),
    encodeColumn(1, E.a), encodeColumn(1, E.b),
    encodeColumn(2, E.len.map(v => Math.round(v * 10))),
    encodeColumn(1, E.way), encodeColumn(2, E.name), encodeColumn(1, E.gStart),
    encodeColumn(0, E.cls), encodeColumn(0, E.flags), encodeColumn(0, E.extra), encodeColumn(0, E.speed),
    encodeColumn(1, glat), encodeColumn(1, glon),
    encodeColumn(2, restr),
    encodeColumn(1, nameOffsets), encodeColumn(0, nameBytes), encodeColumn(0, enc.encode(CLASSES.join(','))),
  ];
  const head = Buffer.alloc(32);
  [0x47524d4f, 2, N, M, P, S, K, cols.length].forEach((v, i) => head.writeUInt32LE(v, i * 4));
  return Buffer.concat([head, ...cols]);
}
const roadsRaw = buildRoadsBuffer();
writeFileSync(join(OUT, 'oman-roads.bin.gz'), gzipSync(roadsRaw, { level: 9 }));

/* ---------- 3) speed cameras ---------- */
// Bearing of the road through a node, from the routable ways that contain it.
const nodeWays = new Map();
routable.forEach((w, wi) => w.refs.forEach((r, k) => { if (!nodeWays.has(r)) nodeWays.set(r, []); nodeWays.get(r).push([wi, k]); }));
function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const DIR_WORDS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const cameras = [];
const camSeen = new Set();
function addCamera(id, lat, lon, tags, relTags, relDir) {
  if (camSeen.has(id)) return;
  camSeen.add(id);
  let speed = parseSpeed(tags.maxspeed) || parseSpeed(relTags?.maxspeed);
  let dir = null, dirSrc = null;
  const rawDir = tags['camera:direction'] || tags.direction;
  const onWays = nodeWays.get(id) || [];
  if (rawDir && /^\d+(\.\d+)?$/.test(rawDir)) dir = +rawDir % 360;
  else if (rawDir && DIR_WORDS[rawDir.toUpperCase()] !== undefined) dir = DIR_WORDS[rawDir.toUpperCase()];
  else if (relDir != null) dir = relDir;
  if (dir != null) dirSrc = 'tag';
  else if ((rawDir === 'forward' || rawDir === 'backward') && onWays.length) {
    const [wi, k] = onWays[0];
    const refs = routable[wi].refs;
    const p = coordOf(refs[Math.max(0, k - 1)]), q = coordOf(refs[Math.min(refs.length - 1, k + 1)]);
    if (p && q) { dir = (bearing(p[0], p[1], q[0], q[1]) + (rawDir === 'backward' ? 180 : 0)) % 360; dirSrc = 'tag'; }
  }
  // A camera on a one-way carriageway faces the traffic direction of that carriageway.
  if (dir == null && onWays.length === 1) {
    const [wi, k] = onWays[0];
    const w = routable[wi];
    const ow = w.tags.oneway === 'yes' || w.tags.oneway === '1' || w.tags.highway === 'motorway' ? 1 : w.tags.oneway === '-1' ? -1 : 0;
    if (ow) {
      const refs = w.refs;
      const p = coordOf(refs[Math.max(0, k - 1)]), q = coordOf(refs[Math.min(refs.length - 1, k + 1)]);
      if (p && q) { dir = (bearing(p[0], p[1], q[0], q[1]) + (ow < 0 ? 180 : 0)) % 360; dirSrc = 'road'; }
    }
  }
  if (!speed) for (const [wi] of onWays) { speed = parseSpeed(routable[wi].tags.maxspeed); if (speed) break; }
  // Cameras mapped beside the road: borrow limit and (on one-way carriageways) direction from the nearest road.
  let road = null;
  if (!onWays.length && (!speed || dir == null)) {
    road = nearestEdge(lat, lon, 40);
    if (road) {
      if (!speed && E.speed[road.edge]) speed = E.speed[road.edge];
      const ow = E.flags[road.edge] & 3;
      if (dir == null && ow) { dir = (road.bearing + (ow === 2 ? 180 : 0)) % 360; dirSrc = 'near'; }
    }
  }
  cameras.push({ lat: round(lat, 6), lon: round(lon, 6), speed: speed || null, dir: dir == null ? null : Math.round(dir), dirSrc });
}
// Coarse grid over edge segments for nearest-road lookups.
const CELL = 0.002;
const edgeGrid = new Map();
function edgePoints(i) {
  const pts = [[gLat[E.a[i]], gLon[E.a[i]]]];
  for (let g = E.gStart[i]; g < E.gStart[i + 1]; g++) pts.push([geom[2 * g], geom[2 * g + 1]]);
  pts.push([gLat[E.b[i]], gLon[E.b[i]]]);
  return pts;
}
for (let i = 0; i < E.a.length; i++) {
  if (CLASSES[E.cls[i]] === 'footway' || CLASSES[E.cls[i]] === 'path' || CLASSES[E.cls[i]] === 'steps') continue;
  const pts = edgePoints(i);
  const cells = new Set();
  for (let j = 1; j < pts.length; j++) {
    const y0 = Math.floor(Math.min(pts[j - 1][0], pts[j][0]) / CELL), y1 = Math.floor(Math.max(pts[j - 1][0], pts[j][0]) / CELL);
    const x0 = Math.floor(Math.min(pts[j - 1][1], pts[j][1]) / CELL), x1 = Math.floor(Math.max(pts[j - 1][1], pts[j][1]) / CELL);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.add(y * 100000 + x);
  }
  for (const c of cells) { if (!edgeGrid.has(c)) edgeGrid.set(c, []); edgeGrid.get(c).push(i); }
}
function nearestEdge(lat, lon, maxMeters) {
  const kx = 111320 * Math.cos(rad(lat)), ky = 110540;
  const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL);
  let best = null;
  for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
    for (const i of edgeGrid.get(y * 100000 + x) || []) {
      const pts = edgePoints(i);
      for (let j = 1; j < pts.length; j++) {
        const ax = (pts[j - 1][1] - lon) * kx, ay = (pts[j - 1][0] - lat) * ky, bx = (pts[j][1] - lon) * kx, by = (pts[j][0] - lat) * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d <= maxMeters && (!best || d < best.d)) best = { edge: i, d, bearing: bearing(pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1]) };
      }
    }
  }
  return best;
}
for (const r of osm.relations) {
  if (r.tags?.type !== 'enforcement' || (r.tags.enforcement && r.tags.enforcement !== 'maxspeed')) continue;
  const dev = r.members.find(m => m.role === 'device' && m.type === 'node');
  const from = r.members.find(m => m.role === 'from' && m.type === 'node');
  const to = r.members.find(m => m.role === 'to' && m.type === 'node');
  const target = dev || from;
  if (!target) continue;
  const tn = osm.tagged.find(n => n.id === target.ref);
  const c = tn ? [tn.lat, tn.lon] : coordOf(target.ref);
  if (!c) continue;
  let relDir = null;
  const fc = from && coordOf(from.ref), tc = to && coordOf(to.ref);
  if (fc && tc) relDir = bearing(fc[0], fc[1], tc[0], tc[1]);
  addCamera(target.ref, c[0], c[1], tn ? tn.tags : {}, r.tags, relDir);
}
for (const n of osm.tagged) if (n.tags.highway === 'speed_camera') addCamera(n.id, n.lat, n.lon, n.tags, null, null);
writeFileSync(join(OUT, 'oman-cameras.json'), JSON.stringify(cameras));

/* ---------- 4) offline search index ---------- */
// kind code -> [match function on tags]; order = priority when a feature matches several
const KINDS = [
  ['city', t => t.place === 'city'], ['town', t => t.place === 'town'], ['village', t => t.place === 'village'],
  ['hamlet', t => t.place === 'hamlet' || t.place === 'isolated_dwelling' || t.place === 'farm'],
  ['suburb', t => t.place === 'suburb' || t.place === 'quarter' || t.place === 'neighbourhood'],
  ['locality', t => t.place === 'locality' || t.place === 'region' || t.place === 'square'],
  ['island', t => t.place === 'island' || t.place === 'islet'],
  ['peak', t => t.natural === 'peak' || t.natural === 'volcano'], ['saddle', t => t.natural === 'saddle'],
  ['spring', t => t.natural === 'spring' || t.natural === 'hot_spring'], ['cave', t => t.natural === 'cave_entrance'],
  ['beach', t => t.natural === 'beach' || t.leisure === 'beach_resort'], ['bay', t => t.natural === 'bay' || t.natural === 'cape'],
  ['dune', t => t.natural === 'dune' || t.natural === 'sand' || t.natural === 'desert'],
  ['valley', t => t.natural === 'valley' || t.waterway === 'wadi' || t.natural === 'gorge' || t.natural === 'canyon'],
  ['wadi', t => (t.waterway === 'river' || t.waterway === 'stream') && t.name],
  ['oasis', t => t.natural === 'oasis'], ['cliff', t => t.natural === 'cliff' || t.natural === 'ridge' || t.natural === 'mountain_range'],
  ['reef', t => t.natural === 'reef'], ['water', t => (t.natural === 'water' || t.water) && t.name],
  ['fort', t => t.historic === 'castle' || t.historic === 'fort' || t.historic === 'city_gate' || t.historic === 'tower'],
  ['ruins', t => t.historic === 'ruins' || t.historic === 'archaeological_site' || t.historic === 'tomb' || t.historic === 'wreck'],
  ['monument', t => t.historic === 'monument' || t.historic === 'memorial'],
  ['museum', t => t.tourism === 'museum'], ['viewpoint', t => t.tourism === 'viewpoint'],
  ['attraction', t => t.tourism === 'attraction' || t.tourism === 'artwork' || t.tourism === 'zoo' || t.tourism === 'theme_park'],
  ['camp', t => t.tourism === 'camp_site' || t.tourism === 'caravan_site' || t.tourism === 'picnic_site' || t.tourism === 'alpine_hut' || t.amenity === 'shelter'],
  ['hotel', t => ['hotel', 'motel', 'guest_house', 'hostel', 'chalet', 'apartment', 'resort'].includes(t.tourism)],
  ['airport', t => t.aeroway === 'aerodrome' || t.aeroway === 'airport'], ['port', t => t.amenity === 'ferry_terminal' || t.leisure === 'marina' || t.leisure === 'slipway' || t.harbour === 'yes'],
  ['fuel', t => t.amenity === 'fuel'], ['hospital', t => t.amenity === 'hospital'], ['clinic', t => t.amenity === 'clinic' || t.amenity === 'doctors'],
  ['pharmacy', t => t.amenity === 'pharmacy'], ['police', t => t.amenity === 'police'], ['fire', t => t.amenity === 'fire_station'],
  ['water_point', t => t.amenity === 'drinking_water' || t.amenity === 'water_point'],
  ['mosque', t => t.amenity === 'place_of_worship'], ['school', t => ['school', 'university', 'college'].includes(t.amenity)],
  ['bank', t => t.amenity === 'bank' || t.amenity === 'atm' || t.amenity === 'bureau_de_change'],
  ['food', t => ['restaurant', 'cafe', 'fast_food', 'food_court', 'ice_cream'].includes(t.amenity)],
  ['shop', t => ['supermarket', 'mall', 'department_store', 'convenience', 'bakery', 'greengrocer'].includes(t.shop) || t.amenity === 'marketplace'],
  ['car', t => ['car_repair', 'tyres', 'car', 'car_parts'].includes(t.shop) || t.amenity === 'car_rental' || t.amenity === 'car_wash'],
  ['gov', t => ['townhall', 'courthouse', 'embassy', 'post_office', 'community_centre'].includes(t.amenity) || t.office === 'government'],
  ['park', t => t.leisure === 'park' || t.leisure === 'nature_reserve' || t.boundary === 'protected_area' || t.boundary === 'national_park'],
  ['sport', t => t.leisure === 'stadium' || t.leisure === 'sports_centre'],
  ['bus', t => t.amenity === 'bus_station'], ['lighthouse', t => t.man_made === 'lighthouse'],
  ['toilets', t => t.amenity === 'toilets'], ['parking', t => t.amenity === 'parking' && t.name],
];
const KEEP_UNNAMED = new Set(['fuel', 'water_point', 'hospital', 'police', 'camp', 'peak', 'spring', 'cave', 'viewpoint', 'toilets']);
const kindIndex = new Map(KINDS.map(([k], i) => [k, i]));
const items = [];
function addItem(tags, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const k = KINDS.find(([, f]) => f(tags));
  if (!k) return;
  const name = (tags.name || '').trim();
  const ar = (tags['name:ar'] || (hasArabic(name) ? name : '')).trim();
  const en = (tags['name:en'] || (!hasArabic(name) ? name : '')).trim();
  if (!ar && !en && !KEEP_UNNAMED.has(k[0])) return;
  const ele = parseFloat(tags.ele);
  items.push([ar, en === ar ? '' : en, kindIndex.get(k[0]), Math.round(lat * 1e5), Math.round(lon * 1e5), Number.isFinite(ele) ? Math.round(ele) : null]);
}
for (const n of osm.tagged) addItem(n.tags, n.lat, n.lon);
function centerOf(refs, line) {
  const pts = Array.from(refs, coordOf).filter(Boolean);
  if (!pts.length) return null;
  if (line) return pts[Math.floor(pts.length / 2)];
  let la = 0, lo = 0;
  for (const p of pts) { la += p[0]; lo += p[1]; }
  return [la / pts.length, lo / pts.length];
}
for (const w of osm.ways) {
  if (!w.tags || w.tags.highway) continue;
  const closed = w.refs[0] === w.refs[w.refs.length - 1];
  const c = centerOf(w.refs, !closed);
  if (c) addItem(w.tags, c[0], c[1]);
}
for (const r of osm.relations) {
  if (!r.tags || r.tags.type === 'boundary' || r.tags.boundary === 'administrative' || r.tags.type === 'restriction' || r.tags.type === 'route') continue;
  const outer = r.members.find(m => m.type === 'way' && (m.role === 'outer' || m.role === ''));
  const w = outer && wayById.get(outer.ref);
  if (!w) continue;
  const c = centerOf(w.refs, false);
  if (c) addItem(r.tags, c[0], c[1]);
}
// Named roads: one entry per name at the middle of its longest piece.
const roadBest = new Map();
for (let i = 0; i < E.a.length; i++) {
  const nm = names[E.name[i]];
  if (!nm) continue;
  const cur = roadBest.get(nm);
  if (!cur || E.len[i] > cur.len) roadBest.set(nm, { len: E.len[i], i });
}
const ROAD_KIND = KINDS.length;
for (const [nm, { i }] of roadBest) {
  const g0 = E.gStart[i], g1 = E.gStart[i + 1];
  let lat, lon;
  if (g1 > g0) { const m = g0 + Math.floor((g1 - g0) / 2); lat = geom[2 * m]; lon = geom[2 * m + 1]; }
  else { lat = (gLat[E.a[i]] + gLat[E.b[i]]) / 2; lon = (gLon[E.a[i]] + gLon[E.b[i]]) / 2; }
  items.push([hasArabic(nm) ? nm : '', hasArabic(nm) ? '' : nm, ROAD_KIND, Math.round(lat * 1e5), Math.round(lon * 1e5), null]);
}
// Drop near-duplicates (same names and kind within ~150 m), keeping the first.
const seen = new Map();
const deduped = items.filter(it => {
  const key = `${it[0]}|${it[1]}|${it[2]}`;
  const prev = seen.get(key);
  if (prev && prev.some(([la, lo]) => Math.abs(la - it[3]) < 150 && Math.abs(lo - it[4]) < 150)) return false;
  if (!prev) seen.set(key, [[it[3], it[4]]]); else prev.push([it[3], it[4]]);
  return true;
});
// Each item remembers its nearest settlement (index into items, or -1) so "قلعة نزوى" finds "Nizwa Fort".
const SETTLEMENT = new Set(['city', 'town', 'village', 'suburb'].map(k => kindIndex.get(k)));
const settleGrid = new Map();
deduped.forEach((it, i) => {
  if (!SETTLEMENT.has(it[2]) || !it[0]) return;
  const key = Math.floor(it[3] / 10000) * 10000 + Math.floor(it[4] / 10000);
  if (!settleGrid.has(key)) settleGrid.set(key, []);
  settleGrid.get(key).push(i);
});
const RANK = it => ({ city: 0, town: 1, suburb: 2, village: 3 })[KINDS[it[2]]?.[0]] ?? 4;
deduped.forEach((it, self) => {
  const cy = Math.floor(it[3] / 10000), cx = Math.floor(it[4] / 10000);
  let best = -1, bestScore = Infinity;
  for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
    for (const j of settleGrid.get(y * 10000 + x) || []) {
      const o = deduped[j];
      const d = Math.hypot((o[3] - it[3]) * 1.11, (o[4] - it[4]) * 1.03); // metres
      if (d > 12000) continue;
      const score = d * (1 + 0.15 * RANK(o)); // prefer bigger settlements at similar distance
      if (score < bestScore) { bestScore = score; best = j; }
    }
  }
  it.push(best === self ? -1 : best);
});
writeFileSync(join(OUT, 'oman-places.json'), JSON.stringify({ v: 2, kinds: [...KINDS.map(([k]) => k), 'road'], items: deduped }));

/* ---------- manifest ---------- */
const files = ['oman-roads.bin.gz', 'oman-places.json', 'oman-cameras.json', 'oman-admin.json', 'oman-boundary.json'];
const manifest = {
  version: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  osmTimestamp,
  source: 'OpenStreetMap contributors (ODbL), extract by download.openstreetmap.fr',
  files: Object.fromEntries(files.map(f => [f, statSync(join(OUT, f)).size])),
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(JSON.stringify({
  graph: { nodes: gLat.length, edges: E.a.length, geomPoints: geom.length / 2, rawPoints, names: names.length, restrictions: restr.length / 4, rawBytes: roadsRaw.length },
  boundaryRings: omanPolys.length, boundaryPoints: omanPolys.reduce((s, p) => s + p[0].length, 0),
  admin: { governorates: adminAreas.filter(a => a.level === 4).length, wilayats: adminAreas.filter(a => a.level === 6).length },
  cameras: { total: cameras.length, withSpeed: cameras.filter(c => c.speed).length, dirTag: cameras.filter(c => c.dirSrc === 'tag').length, dirRoad: cameras.filter(c => c.dirSrc === 'road').length, dirNear: cameras.filter(c => c.dirSrc === 'near').length },
  places: { items: deduped.length, dropped: items.length - deduped.length },
  files: manifest.files,
}, null, 1));

// Offline routing over the Oman road graph (data/oman-roads.bin.gz, built by tools/build-data.mjs).
// Edge-based A* (the search state is the directed road segment you arrived on), so turn
// restrictions and U-turn rules can be applied at every junction.
const RAD = Math.PI / 180;

/* ---------- decoding ---------- */
export function decodeGraph(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x47524d4f) throw new Error('not a road graph file');
  const [, version, N, M, P, S, K, C] = Array.from({ length: 8 }, (_, i) => dv.getUint32(i * 4, true));
  if (version !== 2) throw new Error(`unsupported road graph version ${version}`);
  let o = 32;
  const cols = [];
  for (let c = 0; c < C; c++) {
    const enc = dv.getUint32(o, true), n = dv.getUint32(o + 4, true), len = dv.getUint32(o + 8, true);
    o += 12;
    const bytes = u8.subarray(o, o + len);
    o += len + ((4 - (len % 4)) % 4);
    if (enc === 0) { cols.push(bytes); continue; }
    const words = new Uint32Array(n);
    const w8 = new Uint8Array(words.buffer);
    for (let k = 0; k < 4; k++) { const plane = bytes.subarray(k * n, (k + 1) * n); for (let i = 0; i < n; i++) w8[i * 4 + k] = plane[i]; }
    if (enc === 2) { cols.push(words); continue; }
    const out = new Int32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { const z = words[i]; acc = (acc + ((z >>> 1) ^ -(z & 1))) | 0; out[i] = acc; }
    cols.push(out);
  }
  const [latI, lonI, a, b, lenDm, way, name, gStart, cls, flags, extra, speed, glatI, glonI, restr, nameOff, nameBytes, classBytes] = cols;
  const dec = new TextDecoder();
  const names = new Array(S);
  for (let i = 0; i < S; i++) names[i] = dec.decode(nameBytes.subarray(nameOff[i], nameOff[i + 1]));
  const lat = new Float64Array(N), lon = new Float64Array(N);
  for (let i = 0; i < N; i++) { lat[i] = latI[i] / 1e6; lon[i] = lonI[i] / 1e6; }
  const glat = new Float64Array(P), glon = new Float64Array(P);
  for (let i = 0; i < P; i++) { glat[i] = glatI[i] / 1e5; glon[i] = glonI[i] / 1e5; }
  const len = new Float32Array(M);
  for (let i = 0; i < M; i++) len[i] = lenDm[i] / 10;
  const G = { N, M, P, lat, lon, a, b, len, way, name, gStart, cls, flags, extra, speed, glat, glon, names,
    classNames: dec.decode(classBytes).split(','), restrictionList: restr, K };
  prepare(G);
  return G;
}

/* ---------- preparation: adjacency, bearings, restrictions, spatial grid ---------- */
const fastBearing = (lat1, lon1, lat2, lon2) => {
  const y = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * RAD), x = lat2 - lat1;
  return (Math.atan2(y, x) / RAD + 360) % 360;
};

export function edgePoints(G, e) {
  const pts = [[G.lon[G.a[e]], G.lat[G.a[e]]]];
  for (let g = G.gStart[e]; g < G.gStart[e + 1]; g++) pts.push([G.glon[g], G.glat[g]]);
  pts.push([G.lon[G.b[e]], G.lat[G.b[e]]]);
  return pts;
}

function prepare(G) {
  const { N, M, a, b } = G;
  // directed edge d: 2e = a->b, 2e+1 = b->a. Outgoing lists by tail node (CSR).
  const deg = new Int32Array(N + 1);
  for (let e = 0; e < M; e++) { deg[a[e]]++; deg[b[e]]++; }
  const start = new Int32Array(N + 1);
  for (let v = 0; v < N; v++) start[v + 1] = start[v] + deg[v];
  const fill = start.slice(0, N);
  const adj = new Int32Array(2 * M);
  for (let e = 0; e < M; e++) { adj[fill[a[e]]++] = 2 * e; adj[fill[b[e]]++] = 2 * e + 1; }
  G.adjStart = start; G.adj = adj; G.deg = deg;

  // bearings leaving the tail and entering the head of each directed edge
  const bStart = new Float32Array(2 * M), bEnd = new Float32Array(2 * M);
  for (let e = 0; e < M; e++) {
    const g0 = G.gStart[e], g1 = G.gStart[e + 1];
    const p0 = [G.lat[a[e]], G.lon[a[e]]], pn = [G.lat[b[e]], G.lon[b[e]]];
    const p1 = g1 > g0 ? [G.glat[g0], G.glon[g0]] : pn;
    const pm = g1 > g0 ? [G.glat[g1 - 1], G.glon[g1 - 1]] : p0;
    bStart[2 * e] = fastBearing(p0[0], p0[1], p1[0], p1[1]);
    bEnd[2 * e] = fastBearing(pm[0], pm[1], pn[0], pn[1]);
    bStart[2 * e + 1] = fastBearing(pn[0], pn[1], pm[0], pm[1]);
    bEnd[2 * e + 1] = fastBearing(p1[0], p1[1], p0[0], p0[1]);
  }
  G.bStart = bStart; G.bEnd = bEnd;

  // turn restrictions by via node
  G.restr = new Map();
  const R = G.restrictionList;
  for (let i = 0; i < R.length; i += 4) {
    const v = R[i];
    if (!G.restr.has(v)) G.restr.set(v, []);
    G.restr.get(v).push([R[i + 1], R[i + 2], R[i + 3]]);
  }

  // spatial grid (cells of 0.01°) over edge bounding boxes, CSR layout
  const CELL = 0.01;
  const keysTmp = [], edgesTmp = [];
  for (let e = 0; e < M; e++) {
    let minLat = Math.min(G.lat[a[e]], G.lat[b[e]]), maxLat = Math.max(G.lat[a[e]], G.lat[b[e]]);
    let minLon = Math.min(G.lon[a[e]], G.lon[b[e]]), maxLon = Math.max(G.lon[a[e]], G.lon[b[e]]);
    for (let g = G.gStart[e]; g < G.gStart[e + 1]; g++) {
      minLat = Math.min(minLat, G.glat[g]); maxLat = Math.max(maxLat, G.glat[g]);
      minLon = Math.min(minLon, G.glon[g]); maxLon = Math.max(maxLon, G.glon[g]);
    }
    for (let y = Math.floor(minLat / CELL); y <= Math.floor(maxLat / CELL); y++) {
      for (let x = Math.floor(minLon / CELL); x <= Math.floor(maxLon / CELL); x++) { keysTmp.push(y * 100000 + x); edgesTmp.push(e); }
    }
  }
  const order = Int32Array.from(keysTmp.keys()).sort((i, j) => keysTmp[i] - keysTmp[j]);
  const cellEdges = new Int32Array(order.length);
  const cellIndex = new Map();
  for (let i = 0; i < order.length; i++) {
    cellEdges[i] = edgesTmp[order[i]];
    const k = keysTmp[order[i]];
    const r = cellIndex.get(k);
    if (r) r[1] = i + 1; else cellIndex.set(k, [i, i + 1]);
  }
  G.CELL = CELL; G.cellEdges = cellEdges; G.cellIndex = cellIndex;
  const n2 = 2 * M;
  G.gScore = new Float64Array(n2); G.prev = new Int32Array(n2); G.seen = new Int32Array(n2); G.stamp = 0;
  G.costCache = {};
}

/* ---------- profiles ---------- */
const CLASS_SPEED = {
  motorway: 110, motorway_link: 60, trunk: 90, trunk_link: 50, primary: 75, primary_link: 45, secondary: 65,
  secondary_link: 40, tertiary: 55, tertiary_link: 35, unclassified: 45, residential: 30, living_street: 15,
  service: 20, road: 35, track: 25, busway: 0, pedestrian: 0, footway: 0, path: 0, cycleway: 0, bridleway: 0, steps: 0,
};
const TRACK_SPEED = [25, 40, 35, 30, 20, 15]; // by tracktype grade (0 = unknown)
export const PROFILES = {
  car: { vehicle: true, maxKmh: 125, label: 'سيارة' },
  '4x4': { vehicle: true, maxKmh: 125, offroad: true, label: 'دفع رباعي' },
  walk: { vehicle: false, maxKmh: 5.5, label: 'مشياً' },
};

/** Travel time (s) of every directed edge for a profile; Infinity = not allowed. */
function costs(G, profileId) {
  if (G.costCache[profileId]) return G.costCache[profileId];
  const P = PROFILES[profileId];
  const c = new Float32Array(2 * G.M);
  for (let e = 0; e < G.M; e++) {
    const cname = G.classNames[G.cls[e]], f = G.flags[e], x = G.extra[e];
    const oneway = f & 3, unpaved = (f & 4) !== 0, noMotor = (f & 16) !== 0, limited = (f & 32) !== 0, noFoot = (f & 64) !== 0;
    let kmh = 0, penalty = 0;
    if (P.vehicle) {
      const base = CLASS_SPEED[cname] || 0;
      if (!noMotor && base > 0) {
        if (cname === 'track') {
          if (P.offroad) kmh = (x & 8) ? 15 : TRACK_SPEED[x & 7];
          else if (!unpaved) kmh = 30; // paved / grade1 tracks are fine for normal cars
        } else {
          kmh = G.speed[e] ? Math.min(Math.max(G.speed[e], 10) * 0.88, base * 1.25) : base;
          if (unpaved) kmh *= P.offroad ? 0.75 : (x & 8) ? 0.25 : 0.55;
        }
        if (limited) { kmh *= 0.5; penalty = 60; }
      }
    } else if (!noFoot && cname !== 'motorway' && cname !== 'motorway_link') {
      kmh = cname === 'steps' ? 3 : cname === 'trunk' ? 4 : 5;
    }
    let fw = Infinity, bw = Infinity;
    if (kmh > 0) {
      const t = (G.len[e] / (Math.min(kmh, P.maxKmh) / 3.6)) + penalty;
      fw = bw = t;
      if (P.vehicle && oneway === 1) bw = Infinity;
      if (P.vehicle && oneway === 2) fw = Infinity;
    }
    c[2 * e] = fw; c[2 * e + 1] = bw;
  }
  return (G.costCache[profileId] = c);
}
export const head = (G, d) => (d & 1 ? G.a[d >> 1] : G.b[d >> 1]);
export const tail = (G, d) => (d & 1 ? G.b[d >> 1] : G.a[d >> 1]);

function turnAllowed(G, P, dIn, dOut, v) {
  if (dOut === (dIn ^ 1)) return !P.vehicle || G.deg[v] <= 1; // U-turns only at dead ends
  if (!P.vehicle) return true;
  const rs = G.restr.get(v);
  if (!rs) return true;
  const wIn = G.way[dIn >> 1], wOut = G.way[dOut >> 1];
  let only = -1;
  for (const [fw, tw, kind] of rs) {
    if (fw !== wIn) continue;
    if (kind === 1) only = tw;
    else if (tw === wOut) return false;
  }
  return only < 0 || only === wOut;
}
function turnPenalty(G, P, dIn, dOut) {
  if (!P.vehicle) return 0;
  const ang = Math.abs(((G.bStart[dOut] - G.bEnd[dIn] + 540) % 360) - 180);
  if (ang < 30) return 0;
  const left = ((G.bStart[dOut] - G.bEnd[dIn] + 360) % 360) > 180; // drive on the right: left turns cross traffic
  return (ang > 150 ? 25 : ang > 100 ? 8 : 4) + (left ? 3 : 0);
}

/* ---------- snapping ---------- */
/**
 * Nearest edge usable by the profile within maxDist metres.
 * Returns {e, t (0..1 from node a to b by length), dist, point:[lon,lat]} or null.
 */
export function nearest(G, lat, lon, profileId = 'car', maxDist = 3000, needName = false) {
  const c = profileId ? costs(G, profileId) : null;
  const kx = 111320 * Math.cos(lat * RAD), ky = 110540;
  const cy = Math.floor(lat / G.CELL), cx = Math.floor(lon / G.CELL);
  const ringMax = Math.ceil(maxDist / (G.CELL * ky)) + 1;
  let best = null;
  const seen = new Set();
  for (let r = 0; r <= ringMax; r++) {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(y - cy), Math.abs(x - cx)) !== r) continue;
        const range = G.cellIndex.get(y * 100000 + x);
        if (!range) continue;
        for (let i = range[0]; i < range[1]; i++) {
          const e = G.cellEdges[i];
          if (seen.has(e)) continue;
          seen.add(e);
          if (c && !(c[2 * e] < Infinity) && !(c[2 * e + 1] < Infinity)) continue;
          if (needName && !G.name[e]) continue;
          const pts = edgePoints(G, e);
          let acc = 0, total = 0;
          const seg = [];
          for (let j = 1; j < pts.length; j++) { const l = Math.hypot((pts[j][0] - pts[j - 1][0]) * kx, (pts[j][1] - pts[j - 1][1]) * ky); seg.push(l); total += l; }
          for (let j = 1; j < pts.length; j++) {
            const ax = (pts[j - 1][0] - lon) * kx, ay = (pts[j - 1][1] - lat) * ky, bx = (pts[j][0] - lon) * kx, by = (pts[j][1] - lat) * ky;
            const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
            const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
            const d = Math.hypot(ax + t * dx, ay + t * dy);
            // when routing, a public road a little further away beats a private/restricted one
            const rank = d + (c && (G.flags[e] & 32) ? 250 : 0);
            if (d <= maxDist && (!best || rank < best.rank)) {
              best = { e, dist: d, rank, t: total ? (acc + t * seg[j - 1]) / total : 0,
                point: [pts[j - 1][0] + t * (pts[j][0] - pts[j - 1][0]), pts[j - 1][1] + t * (pts[j][1] - pts[j - 1][1])] };
            }
            acc += seg[j - 1];
          }
        }
      }
    }
    // a ring further out can only be closer than `best` if best is beyond that ring's inner edge
    if (best && best.rank < r * G.CELL * Math.min(kx, ky)) break;
  }
  return best;
}

/* ---------- binary heap ---------- */
class Heap {
  constructor() { this.k = new Float64Array(1 << 16); this.v = new Int32Array(1 << 16); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) { const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k; const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v; }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], topK = this.k[0];
    const n = --this.n, key = this.k[n], val = this.v[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    this.topKey = topK;
    return top;
  }
}

/* ---------- routing ---------- */
/**
 * Route between two points. Returns null if no route.
 * { coords:[[lon,lat]...], distance (m), duration (s), steps:[...], unpaved (m), track (m), snapped:{from,to} }
 */
export function route(G, from, to, profileId = 'car', { maxSnap = 3000 } = {}) {
  const P = PROFILES[profileId];
  const c = costs(G, profileId);
  const s = nearest(G, from.lat, from.lon, profileId, maxSnap);
  const t = nearest(G, to.lat, to.lon, profileId, maxSnap);
  if (!s || !t) return { error: !s ? 'start-far' : 'end-far' };
  const { gScore: g, prev, seen } = G;
  const stamp = ++G.stamp;
  const heap = new Heap();
  const vMax = P.maxKmh / 3.6;
  const tLat = t.point[1], tLon = t.point[0], kx = 111320 * Math.cos(tLat * RAD) * 0.995, ky = 110540 * 0.995;
  const h = v => Math.hypot((G.lon[v] - tLon) * kx, (G.lat[v] - tLat) * ky) / vMax;

  let best = Infinity, bestState = -2, bestFinal = -1;
  // same edge, no junction in between
  const se = s.e, te = t.e;
  if (se === te) {
    if (t.t >= s.t && c[2 * se] < Infinity) { best = (t.t - s.t) * c[2 * se]; bestFinal = 2 * se; }
    if (t.t <= s.t && c[2 * se + 1] < Infinity && (s.t - t.t) * c[2 * se + 1] < best) { best = (s.t - t.t) * c[2 * se + 1]; bestFinal = 2 * se + 1; }
    if (bestFinal >= 0) bestState = -1;
  }
  const startStates = [];
  if (c[2 * se] < Infinity) startStates.push([2 * se, (1 - s.t) * c[2 * se]]);
  if (c[2 * se + 1] < Infinity) startStates.push([2 * se + 1, s.t * c[2 * se + 1]]);
  for (const [d, cost] of startStates) { seen[d] = stamp; g[d] = cost; prev[d] = -1; heap.push(cost + h(head(G, d)), d); }

  let expanded = 0;
  while (heap.n) {
    const d = heap.pop();
    const f = heap.topKey;
    if (f >= best) break;
    const v = head(G, d);
    if (f - h(v) > g[d] + 1e-6) continue; // stale entry
    expanded++;
    // finish onto the target edge from this junction
    if (v === G.a[te] && c[2 * te] < Infinity && turnAllowed(G, P, d, 2 * te, v)) {
      const total = g[d] + turnPenalty(G, P, d, 2 * te) + t.t * c[2 * te];
      if (total < best) { best = total; bestState = d; bestFinal = 2 * te; }
    }
    if (v === G.b[te] && c[2 * te + 1] < Infinity && turnAllowed(G, P, d, 2 * te + 1, v)) {
      const total = g[d] + turnPenalty(G, P, d, 2 * te + 1) + (1 - t.t) * c[2 * te + 1];
      if (total < best) { best = total; bestState = d; bestFinal = 2 * te + 1; }
    }
    for (let k = G.adjStart[v]; k < G.adjStart[v + 1]; k++) {
      const d2 = G.adj[k];
      const c2 = c[d2];
      if (!(c2 < Infinity) || !turnAllowed(G, P, d, d2, v)) continue;
      const ng = g[d] + c2 + turnPenalty(G, P, d, d2);
      if (seen[d2] !== stamp || ng < g[d2]) {
        seen[d2] = stamp; g[d2] = ng; prev[d2] = d;
        heap.push(ng + h(head(G, d2)), d2);
      }
    }
  }
  if (bestFinal < 0) return { error: 'no-route' };

  // directed edges in order, with traversal fractions
  const seq = [];
  if (bestState !== -1) for (let d = bestState; d !== -1; d = prev[d]) seq.push(d);
  seq.reverse();
  seq.push(bestFinal);
  const q = (d, tt) => (d & 1 ? 1 - tt : tt);
  const legs = seq.map((d, i) => ({ d, from: i === 0 ? q(d, s.t) : 0, to: i === seq.length - 1 ? q(d, t.t) : 1 }));
  return buildResult(G, P, c, legs, s, t, best, expanded);
}

/* ---------- geometry + instructions ---------- */
function directedPoints(G, d) {
  const pts = edgePoints(G, d >> 1);
  return d & 1 ? pts.reverse() : pts;
}
function cutPolyline(pts, f0, f1) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot((pts[i][0] - pts[i - 1][0]) * Math.cos(pts[i][1] * RAD), pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const at = f => {
    const d = f * L;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const u = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [pts[i - 1][0] + u * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + u * (pts[i][1] - pts[i - 1][1]), i];
  };
  if (f0 <= 0 && f1 >= 1) return pts.slice();
  const [x0, y0, i0] = at(Math.max(0, f0)), [x1, y1, i1] = at(Math.min(1, f1));
  const out = [[x0, y0]];
  for (let i = i0; i < i1; i++) out.push(pts[i]);
  out.push([x1, y1]);
  return out;
}
function modifierOf(angle) {
  const a = Math.abs(angle), side = angle > 0 ? 'right' : 'left';
  if (a < 20) return 'straight';
  if (a < 60) return `slight ${side}`;
  if (a < 125) return side;
  if (a < 165) return `sharp ${side}`;
  return 'uturn';
}
const isLink = n => n.endsWith('_link');
const RANK = { motorway: 10, motorway_link: 9, trunk: 9, trunk_link: 8, primary: 8, primary_link: 7, secondary: 7, secondary_link: 6,
  tertiary: 6, tertiary_link: 5, unclassified: 5, residential: 4, road: 4, living_street: 3, service: 2, track: 2 };
const isFast = n => n === 'motorway' || n === 'trunk';

function buildResult(G, P, c, legs, s, t, total, expanded) {
  const coords = [];
  const legStart = []; // index into coords + cumulative distance/time at each leg start
  let dist = 0, time = 0, unpaved = 0, track = 0;
  const byClass = {};
  const segs = []; // [firstCoord, lastCoord, unpaved] runs, for colouring dirt sections
  const kxy = (p, q) => {
    const dLat = (q[1] - p[1]) * RAD, dLon = (q[0] - p[0]) * RAD;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(p[1] * RAD) * Math.cos(q[1] * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(x));
  };
  for (const leg of legs) {
    const pts = cutPolyline(directedPoints(G, leg.d), leg.from, leg.to);
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += kxy(pts[i - 1], pts[i]);
    legStart.push({ dist, time, at: coords.length ? coords.length - 1 : 0 });
    const first = coords.length ? coords.length - 1 : 0;
    for (let i = coords.length ? 1 : 0; i < pts.length; i++) coords.push(pts[i]);
    const e = leg.d >> 1;
    const dirt = (G.flags[e] & 4) !== 0;
    if (segs.length && segs[segs.length - 1][2] === dirt) segs[segs.length - 1][1] = coords.length - 1;
    else segs.push([first, coords.length - 1, dirt]);
    const frac = leg.to - leg.from;
    dist += l;
    time += frac * c[leg.d];
    if (G.flags[e] & 4) unpaved += l;
    const cn = G.classNames[G.cls[e]];
    if (cn === 'track') track += l;
    const bc = (byClass[cn] ||= [0, 0]);
    bc[0] += l; bc[1] += frac * c[leg.d];
  }
  // maneuvers at junctions between legs
  const steps = [];
  const nameOf = d => G.names[G.name[d >> 1]] || '';
  const clsOf = d => G.classNames[G.cls[d >> 1]];
  const round = d => (G.flags[d >> 1] & 8) !== 0;
  const rel = (dIn, dOut) => ((G.bStart[dOut] - G.bEnd[dIn] + 540) % 360) - 180;
  const optionsAt = (dIn, v) => {
    const out = [];
    for (let k = G.adjStart[v]; k < G.adjStart[v + 1]; k++) {
      const d2 = G.adj[k];
      if (d2 !== (dIn ^ 1) && c[d2] < Infinity && turnAllowed(G, P, dIn, d2, v)) out.push(d2);
    }
    return out;
  };
  steps.push({ type: 'depart', name: nameOf(legs[0].d), bearing: G.bStart[legs[0].d], legIndex: 0, location: coords[0] });
  let ring = null;
  for (let i = 1; i < legs.length; i++) {
    const dIn = legs[i - 1].d, dOut = legs[i].d, v = head(G, dIn);
    const loc = [G.lon[v], G.lat[v]];
    const opts = optionsAt(dIn, v);
    if (!round(dIn) && round(dOut)) { ring = { type: 'roundabout', exits: 0, legIndex: i, location: loc, name: '' }; continue; }
    if (round(dIn) && round(dOut)) { if (ring && opts.some(o => !round(o))) ring.exits++; continue; }
    if (round(dIn) && !round(dOut)) {
      if (ring) { ring.exits++; ring.exit = ring.exits; ring.name = nameOf(dOut); steps.push(ring); ring = null; }
      continue;
    }
    const angle = rel(dIn, dOut);
    const nIn = nameOf(dIn), nOut = nameOf(dOut);
    const renamed = nOut !== nIn;
    if (opts.length <= 1 && !renamed) continue; // no choice to make here
    if (!renamed && nIn && Math.abs(angle) < 50) continue; // the same road simply carries on
    // alternatives worth mentioning: roads of comparable class (not driveways next to a highway)
    const floor = Math.min(RANK[clsOf(dOut)] ?? 1, 4);
    const rivals = opts.filter(o => o !== dOut && (RANK[clsOf(o)] ?? 1) >= floor);
    const mod = modifierOf(angle);
    let type = null, modifier = mod;
    if (isFast(clsOf(dIn)) && isLink(clsOf(dOut))) { type = 'off ramp'; modifier = angle >= 0 ? 'slight right' : 'slight left'; }
    else if (isLink(clsOf(dIn)) && isFast(clsOf(dOut))) type = 'merge';
    else if (Math.abs(angle) >= 35) { if (rivals.length || renamed) type = mod === 'uturn' ? 'uturn' : 'turn'; }
    else {
      const close = rivals.filter(o => Math.abs(rel(dIn, o)) < 45);
      if (close.length) { type = 'fork'; modifier = angle >= rel(dIn, close[0]) ? 'slight right' : 'slight left'; }
      else if (renamed && nOut) type = 'continue';
    }
    if (!type) continue;
    steps.push({ type, modifier, name: nOut, legIndex: i, location: loc });
  }
  if (ring) { ring.exit = Math.max(1, ring.exits); steps.push(ring); }
  steps.push({ type: 'arrive', legIndex: legs.length, location: coords[coords.length - 1] });
  // distances and times between consecutive maneuvers
  const at = idx => (idx >= legs.length ? { dist, time, at: coords.length - 1 } : legStart[idx]);
  for (let i = 0; i < steps.length; i++) {
    const here = at(steps[i].legIndex), next = i + 1 < steps.length ? at(steps[i + 1].legIndex) : here;
    steps[i].distance = next.dist - here.dist;
    steps[i].duration = next.time - here.time;
    steps[i].along = here.dist;
    steps[i].coordIndex = here.at;
    delete steps[i].legIndex;
  }
  // roads used, for a short summary ("عبر ...")
  const byName = new Map();
  for (const leg of legs) {
    const n = nameOf(leg.d);
    if (!n) continue;
    byName.set(n, (byName.get(n) || 0) + G.len[leg.d >> 1] * (leg.to - leg.from));
  }
  const via = [...byName.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([n]) => n);
  return { coords, distance: dist, duration: time, steps, unpaved, track, via, byClass, segs, expanded, cost: total,
    snapped: { from: { point: s.point, dist: s.dist }, to: { point: t.point, dist: t.dist } } };
}

/** Road at a point (for "what's here"): name, class, surface, limit. */
export function roadAt(G, lat, lon, maxDist = 150) {
  const n = nearest(G, lat, lon, null, maxDist);
  if (!n) return null;
  const e = n.e;
  const named = G.name[e] ? n : nearest(G, lat, lon, null, maxDist, true);
  return {
    name: named ? G.names[G.name[named.e]] : '',
    cls: G.classNames[G.cls[e]], unpaved: (G.flags[e] & 4) !== 0, oneway: (G.flags[e] & 3) !== 0,
    maxspeed: G.speed[e] || null, grade: G.extra[e] & 7, sand: (G.extra[e] & 8) !== 0, dist: n.dist,
  };
}

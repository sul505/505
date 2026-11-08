// Elevation from the terrain tiles (Terrarium-encoded WebP, served by the service worker).
import { BASE } from './style.js';
import { pointAlong } from './geo.js';

const RAD = Math.PI / 180;
const MAX_Z = 12;
const cache = new Map();

function decodeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function tile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
  const p = (async () => {
    const res = await fetch(`${BASE}tiles/terrain/${z}/${x}/${y}.webp`);
    if (res.status !== 200) return null;
    const bmp = await createImageBitmap(await res.blob());
    const canvas = decodeCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const ele = new Float32Array(bmp.width * bmp.height);
    for (let i = 0; i < ele.length; i++) ele[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    return { w: bmp.width, h: bmp.height, ele };
  })().catch(() => null);
  cache.set(key, p);
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return p;
}

/** Elevation in metres at a point (bilinear), or null when no terrain data is available. */
export async function elevationAt(lat, lon, z = MAX_Z) {
  for (let zz = z; zz >= 6; zz--) {
    const n = 2 ** zz;
    const xf = ((lon + 180) / 360) * n;
    const yf = ((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2) * n;
    const x = Math.floor(xf), y = Math.floor(yf);
    const t = await tile(zz, x, y);
    if (!t) continue;
    const fx = Math.min(t.w - 1.001, Math.max(0, (xf - x) * t.w - 0.5)), fy = Math.min(t.h - 1.001, Math.max(0, (yf - y) * t.h - 0.5));
    const ix = Math.floor(fx), iy = Math.floor(fy), dx = fx - ix, dy = fy - iy;
    const at = (i, j) => t.ele[j * t.w + i];
    const v = at(ix, iy) * (1 - dx) * (1 - dy) + at(ix + 1, iy) * dx * (1 - dy) + at(ix, iy + 1) * (1 - dx) * dy + at(ix + 1, iy + 1) * dx * dy;
    return Math.round(v * 10) / 10;
  }
  return null;
}

/** Elevation profile along a [lon, lat] line: [{d, ele}], plus ascent/descent totals. */
export async function profile(coords, cum, samples = 160) {
  const total = cum[cum.length - 1];
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const d = (total * i) / samples;
    const [lon, lat] = pointAlong(coords, cum, d);
    out.push({ d, ele: await elevationAt(lat, lon) });
  }
  const vals = out.filter(p => p.ele != null);
  if (vals.length < 2) return null;
  let up = 0, down = 0;
  for (let i = 1; i < vals.length; i++) {
    const diff = vals[i].ele - vals[i - 1].ele;
    if (diff > 0) up += diff; else down -= diff;
  }
  return { points: out, up, down, min: Math.min(...vals.map(p => p.ele)), max: Math.max(...vals.map(p => p.ele)) };
}

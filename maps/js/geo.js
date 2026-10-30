// Geodesy and formatting helpers.
export const R = 6371008.8;
export const RAD = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export function destination(lat, lon, brg, dist) {
  const d = dist / R, b = brg * RAD, p1 = lat * RAD, l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / RAD, ((l2 / RAD + 540) % 360) - 180];
}

/** Smallest signed difference between two bearings (degrees, -180..180). */
export const angleDiff = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

/** Length of a [lon, lat] polyline in metres. */
export function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return d;
}

/**
 * Closest point on a [lon, lat] polyline to (lat, lon).
 * Returns {dist, index (segment), t, along (metres from start), point:[lon,lat], bearing}.
 */
export function snapToLine(coords, lat, lon, cum) {
  const kx = 111320 * Math.cos(lat * RAD), ky = 110540;
  let best = null, along = 0;
  for (let i = 1; i < coords.length; i++) {
    const [ax0, ay0] = coords[i - 1], [bx0, by0] = coords[i];
    const ax = (ax0 - lon) * kx, ay = (ay0 - lat) * ky, bx = (bx0 - lon) * kx, by = (by0 - lat) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    const segLen = cum ? cum[i] - cum[i - 1] : Math.sqrt(l2);
    if (!best || d < best.dist) {
      best = { dist: d, index: i - 1, t, along: (cum ? cum[i - 1] : along) + t * segLen,
        point: [ax0 + t * (bx0 - ax0), ay0 + t * (by0 - ay0)], bearing: bearing(ay0, ax0, by0, bx0) };
    }
    along += segLen;
  }
  return best;
}

/** Cumulative distances along a [lon, lat] polyline. */
export function cumulative(coords) {
  const c = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) c[i] = c[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return c;
}

/** Point at a distance along a polyline with cumulative distances. */
export function pointAlong(coords, cum, d) {
  if (d <= 0) return coords[0];
  let lo = 0, hi = cum.length - 1;
  if (d >= cum[hi]) return coords[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return [coords[lo][0] + t * (coords[hi][0] - coords[lo][0]), coords[lo][1] + t * (coords[hi][1] - coords[lo][1])];
}

/** Polygon area (m²) of a [lon, lat] ring, spherical excess approximation. */
export function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[i][0] - ring[j][0]) * RAD * (2 + Math.sin(ring[j][1] * RAD) + Math.sin(ring[i][1] * RAD));
  }
  return Math.abs((s * R * R) / 2);
}

export function pointInRing(lon, lat, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** A circle polygon ([lon, lat] ring) around a point, for accuracy rings. */
export function circle(lat, lon, radius, steps = 48) {
  const ring = [];
  for (let i = 0; i <= steps; i++) { const [la, lo] = destination(lat, lon, (360 * i) / steps, radius); ring.push([lo, la]); }
  return ring;
}

/* ---------- formatting (Arabic) ---------- */
export const nf = new Intl.NumberFormat('ar', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('ar', { maximumFractionDigits: 0 });
export function fmtDist(m) {
  if (m < 50) return `${nf0.format(Math.round(m))} م`;
  if (m < 1000) return `${nf0.format(Math.round(m / 10) * 10)} م`;
  if (m < 100000) return `${nf.format(m / 1000)} كم`;
  return `${nf0.format(m / 1000)} كم`;
}
export function fmtDur(s) {
  const mins = Math.max(1, Math.round(s / 60));
  if (mins < 60) return `${nf0.format(mins)} د`;
  const h = Math.floor(mins / 60), r = mins % 60;
  return r ? `${nf0.format(h)} س ${nf0.format(r)} د` : `${nf0.format(h)} س`;
}
export function fmtDurLong(s) {
  const mins = Math.max(1, Math.round(s / 60));
  if (mins < 60) return `${nf0.format(mins)} دقيقة`;
  const h = Math.floor(mins / 60), r = mins % 60;
  return `${nf0.format(h)} ساعة${r ? ` و${nf0.format(r)} دقيقة` : ''}`;
}
export const fmtSpeed = kmh => `${nf0.format(Math.round(kmh))} كم/س`;
export const fmtNum = (v, digits = 0) => new Intl.NumberFormat('ar', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
export const omanTime = (ms, opts = { hour: 'numeric', minute: '2-digit' }) => new Intl.DateTimeFormat('ar-OM', { timeZone: 'Asia/Muscat', ...opts }).format(new Date(ms));

export function dms(v, pos, neg) {
  const t = Math.round(Math.abs(v) * 36000);
  const d = Math.floor(t / 36000), m = Math.floor((t % 36000) / 600), s = (t % 600) / 10;
  return `${d}° ${String(m).padStart(2, '0')}′ ${s.toFixed(1).padStart(4, '0')}″ ${v >= 0 ? pos : neg}`;
}
export const fmtDMS = (lat, lon) => `${dms(lat, 'N', 'S')}  ${dms(lon, 'E', 'W')}`;
export const fmtDD = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
export function fmtDDM(lat, lon) {
  const one = (v, p, n) => { const a = Math.abs(v), d = Math.floor(a); return `${d}° ${((a - d) * 60).toFixed(3)}′ ${v >= 0 ? p : n}`; };
  return `${one(lat, 'N', 'S')}  ${one(lon, 'E', 'W')}`;
}

/** WGS84 -> UTM. */
export function toUTM(lat, lon) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * RAD;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = lat * RAD, lam = lon * RAD;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lon0);
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const easting = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing = k0 * (M + N * Math.tan(phi) * (A * A / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;
  const bands = 'CDEFGHJKLMNPQRSTUVWX';
  const band = bands[Math.max(0, Math.min(19, Math.floor((lat + 80) / 8)))];
  return { zone, band, easting, northing };
}
export function fmtUTM(lat, lon) {
  const u = toUTM(lat, lon);
  return `${u.zone}${u.band} ${Math.round(u.easting)}E ${Math.round(u.northing)}N`;
}
/** MGRS from UTM (1 m precision). */
export function fmtMGRS(lat, lon) {
  const u = toUTM(lat, lon);
  const setNo = ((u.zone - 1) % 6) + 1;
  const colLetters = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][(setNo - 1) % 3];
  const rowLetters = 'ABCDEFGHJKLMNPQRSTUV';
  const col = colLetters[Math.floor(u.easting / 100000) - 1];
  const rowOffset = setNo % 2 === 0 ? 5 : 0;
  const row = rowLetters[(Math.floor(u.northing / 100000) + rowOffset) % 20];
  const e = String(Math.floor(u.easting % 100000)).padStart(5, '0');
  const n = String(Math.floor(u.northing % 100000)).padStart(5, '0');
  return `${u.zone}${u.band} ${col}${row} ${e} ${n}`;
}

/** Parse typed coordinates: "23.58, 58.41", "23°35'N 58°24'E", "N23 35.1 E58 24.6". */
export function parseCoords(text) {
  const s = text.trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/،/g, ',');
  let m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s);
  if (m) {
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  const parts = [...s.matchAll(/([NSEW])?\s*(\d{1,3})(?:[°\s]+(\d{1,2}(?:\.\d+)?))?(?:['′\s]+(\d{1,2}(?:\.\d+)?))?["″]?\s*([NSEW])?/gi)]
    .filter(p => p[0].trim().length > 1);
  if (parts.length === 2) {
    const val = p => (+p[2] + (p[3] ? +p[3] / 60 : 0) + (p[4] ? +p[4] / 3600 : 0)) * (/[SW]/i.test((p[1] || '') + (p[5] || '')) ? -1 : 1);
    let lat = val(parts[0]), lon = val(parts[1]);
    const h0 = ((parts[0][1] || '') + (parts[0][5] || '')).toUpperCase();
    if (/[EW]/.test(h0)) [lat, lon] = [lon, lat];
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

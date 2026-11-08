// Tide prediction from harmonic constants.
// Uses exactly the same astronomical arguments and nodal corrections as maps/tools/tides.py,
// which produced the constants, so the phases are self-consistent.
const RAD = Math.PI / 180;

const julian = ms => ms / 86400000 + 2440587.5;

function angles(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const s = 218.3164591 + 481267.88134236 * T;
  const h = 280.4664567 + 36000.76982779 * T;
  const p = 83.3532430 + 4069.0137111 * T;
  const N = 125.0445550 - 1934.1361849 * T;
  const pp = 282.9373481 + 1.7195366 * T;
  const hours = (((jd + 0.5) % 1) + 1) % 1 * 24;
  const tau = 15 * hours + h - s;
  return [tau, s, h, p, -N, pp, N];
}

function nodal(N) {
  const n = N * RAD;
  const c1 = Math.cos(n), c2 = Math.cos(2 * n), c3 = Math.cos(3 * n);
  const s1 = Math.sin(n), s2 = Math.sin(2 * n), s3 = Math.sin(3 * n);
  const M2 = [1.0004 - 0.0373 * c1 + 0.0002 * c2, -2.14 * s1];
  const K1 = [1.0060 + 0.1150 * c1 - 0.0088 * c2 + 0.0006 * c3, -8.86 * s1 + 0.68 * s2 - 0.07 * s3];
  const O1 = [1.0089 + 0.1871 * c1 - 0.0147 * c2 + 0.0014 * c3, 10.80 * s1 - 1.34 * s2 + 0.19 * s3];
  return {
    null: [1, 0], M2, K1, O1,
    K2: [1.0241 + 0.2863 * c1 + 0.0083 * c2 - 0.0015 * c3, -17.74 * s1 + 0.68 * s2 - 0.04 * s3],
    Mf: [1.0429 + 0.4135 * c1 - 0.0040 * c2, -23.74 * s1 + 2.68 * s2 - 0.38 * s3],
    Mm: [1.0000 - 0.1300 * c1 + 0.0013 * c2, 0],
    J1: [1.0129 + 0.1676 * c1 - 0.0170 * c2 + 0.0016 * c3, -12.94 * s1 + 1.34 * s2 - 0.19 * s3],
    OO1: [1.1027 + 0.6504 * c1 + 0.0317 * c2 - 0.0014 * c3, -36.68 * s1 + 4.02 * s2 - 0.57 * s3],
    MSf: [M2[0], -M2[1]],
    M3: [M2[0] ** 1.5, 1.5 * M2[1]], M4: [M2[0] ** 2, 2 * M2[1]], M6: [M2[0] ** 3, 3 * M2[1]], M8: [M2[0] ** 4, 4 * M2[1]],
    MK3: [M2[0] * K1[0], M2[1] + K1[1]], MO3: [M2[0] * O1[0], M2[1] + O1[1]],
  };
}

/**
 * Compile a station for fast evaluation over a time window: nodal factors are taken at the
 * window centre (they drift < 0.2% over a month).
 */
export function compile(station, table, centreMs) {
  const [, , , , , , N] = angles(julian(centreMs));
  const nod = nodal(N);
  const terms = [];
  for (const [name, [amp, g]] of Object.entries(station.cons)) {
    const [d, off, grp] = table[name];
    const [f, u] = nod[grp ?? 'null'];
    terms.push({ d, k: off + u - g, a: f * amp });
  }
  return { z0: station.z0, terms };
}

/** Height above LAT (metres) at time ms (epoch milliseconds, UTC). */
export function height(compiled, ms) {
  const [tau, s, h, p, nN, pp] = angles(julian(ms));
  let y = compiled.z0;
  for (const { d, k, a } of compiled.terms) {
    const V = d[0] * tau + d[1] * s + d[2] * h + d[3] * p + d[4] * nN + d[5] * pp;
    y += a * Math.cos((V + k) * RAD);
  }
  return y;
}

/** Sampled curve between two times. */
export function curve(station, table, startMs, endMs, stepMin = 10) {
  const c = compile(station, table, (startMs + endMs) / 2);
  const out = [];
  for (let t = startMs; t <= endMs; t += stepMin * 60000) out.push([t, height(c, t)]);
  return out;
}

/** High and low waters between two times: [{t, h, high}] with ~1 minute precision. */
export function extremes(station, table, startMs, endMs) {
  const c = compile(station, table, (startMs + endMs) / 2);
  const step = 6 * 60000;
  const out = [];
  let t0 = startMs - step, y0 = height(c, t0), t1 = startMs, y1 = height(c, t1);
  for (let t2 = startMs + step; t2 <= endMs + step; t2 += step) {
    const y2 = height(c, t2);
    const high = y1 > y0 && y1 >= y2, low = y1 < y0 && y1 <= y2;
    if (high || low) {
      const den = y0 - 2 * y1 + y2;
      const off = den ? (0.5 * (y0 - y2)) / den : 0;
      const t = t1 + off * step;
      if (t >= startMs && t <= endMs) out.push({ t, h: height(c, t), high });
    }
    t0 = t1; y0 = y1; t1 = t2; y1 = y2;
  }
  return out;
}

/** Nearest station to a point, with distance in km. */
export function nearestStation(stations, lat, lon) {
  let best = null;
  for (const s of stations) {
    const dLat = (s.lat - lat) * RAD, dLon = (s.lon - lon) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * RAD) * Math.cos(s.lat * RAD) * Math.sin(dLon / 2) ** 2;
    const km = 12742 * Math.asin(Math.sqrt(a));
    if (!best || km < best.km) best = { station: s, km };
  }
  return best;
}

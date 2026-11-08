// Sun and moon times (algorithms after SunCalc by Vladimir Agafonkin, BSD-2-Clause).
const RAD = Math.PI / 180, DAY = 86400000, J1970 = 2440588, J2000 = 2451545, E = RAD * 23.4397;
const toDays = ms => ms / DAY - 0.5 + J1970 - J2000;
const fromJulian = j => (j + 0.5 - J1970) * DAY;
const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l));
const solarMeanAnomaly = d => RAD * (357.5291 + 0.98560028 * d);
function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
}
const J0 = 0.0009;
const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h, phi, d) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));

/** Sun events for the day containing `ms` at (lat, lon): epoch ms values (NaN when the event doesn't happen). */
export function sunTimes(ms, lat, lon) {
  const lw = RAD * -lon, phi = RAD * lat, d = toDays(ms);
  const n = julianCycle(d, lw), ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);
  const at = angle => {
    const w = hourAngle(angle * RAD, phi, dec);
    const Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
    return [fromJulian(Jnoon - (Jset - Jnoon)), fromJulian(Jset)];
  };
  const [sunrise, sunset] = at(-0.833), [dawn, dusk] = at(-6), [nightEnd, night] = at(-18);
  return { solarNoon: fromJulian(Jnoon), sunrise, sunset, dawn, dusk, nightEnd, night };
}

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.229350 * d);
  const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F), dt = 385001 - 20905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

/** Moon illumination: fraction lit (0..1) and phase (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter). */
export function moonPhase(ms) {
  const d = toDays(ms);
  const M = solarMeanAnomaly(d), L = eclipticLongitude(M);
  const s = { ra: rightAscension(L, 0), dec: declination(L, 0) }, m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI };
}

export function moonPhaseName(phase) {
  const names = ['محاق', 'هلال متزايد', 'تربيع أول', 'أحدب متزايد', 'بدر', 'أحدب متناقص', 'تربيع أخير', 'هلال متناقص'];
  return names[Math.round(phase * 8) % 8];
}

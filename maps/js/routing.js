// Route planning on the main thread: worker client, multi-stop routes, Arabic instructions and icons.
import { fmtDist, haversine } from './geo.js';

const worker = new Worker(new URL('./router-worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.ok) p.resolve(data.result); else p.reject(new Error(data.error));
};
export const call = (type, args) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, args });
});

export const PROFILE_LABEL = { car: 'سيارة', '4x4': 'دفع رباعي', walk: 'مشياً' };
const MAX_SNAP = { car: 5000, '4x4': 30000, walk: 30000 };

/**
 * Route through points [{lat, lon, name}] (2 or more). Off-road gaps between a point and the
 * nearest usable road are returned separately so they can be drawn dashed.
 */
export async function planRoute(points, profile) {
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const r = await call('route', { from: points[i], to: points[i + 1], profile, maxSnap: MAX_SNAP[profile] });
    if (r.error) return { error: r.error, leg: i };
    legs.push(r);
  }
  const coords = [], steps = [], offroad = [], segs = [];
  let distance = 0, duration = 0, unpaved = 0, track = 0;
  const byClass = {};
  legs.forEach((r, i) => {
    const base = distance, baseIdx = coords.length ? coords.length - 1 : 0;
    // walking/driving the bit between a point and the road it snapped to
    const gapFrom = r.snapped.from.dist, gapTo = r.snapped.to.dist;
    if (gapFrom > 25) offroad.push([[points[i].lon, points[i].lat], r.snapped.from.point]);
    if (gapTo > 25) offroad.push([r.snapped.to.point, [points[i + 1].lon, points[i + 1].lat]]);
    for (const [a, b, dirt] of r.segs) segs.push([a + baseIdx, b + baseIdx, dirt]);
    for (let k = coords.length ? 1 : 0; k < r.coords.length; k++) coords.push(r.coords[k]);
    for (const s of r.steps) {
      if (s.type === 'depart' && i > 0) continue;
      const step = { ...s, along: s.along + base, coordIndex: s.coordIndex + baseIdx };
      if (s.type === 'arrive' && i + 1 < legs.length) { step.type = 'waypoint'; step.name = points[i + 1].name || ''; }
      steps.push(step);
    }
    distance += r.distance; duration += r.duration; unpaved += r.unpaved; track += r.track;
    for (const [k, [m, s]] of Object.entries(r.byClass)) { byClass[k] ||= [0, 0]; byClass[k][0] += m; byClass[k][1] += s; }
  });
  const offDist = offroad.reduce((s, [a, b]) => s + haversine(a[1], a[0], b[1], b[0]), 0);
  return { coords, steps, segs, distance, duration, unpaved, track, byClass, offroad, offroadDistance: offDist, via: legs[0]?.via || [], profile };
}

/* ---------- Arabic instructions ---------- */
const SIDE = { left: 'يساراً', right: 'يميناً', 'slight left': 'قليلاً إلى اليسار', 'slight right': 'قليلاً إلى اليمين',
  'sharp left': 'بحدة إلى اليسار', 'sharp right': 'بحدة إلى اليمين' };
const ORD = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن'];
const COMPASS = ['الشمال', 'الشمال الشرقي', 'الشرق', 'الجنوب الشرقي', 'الجنوب', 'الجنوب الغربي', 'الغرب', 'الشمال الغربي'];
export const compassWord = b => COMPASS[Math.round(((b % 360) + 360) % 360 / 45) % 8];

export function instruction(s) {
  const onto = s.name ? ` إلى ${s.name}` : '';
  switch (s.type) {
    case 'depart': return `انطلق باتجاه ${compassWord(s.bearing || 0)}${s.name ? ` على ${s.name}` : ''}`;
    case 'arrive': return 'وصلت إلى وجهتك';
    case 'waypoint': return `وصلت إلى نقطة التوقف${s.name ? `: ${s.name}` : ''}`;
    case 'roundabout': return `عند الدوار، اسلك المخرج ${ORD[(s.exit || 1) - 1] || s.exit}${onto}`;
    case 'uturn': return `استدر للخلف${onto}`;
    case 'off ramp': return `اسلك المخرج على ${s.modifier?.includes('left') ? 'اليسار' : 'اليمين'}${onto}`;
    case 'merge': return `اندمج في${s.name ? ` ${s.name}` : ' الطريق'}`;
    case 'fork': return `التزم بالمسار ${s.modifier?.includes('left') ? 'الأيسر' : 'الأيمن'}${s.name ? ` نحو ${s.name}` : ''}`;
    case 'continue': return `تابع مستقيماً${s.name ? ` على ${s.name}` : ''}`;
    default: return `انعطف ${SIDE[s.modifier] || ''}${onto}`.replace('  ', ' ');
  }
}

export function spoken(s, distance) {
  const text = instruction(s);
  if (distance == null || distance < 40 || s.type === 'arrive') return text;
  return `بعد ${fmtDist(Math.round(distance / 10) * 10)}، ${text}`;
}

/* ---------- maneuver arrows ---------- */
const ARROWS = {
  straight: 'M12 21V5m0 0-5 5m5-5 5 5',
  'slight right': 'M9 21v-7l7-7m0 0h-5m5 0v5',
  right: 'M8 21v-8a4 4 0 0 1 4-4h7m0 0-4-4m4 4-4 4',
  'sharp right': 'M8 4v9a4 4 0 0 0 4 4h4m0 0-3-3m3 3-3 3',
  uturn: 'M16 21V9a5 5 0 0 0-10 0v6m0 0-3-3m3 3 3-3',
  arrive: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zm0-9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  roundabout: 'M12 21v-6m0 0a4 4 0 1 1 3.5-2M15.5 13l4.5-4m0 0h-4m4 0v4',
  depart: 'M12 3l7 18-7-4-7 4 7-18z',
};
export function maneuverIcon(s, size = 34) {
  let key = 'straight', flip = false;
  const m = s.modifier || '';
  if (s.type === 'arrive' || s.type === 'waypoint') key = 'arrive';
  else if (s.type === 'depart') key = 'depart';
  else if (s.type === 'roundabout') key = 'roundabout';
  else if (s.type === 'uturn' || m === 'uturn') key = 'uturn';
  else if (m.includes('sharp')) key = 'sharp right';
  else if (m.includes('slight') || s.type === 'fork' || s.type === 'off ramp') key = m.includes('left') || m.includes('right') ? 'slight right' : 'straight';
  else if (m === 'left' || m === 'right') key = 'right';
  if (m.includes('left')) flip = true;
  if (key === 'uturn') flip = false;
  const fill = key === 'arrive' || key === 'depart';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" style="${flip ? 'transform:scaleX(-1)' : ''}"><path d="${ARROWS[key]}" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${fill ? 0 : 2.4}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

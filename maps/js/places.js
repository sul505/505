// Offline "what's here": wilayat / governorate from boundaries, nearest settlement, nearest road.
import { pointInRing } from './geo.js';

export class AdminIndex {
  constructor(areas) {
    this.areas = areas.map(a => {
      let minX = 180, minY = 90, maxX = -180, maxY = -90;
      for (const ring of a.polys) for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      return { ...a, bbox: [minX, minY, maxX, maxY] };
    });
  }
  locate(lat, lon) {
    const out = {};
    for (const a of this.areas) {
      const [x0, y0, x1, y1] = a.bbox;
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      if (a.polys.some(r => pointInRing(lon, lat, r))) out[a.level === 4 ? 'governorate' : 'wilayat'] = a.ar || a.en;
    }
    return out;
  }
}

/** A readable place line: "قرب نزوى · ولاية نزوى · محافظة الداخلية". */
export function placeLine({ near, admin, road }) {
  const parts = [];
  if (road?.name) parts.push(road.name);
  if (near) parts.push(`${near.dist < 1500 ? 'في' : 'قرب'} ${near.ar || near.en}`);
  if (admin?.wilayat && !(near && admin.wilayat.endsWith(near.ar))) parts.push(admin.wilayat);
  if (admin?.governorate) parts.push(admin.governorate.startsWith('محافظة') ? admin.governorate : `محافظة ${admin.governorate}`);
  return parts.join(' · ');
}

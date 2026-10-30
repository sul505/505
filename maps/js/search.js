// Offline place search over data/oman-places.json (built from OpenStreetMap).
import { haversine } from './geo.js';

export const KIND_AR = {
  city: 'مدينة', town: 'بلدة', village: 'قرية', hamlet: 'تجمع سكني', suburb: 'حي', locality: 'منطقة', island: 'جزيرة',
  peak: 'جبل', saddle: 'عقبة جبلية', spring: 'عين ماء', cave: 'كهف', beach: 'شاطئ', bay: 'خليج / رأس', dune: 'رمال وكثبان',
  valley: 'وادٍ', wadi: 'وادي', oasis: 'واحة', cliff: 'جرف / سلسلة جبلية', reef: 'شعاب', water: 'مسطح مائي', fort: 'قلعة / حصن',
  ruins: 'آثار', monument: 'نصب تذكاري', museum: 'متحف', viewpoint: 'إطلالة', attraction: 'معلم سياحي', camp: 'مخيم / استراحة',
  hotel: 'فندق / نزل', airport: 'مطار', port: 'ميناء / مرسى', fuel: 'محطة وقود', hospital: 'مستشفى', clinic: 'مركز صحي',
  pharmacy: 'صيدلية', police: 'شرطة', fire: 'دفاع مدني', water_point: 'مياه شرب', mosque: 'مسجد', school: 'مدرسة / جامعة',
  bank: 'بنك / صراف', food: 'مطعم / مقهى', shop: 'متجر', car: 'خدمات سيارات', gov: 'جهة حكومية', park: 'حديقة / محمية',
  sport: 'ملعب / رياضة', bus: 'محطة حافلات', lighthouse: 'منارة', toilets: 'دورات مياه', parking: 'موقف سيارات', road: 'طريق',
};
// extra words people type for a kind
const KIND_WORDS = {
  fort: 'قلعه حصن قلاع', fuel: 'بنزين محطه وقود بترول', hospital: 'مستشفي', mosque: 'جامع مسجد', peak: 'جبل قمه', wadi: 'وادي',
  valley: 'وادي', beach: 'شاطي بحر', food: 'مطعم مقهي كافيه', hotel: 'فندق نزل منتجع', camp: 'مخيم استراحه', road: 'شارع طريق',
  water_point: 'ماء مياه', spring: 'عين فلج', shop: 'سوق متجر سوبرماركت', airport: 'مطار', port: 'ميناء مرسي',
};
const KIND_WEIGHT = { city: 14, town: 11, airport: 10, suburb: 7, village: 7, fort: 6, island: 6, peak: 5, wadi: 5, valley: 5, hospital: 5,
  attraction: 5, viewpoint: 4, beach: 4, road: 4, hamlet: 3, locality: 3, fuel: 3, museum: 4, port: 4 };

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
export function norm(s) {
  return (s || '').toLowerCase().replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[’'’`ʿʾ‘]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
// "السيب" also answers "سيب"; "al seeb" answers "seeb"
const stripAl = t => (t.startsWith('ال') && t.length > 3 ? t.slice(2) : t);

export class PlaceIndex {
  constructor(data) {
    this.kinds = data.kinds;
    this.items = data.items.map(([ar, en, k, lat, lon, ele, near]) => ({ ar, en, kind: data.kinds[k], lat: lat / 1e5, lon: lon / 1e5, ele, near }));
    for (const it of this.items) {
      const near = it.near >= 0 ? this.items[it.near] : null;
      it.nearName = near ? (near.ar || near.en) : '';
      const name = norm(`${it.ar} ${it.en}`);
      it.tokens = name.split(' ').filter(Boolean);
      it.tokens2 = it.tokens.map(stripAl);
      it.nameNorm = name;
      it.kindNorm = norm(`${KIND_AR[it.kind] || ''} ${KIND_WORDS[it.kind] || ''}`).split(' ');
      it.nearNorm = norm(it.nearName).split(' ').filter(Boolean).map(stripAl);
    }
  }

  search(query, { lat, lon, limit = 12 } = {}) {
    const q = norm(query);
    if (!q) return [];
    const qt = q.split(' ').map(stripAl).filter(Boolean);
    const out = [];
    for (const it of this.items) {
      let score = 0, ok = true, nameHits = 0, kindHit = false, nearHit = false;
      for (const t of qt) {
        let s = 0;
        for (let i = 0; i < it.tokens2.length; i++) {
          const w = it.tokens2[i];
          if (w === t) { s = Math.max(s, 10); }
          else if (w.startsWith(t)) s = Math.max(s, t.length >= 3 ? 7 : 4);
          else if (t.length >= 4 && it.tokens[i].includes(t)) s = Math.max(s, 3);
        }
        if (s) nameHits++;
        else if (it.kindNorm.some(w => w.startsWith(t) && t.length >= 2)) { s = 3; kindHit = true; }
        else if (it.nearNorm.some(w => w === t || (t.length >= 3 && w.startsWith(t)))) { s = 2; nearHit = true; }
        if (!s) { ok = false; break; }
        score += s;
      }
      // "قلعة نزوى" may match a fort named only in English near Nizwa: kind + town together
      if (!ok || !(nameHits || (kindHit && nearHit))) continue;
      if (it.nameNorm === q) score += 25;
      else if (it.nameNorm.startsWith(q)) score += 8;
      score += KIND_WEIGHT[it.kind] || 1;
      if (lat != null) score += 8 * Math.exp(-haversine(lat, lon, it.lat, it.lon) / 40000);
      out.push([score, it]);
    }
    out.sort((a, b) => b[0] - a[0]);
    return out.slice(0, limit).map(([score, it]) => ({ ...it, score }));
  }

  /** Nearest settlement/feature to a point among the given kinds. */
  nearest(lat, lon, kinds, maxKm = 30) {
    let best = null;
    for (const it of this.items) {
      if (kinds && !kinds.includes(it.kind)) continue;
      if (Math.abs(it.lat - lat) > maxKm / 100 || Math.abs(it.lon - lon) > maxKm / 100) continue;
      const d = haversine(lat, lon, it.lat, it.lon);
      if (d <= maxKm * 1000 && (!best || d < best.dist)) best = { ...it, dist: d };
    }
    return best;
  }

  byKind(kind) { return this.items.filter(it => it.kind === kind); }
}

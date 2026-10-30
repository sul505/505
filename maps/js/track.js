// Track recording, saved tracks/waypoints, and GPX import/export.
import './db-core.js';
import { haversine, esc } from './geo.js';

const DB = self.OmanDB;

export class Recorder {
  constructor() { this.reset(); }
  reset() {
    this.points = []; // [lon, lat, ele, time]
    this.distance = 0; this.moving = 0; this.maxSpeed = 0; this.ascent = 0; this.descent = 0;
    this.started = null; this.paused = false; this.lastEle = null;
  }
  get active() { return this.started != null; }
  start() { this.reset(); this.started = Date.now(); }
  add(pos) {
    if (!this.active || this.paused || (pos.acc && pos.acc > 50)) return false;
    const last = this.points[this.points.length - 1];
    const ele = pos.alt;
    if (last) {
      const d = haversine(last[1], last[0], pos.lat, pos.lon);
      if (d < Math.max(3, (pos.acc || 10) * 0.5)) return false;
      this.distance += d;
      const dt = (pos.time - last[3]) / 1000;
      if (dt > 0 && dt < 120 && d / dt > 0.5) this.moving += dt;
    }
    this.maxSpeed = Math.max(this.maxSpeed, pos.speed || 0);
    if (ele != null) {
      if (this.lastEle != null) { const diff = ele - this.lastEle; if (Math.abs(diff) >= 3) { if (diff > 0) this.ascent += diff; else this.descent -= diff; this.lastEle = ele; } }
      else this.lastEle = ele;
    }
    this.points.push([pos.lon, pos.lat, ele, pos.time]);
    return true;
  }
  stop() { const t = this.snapshot(); this.started = null; return t; }
  snapshot() {
    return { id: `t${this.started}`, name: new Date(this.started).toLocaleString('ar-OM'), started: this.started, ended: Date.now(),
      points: this.points.slice(), distance: this.distance, moving: this.moving, maxSpeed: this.maxSpeed, ascent: this.ascent, descent: this.descent };
  }
}

/* ---------- storage ---------- */
const getList = async key => (await DB.get('kv', key)) || [];
export async function listTracks() { return getList('tracks'); }
export async function saveTrack(t) {
  await DB.put('kv', t, `track:${t.id}`);
  const list = (await getList('tracks')).filter(x => x.id !== t.id);
  list.unshift({ id: t.id, name: t.name, started: t.started, distance: t.distance, points: t.points.length, imported: !!t.imported });
  await DB.put('kv', list, 'tracks');
}
export const loadTrack = id => DB.get('kv', `track:${id}`);
export async function deleteTrack(id) {
  await DB.del('kv', `track:${id}`);
  await DB.put('kv', (await getList('tracks')).filter(x => x.id !== id), 'tracks');
}
export const listWaypoints = () => getList('waypoints');
export async function saveWaypoints(list) { await DB.put('kv', list, 'waypoints'); }

/* ---------- GPX ---------- */
const iso = t => new Date(t).toISOString();
export function toGPX({ name = 'خرائط عُمان', tracks = [], waypoints = [], routes = [] }) {
  const pt = (tag, p) => `<${tag} lat="${p[1].toFixed(7)}" lon="${p[0].toFixed(7)}">${p[2] != null ? `<ele>${(+p[2]).toFixed(1)}</ele>` : ''}${p[3] ? `<time>${iso(p[3])}</time>` : ''}${p[4] ? `<name>${esc(p[4])}</name>` : ''}</${tag}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Oman Offline Maps" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name><time>${iso(Date.now())}</time></metadata>
${waypoints.map(w => pt('wpt', [w.lon, w.lat, w.ele, null, w.name])).join('\n')}
${routes.map(r => `<rte><name>${esc(r.name || '')}</name>${r.points.map(p => pt('rtept', p)).join('')}</rte>`).join('\n')}
${tracks.map(t => `<trk><name>${esc(t.name || '')}</name><trkseg>${t.points.map(p => pt('trkpt', p)).join('')}</trkseg></trk>`).join('\n')}
</gpx>`;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('ملف GPX غير صالح');
  const num = (el, tag) => { const v = el.getElementsByTagName(tag)[0]?.textContent; return v != null && v !== '' ? +v : null; };
  const txt = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
  const point = el => [+el.getAttribute('lon'), +el.getAttribute('lat'), num(el, 'ele'), Date.parse(txt(el, 'time')) || null];
  const tracks = [...doc.getElementsByTagName('trk')].map(t => ({ name: txt(t, 'name'), points: [...t.getElementsByTagName('trkpt')].map(point) }));
  const routes = [...doc.getElementsByTagName('rte')].map(r => ({ name: txt(r, 'name'), points: [...r.getElementsByTagName('rtept')].map(point) }));
  const waypoints = [...doc.getElementsByTagName('wpt')].map(w => ({ name: txt(w, 'name'), lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon'), ele: num(w, 'ele') }));
  return { tracks: tracks.filter(t => t.points.length), routes: routes.filter(r => r.points.length), waypoints };
}

export function download(filename, text, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

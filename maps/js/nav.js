// Live turn-by-turn guidance along a planned route, and speed-camera warnings.
import { snapToLine, cumulative, haversine, bearing, angleDiff, fmtDist, fmtNum } from './geo.js';
import { spoken } from './routing.js';

export class Navigation {
  constructor(route, { speak } = {}) {
    this.route = route;
    this.cum = cumulative(route.coords);
    this.total = this.cum[this.cum.length - 1];
    this.speak = speak || (() => {});
    this.stepIdx = 1;
    this.said = new Set();
    this.off = 0;
    this.lastSeg = 0;
  }

  snap(lat, lon) {
    const c = this.route.coords;
    // search near the last matched segment first (keeps us on our carriageway), then everywhere
    const lo = Math.max(0, this.lastSeg - 30), hi = Math.min(c.length, this.lastSeg + 200);
    let s = snapToLine(c.slice(lo, hi), lat, lon, this.cum.slice(lo, hi));
    if (s) { s.index += lo; }
    if (!s || s.dist > 60) {
      const g = snapToLine(c, lat, lon, this.cum);
      if (g && (!s || g.dist < s.dist)) s = g;
    }
    if (s) this.lastSeg = s.index;
    return s;
  }

  update(pos) {
    const steps = this.route.steps;
    const s = this.snap(pos.lat, pos.lon);
    if (!s) return null;
    const tol = Math.max(45, Math.min(120, (pos.acc || 20) * 1.5));
    this.off = s.dist > tol ? this.off + 1 : 0;
    const along = s.along;
    let i = this.stepIdx;
    while (i < steps.length - 1 && steps[i].along <= along + 8) i++;
    this.stepIdx = i;
    const next = steps[i];
    const distToNext = Math.max(0, next.along - along);
    const remaining = Math.max(0, this.total - along);
    const remainingTime = this.route.duration * (remaining / (this.total || 1));
    const kmh = (pos.speed || 0) * 3.6;
    const far = kmh > 85 ? 1600 : kmh > 50 ? 800 : 350;
    const near = kmh > 85 ? 450 : kmh > 50 ? 220 : 80;
    if (distToNext <= far && distToNext > near * 1.6 && !this.said.has(`${i}f`)) {
      this.said.add(`${i}f`);
      this.speak(spoken(next, distToNext));
    }
    if (distToNext <= near && !this.said.has(`${i}n`)) {
      this.said.add(`${i}n`); this.said.add(`${i}f`);
      this.speak(spoken(next, distToNext > 60 ? distToNext : null));
    }
    const arrived = remaining < 30;
    if (arrived && !this.said.has('arrived')) { this.said.add('arrived'); this.speak('وصلت إلى وجهتك'); }
    return { snap: s, along, next, nextNext: steps[i + 1], distToNext, remaining, remainingTime, arrived, offRoute: this.off >= 4 };
  }
}

/**
 * Speed cameras ahead in the direction of travel.
 * cameras: [{lat, lon, speed, dir, dirSrc}]
 */
export class CameraWatch {
  constructor(cameras, { speak } = {}) {
    this.cameras = cameras;
    this.speak = speak || (() => {});
    this.grid = new Map();
    cameras.forEach((c, i) => {
      const k = `${Math.floor(c.lat / 0.05)}:${Math.floor(c.lon / 0.05)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(i);
    });
    this.state = new Map(); // camera index -> {warned, minDist, passedAt}
  }

  nearby(lat, lon) {
    const out = [];
    const cy = Math.floor(lat / 0.05), cx = Math.floor(lon / 0.05);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) for (const i of this.grid.get(`${y}:${x}`) || []) out.push(i);
    return out;
  }

  /** Returns {camera, dist, speeding} for the camera ahead, or null. */
  update(pos) {
    const kmh = (pos.speed || 0) * 3.6;
    if (pos.heading == null || kmh < 12) return null;
    const now = Date.now();
    let best = null;
    for (const i of this.nearby(pos.lat, pos.lon)) {
      const c = this.cameras[i];
      const d = haversine(pos.lat, pos.lon, c.lat, c.lon);
      if (d > 1200) continue;
      const st = this.state.get(i) || { warned: false, minDist: Infinity, passedAt: 0 };
      if (now - st.passedAt < 5 * 60000) continue;
      if (st.minDist < 80 && d > st.minDist + 40) { st.passedAt = now; st.warned = false; st.minDist = Infinity; this.state.set(i, st); continue; }
      const ahead = Math.abs(angleDiff(pos.heading, bearing(pos.lat, pos.lon, c.lat, c.lon)));
      if (ahead > (d < 150 ? 50 : 25)) continue;
      // a camera facing the other carriageway is not ours
      if (c.dir != null && Math.abs(angleDiff(c.dir, pos.heading)) > 65) continue;
      st.minDist = Math.min(st.minDist, d);
      this.state.set(i, st);
      if (!best || d < best.dist) best = { camera: c, dist: d, index: i };
    }
    if (!best) return null;
    const st = this.state.get(best.index);
    const warnAt = kmh > 85 ? 800 : 450;
    if (!st.warned && best.dist <= warnAt) {
      st.warned = true;
      const limit = best.camera.speed ? `، الحد ${fmtNum(best.camera.speed)}` : '';
      this.speak(`انتبه، كاميرا سرعة بعد ${fmtDist(Math.round(best.dist / 50) * 50)}${limit}`);
    }
    best.speeding = best.camera.speed ? kmh > best.camera.speed + 2 : false;
    return best;
  }
}

/** Arabic text-to-speech with a voice picked once. */
export function makeSpeaker(isOn) {
  let voice = null;
  const pick = () => { voice = speechSynthesis.getVoices().find(v => v.lang?.toLowerCase().startsWith('ar')) || null; };
  if ('speechSynthesis' in window) { pick(); speechSynthesis.onvoiceschanged = pick; }
  return text => {
    if (!isOn() || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang || 'ar-SA';
    if (voice) u.voice = voice;
    u.rate = 1;
    speechSynthesis.speak(u);
  };
}

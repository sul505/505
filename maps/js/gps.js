// GPS position, heading (GPS course while moving, compass while still) and screen wake lock.
import { haversine, bearing } from './geo.js';

export class Gps extends EventTarget {
  constructor() {
    super();
    this.watchId = null;
    this.last = null;
    this.compass = null;
    this.compassListening = false;
  }
  get active() { return this.watchId != null; }

  start() {
    if (!('geolocation' in navigator)) throw new Error('unsupported');
    if (this.watchId != null) return;
    this.watchId = navigator.geolocation.watchPosition(
      p => this.onPosition(p),
      e => this.dispatchEvent(new CustomEvent('error', { detail: e })),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 },
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  onPosition(p) {
    const c = p.coords, t = p.timestamp || Date.now();
    let speed = Number.isFinite(c.speed) ? c.speed : null;
    let course = Number.isFinite(c.heading) ? c.heading : null;
    const prev = this.last;
    if (prev) {
      const d = haversine(prev.lat, prev.lon, c.latitude, c.longitude), dt = (t - prev.time) / 1000;
      if (speed == null && dt > 0) speed = d / dt;
      if (course == null && d > 4) course = bearing(prev.lat, prev.lon, c.latitude, c.longitude);
    }
    const moving = (speed || 0) > 1.4;
    const pos = {
      lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: Number.isFinite(c.altitude) ? c.altitude : null,
      altAcc: c.altitudeAccuracy, speed: speed || 0, course: moving ? course : null, time: t,
    };
    pos.heading = pos.course ?? this.compass;
    this.last = pos;
    this.dispatchEvent(new CustomEvent('position', { detail: pos }));
  }

  /** Start compass updates; on iOS this must be called from a user gesture. */
  async enableCompass() {
    if (this.compassListening) return true;
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try { if ((await DOE.requestPermission()) !== 'granted') return false; } catch { return false; }
    }
    const handler = e => {
      let h = null;
      if (Number.isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
      else if (e.absolute && Number.isFinite(e.alpha)) h = (360 - e.alpha) % 360;
      if (h == null) return;
      h = (h + (screen.orientation?.angle || 0) + 360) % 360;
      // smooth on the circle
      if (this.compass == null) this.compass = h;
      else { const d = ((h - this.compass + 540) % 360) - 180; this.compass = (this.compass + d * 0.25 + 360) % 360; }
      if (this.last && this.last.course == null) {
        this.last.heading = this.compass;
        this.dispatchEvent(new CustomEvent('heading', { detail: this.compass }));
      }
    };
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handler, true);
    else window.addEventListener('deviceorientation', handler, true);
    this.compassListening = true;
    return true;
  }
}

let wakeLock = null;
export async function keepAwake(on) {
  keepAwake.wanted = on;
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed (e.g. battery saver) */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && keepAwake.wanted) keepAwake(true);
});

// Oman offline maps: main controller.
import * as maplibregl from '../vendor/maplibre-gl.mjs';
import mlcontour from '../vendor/maplibre-contour.mjs';
import './db-core.js';
import { buildStyle, LAYER_GROUPS, BASE } from './style.js';
import {
  haversine, bearing, angleDiff, circle, cumulative, lineLength, ringArea, fmtDist, fmtDur, fmtDurLong, fmtSpeed, fmtNum, omanTime,
  fmtDD, fmtDMS, fmtDDM, fmtUTM, fmtMGRS, parseCoords, esc,
} from './geo.js';
import { PlaceIndex, KIND_AR } from './search.js';
import { AdminIndex, placeLine } from './places.js';
import * as region from './region.js';
import { planRoute, call as router, instruction, maneuverIcon, PROFILE_LABEL, compassWord } from './routing.js';
import { Navigation, CameraWatch, makeSpeaker } from './nav.js';
import { Gps, keepAwake } from './gps.js';
import { Recorder, listTracks, saveTrack, loadTrack, deleteTrack, listWaypoints, saveWaypoints, toGPX, parseGPX, download } from './track.js';
import { elevationAt, profile as elevationProfile } from './terrain.js';
import * as tides from './tides.js';
import { sunTimes, moonPhase, moonPhaseName } from './sun.js';

const $ = s => document.querySelector(s);
const DB = self.OmanDB;
const FC = (features = []) => ({ type: 'FeatureCollection', features });
const pointF = (lon, lat, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const lineF = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });

/* ---------- icons ---------- */
const ICON = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M9 5l7 7-7 7"/>',
  layers: '<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="m2 13 10 5 10-5"/><path d="m2 17.5 10 5 10-5" opacity=".5"/>',
  north: '<path d="M12 2.5 7.5 13h9z" fill="#dc2626" stroke="#dc2626"/><path d="M12 21.5 7.5 13h9z" fill="currentColor" opacity=".35" stroke="none"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
  follow: '<path d="M12 3l7 18-7-4-7 4 7-18z" fill="currentColor"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5"/>',
  car: '<path d="M5 13l1.6-4.4A2 2 0 0 1 8.5 7h7a2 2 0 0 1 1.9 1.6L19 13"/><rect x="3" y="13" width="18" height="5" rx="1.5"/><circle cx="7.5" cy="18" r="1.6"/><circle cx="16.5" cy="18" r="1.6"/>',
  jeep: '<path d="M3 16v-5h3l2-4h8l2 4h3v5"/><path d="M3 11h18"/><circle cx="7.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="M10 21l2-6 3 3v3M7 12l2.5-4 4 1 2 4 3 1"/><path d="M11.5 9l-1.5 6"/>',
  goto: '<circle cx="12" cy="12" r="9"/><path d="M12 6l3 9-3-2-3 2z" fill="currentColor"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  download: '<path d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16"/>',
  upload: '<path d="M12 21V9m0 0-5 5m5-5 5 5M4 5h16"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
  rec: '<circle cx="12" cy="12" r="7" fill="currentColor"/>',
  wave: '<path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 7c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6M22 9l-6 6"/>',
  camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  track: '<path d="M4 19c3-6 6-1 9-7s5-6 7-7"/><circle cx="4" cy="19" r="1.5" fill="currentColor"/><circle cx="20" cy="5" r="1.5" fill="currentColor"/>',
  logo: '<path d="M4 19l5-9 4 6 2-3 5 6z" fill="currentColor" stroke="none"/><circle cx="17" cy="6" r="2.5" fill="currentColor" stroke="none"/>',
  mountain: '<path d="M3 20l6-10 4 6 2-3 6 7z"/>',
  swap: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  offline: '<path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M2 8.8a15 15 0 0 1 4-2.5"/><circle cx="12" cy="20" r="1" fill="currentColor"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
};
const icon = (name, size = 22) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
const KIND_ICON = { peak: 'mountain', saddle: 'mountain', cliff: 'mountain', dune: 'mountain', fuel: 'car', car: 'car', road: 'route', hospital: 'plus',
  clinic: 'plus', pharmacy: 'plus', wadi: 'wave', valley: 'wave', water: 'wave', spring: 'wave', beach: 'wave', bay: 'wave', reef: 'wave',
  fort: 'star', ruins: 'star', monument: 'star', museum: 'star', attraction: 'star', viewpoint: 'star' };
const fillIcons = root => root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
fillIcons(document);

/* ---------- state ---------- */
const DEFAULT_SETTINGS = {
  theme: 'auto', lang: 'ar', voice: true, camAlerts: true, terrainZoom: 12, profile: 'car', coordFormat: 'dd',
  show: { hillshade: true, contours: true, offroad: true, satellite: false, cameras: true, tides: true, peaks: true },
};
const S = {
  settings: structuredClone(DEFAULT_SETTINGS),
  overlay: {}, places: null, admin: null, cameras: [], tideData: null,
  pos: null, follow: 0, panel: null, panelArgs: null, pick: null,
  route: null, routePoints: [], profile: 'car', nav: null, goto: null, terrain3d: false,
  recorder: new Recorder(), measure: null, waypoints: [], download: null, sheetFull: false,
  trip: { odo: 0, max: 0, moving: 0, last: null },
};
const gps = new Gps();
const speak = makeSpeaker(() => S.settings.voice);

const toast = (() => {
  let t;
  return (msg, ms = 2600) => { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(t); t = setTimeout(() => el.classList.remove('show'), ms); };
})();
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('تم النسخ'); } catch { toast('تعذّر النسخ'); }
}
async function saveSettings() { try { await DB.put('kv', S.settings, 'settings'); } catch { /* storage unavailable */ } }
const flavor = () => (S.settings.theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : S.settings.theme);
function applyTheme() { document.documentElement.dataset.theme = flavor(); }

/* ---------- map ---------- */
// Contours are generated from the terrain tiles; the DEM source is rebuilt when the zoom it can use changes.
const contour = { maxzoom: null, tiles: null };
function contourTilesFor(maxzoom) {
  if (contour.maxzoom === maxzoom) return contour.tiles;
  const dem = new mlcontour.DemSource({ id: `dem${maxzoom}`, url: `${BASE}tiles/terrain/{z}/{x}/{y}.webp`, encoding: 'terrarium', maxzoom, worker: true, cacheSize: 120, timeoutMs: 20000 });
  dem.setupMaplibre(maplibregl);
  contour.maxzoom = maxzoom;
  contour.tiles = dem.contourProtocolUrl({
    thresholds: { 9: [200, 1000], 10: [100, 500], 11: [50, 250], 12: [50, 200], 13: [20, 100], 14: [10, 50], 15: [10, 50] },
    contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level', extent: 4096, buffer: 1,
  });
  return contour.tiles;
}
// Terrain the map may request: everything online; offline only what was downloaded.
function terrainScope() {
  const t = S.terrainLocal;
  if (navigator.onLine) return { maxzoom: 12 };
  if (!t) return { available: false };
  return { maxzoom: t.maxZoom, bounds: t.bounds };
}
let map;
const styleNow = () => {
  const dem = terrainScope();
  return buildStyle({ flavor: flavor(), lang: S.settings.lang, show: S.settings.show, contourTiles: contourTilesFor(dem.maxzoom ?? 12), data: S.overlay, terrain: dem });
};
async function loadTerrainScope() {
  const rec = await DB.get('archives', 'terrain').catch(() => null);
  S.terrainLocal = rec?.status === 'complete' ? { maxZoom: rec.header?.maxZoom ?? rec.params?.maxZoom ?? 12, bounds: rec.header?.bounds } : null;
}
function setData(id, data) {
  S.overlay[id] = data;
  map?.getSource(id)?.setData(data);
}
function setGroup(group, on) {
  for (const id of LAYER_GROUPS[group] || []) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
function restyle() {
  applyTheme();
  map.setStyle(styleNow(), { diff: false });
  map.once('styledata', () => { if (S.terrain3d) map.setTerrain({ source: 'terrain3d', exaggeration: 1.3 }); });
}

const meEl = document.createElement('div');
meEl.className = 'me';
meEl.innerHTML = '<div class="cone"></div><div class="dot"></div><svg class="arrow" viewBox="0 0 24 24" width="34" height="34"><path d="M12 2l7 19-7-4-7 4z" fill="#1a73e8" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
let meMarker = null;

/* ---------- boot ---------- */
async function swReady() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('sw.js');
    if (navigator.serviceWorker.controller) return true;
    await Promise.race([new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })), new Promise(r => setTimeout(r, 6000))]);
    return !!navigator.serviceWorker.controller;
  } catch { return false; }
}

async function loadJSON(path) { const r = await fetch(path); if (!r.ok) throw new Error(path); return r.json(); }

async function boot() {
  try { Object.assign(S.settings, (await DB.get('kv', 'settings')) || {}); S.settings.show = { ...DEFAULT_SETTINGS.show, ...S.settings.show }; } catch { /* first run */ }
  S.profile = S.settings.profile;
  applyTheme();
  const controlled = await swReady();
  await loadTerrainScope();
  if (!controlled) toast('المتصفح لا يدعم العمل بدون إنترنت هنا — افتح التطبيق عبر https', 6000);
  let view = null;
  try { view = JSON.parse(localStorage.getItem('omanmaps.view')); } catch { /* private mode */ }
  const fromHash = parseHash();
  map = new maplibregl.Map({
    container: 'map', style: styleNow(), center: fromHash ? [fromHash.lon, fromHash.lat] : view?.center || [57.3, 21.6],
    zoom: fromHash?.zoom ?? view?.zoom ?? 5.6, attributionControl: { compact: true }, maxPitch: 75, dragRotate: true,
  });
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-left');
  map.on('moveend', () => {
    try { localStorage.setItem('omanmaps.view', JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() })); } catch { /* ignore */ }
  });
  map.on('rotate', () => { $('#northBtn svg').style.transform = `rotate(${-map.getBearing()}deg)`; });
  map.on('dragstart', e => { if (e.originalEvent && S.follow) { S.follow = 0; updateLocButton(); } });
  map.on('click', onMapClick);
  map.on('contextmenu', e => onMapClick(e, true));
  for (const id of ['cameras', 'tides', 'marks', 'peaks']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  wireUI();
  loadData();
  refreshChips();
  const onNet = () => { refreshChips(); restyle(); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  // missing tiles (outside the downloaded area while offline) are expected: keep the console quiet
  map.on('error', e => { if (!e.tile && !e.sourceId) console.warn(e.error || e); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.settings.theme === 'auto') restyle(); });
  if (fromHash) map.once('load', () => openPlace({ lat: fromHash.lat, lon: fromHash.lon, name: fromHash.name }));
  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h) { map.flyTo({ center: [h.lon, h.lat], zoom: h.zoom }); openPlace({ lat: h.lat, lon: h.lon, name: h.name }); }
  });
  const st = await region.status().catch(() => null);
  if (st && st.basemap?.status !== 'complete' && !fromHash) openPanel('welcome', st);
}

function parseHash() {
  const m = /^#(-?\d+\.\d+),(-?\d+\.\d+)(?:,(\d+(?:\.\d+)?))?(?:,(.*))?$/.exec(location.hash);
  if (!m) return null;
  return { lat: +m[1], lon: +m[2], zoom: m[3] ? +m[3] : 15, name: m[4] ? decodeURIComponent(m[4]) : '' };
}

async function loadData() {
  const [places, admin, cameras, tideData, wpts, manifest] = await Promise.allSettled([
    loadJSON('data/oman-places.json'), loadJSON('data/oman-admin.json'), loadJSON('data/oman-cameras.json'), loadJSON('data/oman-tides.json'), listWaypoints(),
    loadJSON('data/manifest.json'),
  ]);
  if (manifest.status === 'fulfilled') S.manifest = manifest.value;
  if (places.status === 'fulfilled') {
    S.places = new PlaceIndex(places.value);
    setData('peaks', FC(S.places.byKind('peak').filter(p => p.ar || p.en).map(p => pointF(p.lon, p.lat, { name: p.ar || p.en, ...(p.ele != null ? { ele: p.ele } : {}) }))));
  }
  if (admin.status === 'fulfilled') S.admin = new AdminIndex(admin.value);
  if (cameras.status === 'fulfilled') {
    S.cameras = cameras.value;
    S.camWatch = new CameraWatch(S.cameras, { speak });
    setData('cameras', FC(S.cameras.map((c, i) => pointF(c.lon, c.lat, { i, ...(c.speed ? { speed: c.speed } : {}) }))));
  }
  if (tideData.status === 'fulfilled') {
    S.tideData = tideData.value;
    setData('tides', FC(S.tideData.stations.map(s => pointF(s.lon, s.lat, { id: s.id, name: s.ar }))));
  }
  if (wpts.status === 'fulfilled') { S.waypoints = wpts.value; drawWaypoints(); }
  if (places.status === 'rejected') toast('بيانات البحث غير متوفرة بدون إنترنت — حمّل الخرائط أولاً', 5000);
}

/* ---------- chips (status) ---------- */
async function refreshChips() {
  const chips = [];
  if (!navigator.onLine) chips.push(`<span class="chip warn">${icon('offline', 16)} بدون إنترنت</span>`);
  if (S.recorder.active) chips.push(`<button class="chip rec" data-act="panel" data-panel="tracks">${icon('rec', 14)} تسجيل ${fmtDist(S.recorder.distance)}</button>`);
  if (S.download) chips.push(`<button class="chip" data-act="panel" data-panel="offline">${icon('download', 16)} ${Math.round(S.download.pct * 100)}٪</button>`);
  $('#chips').innerHTML = chips.join('');
}

/* ---------- sheet & panels ---------- */
function openPanel(name, args) {
  if (S.panel && S.panel !== name) S.history.push([S.panel, S.panelArgs]);
  S.panel = name; S.panelArgs = args;
  closeDrawer();
  renderPanel();
}
S.history = [];
function back() {
  const prev = S.history.pop();
  if (prev) { S.panel = prev[0]; S.panelArgs = prev[1]; renderPanel(); } else closePanel();
}
function closePanel() {
  S.panel = null; S.panelArgs = null; S.history = [];
  $('#sheet').hidden = true;
  if (S.measure) stopMeasure();
  setData('pick', FC());
}
function head(title, { noBack } = {}) {
  return `<div class="ph">${!noBack && S.history.length ? `<button class="icon-btn" data-act="back" aria-label="رجوع">${icon('back')}</button>` : ''}<h2>${esc(title)}</h2><button class="icon-btn" data-act="close" aria-label="إغلاق">${icon('close')}</button></div>`;
}
const PANELS = {};
function renderPanel() {
  const fn = PANELS[S.panel];
  if (!fn) return closePanel();
  const sheet = $('#sheet');
  sheet.hidden = false;
  sheet.classList.toggle('full', S.sheetFull);
  const body = $('#sheetBody');
  const html = fn(S.panelArgs);
  if (typeof html === 'string') { body.innerHTML = html; fillIcons(body); body.scrollTop = 0; }
}
function rerender(name) { if (S.panel === name) renderPanel(); }

/* ---------- drawer ---------- */
function openDrawer() { $('#drawer').hidden = false; $('#scrim').hidden = false; }
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }

/* ---------- welcome ---------- */
PANELS.welcome = st => `
  ${head('أهلاً بك في خرائط عُمان', { noBack: true })}
  <p class="sub">لتعمل الخريطة والبحث والملاحة <b>بدون إنترنت</b>، نزّل بيانات عُمان مرة واحدة (حوالي ${fmtNum(region.ARCHIVES.basemap.approxMB + region.ARCHIVES.terrain.approxMB[S.settings.terrainZoom])} ميغابايت مع التضاريس).</p>
  <div class="actions"><button class="btn big" data-act="panel" data-panel="offline">${icon('download')} تنزيل خريطة عُمان</button>
  <button class="btn ghost" data-act="close">لاحقاً</button></div>
  <p class="muted small">يمكنك استخدام الخريطة الآن مع الإنترنت، وتنزيلها لاحقاً من القائمة ← «تنزيل الخرائط».</p>`;

/* ---------- search ---------- */
function wireSearch() {
  const input = $('#q'), list = $('.suggest'), clr = $('[data-clear]');
  let items = [], active = -1, onlineSeq = 0;
  const close = () => { list.hidden = true; list.innerHTML = ''; items = []; active = -1; input.setAttribute('aria-expanded', 'false'); };
  const subtitle = it => [KIND_AR[it.kind], it.nearName && it.nearName !== it.ar ? it.nearName : '', it.ele != null ? `${fmtNum(it.ele)} م` : '',
    S.pos ? fmtDist(haversine(S.pos.lat, S.pos.lon, it.lat, it.lon)) : ''].filter(Boolean).join(' · ');
  const paint = (rows, extraHtml = '') => {
    items = rows; active = -1;
    list.innerHTML = rows.map((it, i) => `<li role="option" data-i="${i}"><span class="k">${icon(it.kind === 'coords' ? 'goto' : it.online ? 'search' : KIND_ICON[it.kind] || 'pin', 18)}</span><span class="grow"><div class="t">${esc(it.ar || it.en)}</div><div class="s">${esc(it.sub || subtitle(it))}</div></span></li>`).join('') + extraHtml;
    list.hidden = !list.innerHTML;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };
  const run = () => {
    const q = input.value.trim();
    clr.hidden = !q;
    if (!q) return close();
    const rows = [];
    const c = parseCoords(q);
    if (c) rows.push({ kind: 'coords', ar: `الإحداثيات ${fmtDD(c.lat, c.lon)}`, sub: 'انتقل إلى هذه النقطة', lat: c.lat, lon: c.lon });
    const ctr = map.getCenter();
    if (S.places) rows.push(...S.places.search(q, { lat: S.pos?.lat ?? ctr.lat, lon: S.pos?.lon ?? ctr.lng, limit: 10 }));
    paint(rows, !S.places ? '<li class="h">بيانات البحث لم تُحمَّل بعد</li>' : rows.length ? '' : '<li class="h">لا توجد نتائج في البيانات المحلية</li>');
    if (navigator.onLine && q.length >= 3 && rows.length < 4 && !c) {
      const seq = ++onlineSeq;
      setTimeout(async () => {
        if (seq !== onlineSeq) return;
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=ar&viewbox=51.5,27,60.5,16&q=${encodeURIComponent(q)}`);
          const data = await res.json();
          if (seq !== onlineSeq || input.value.trim() !== q) return;
          const extra = data.map(r => ({ online: true, ar: r.name || r.display_name.split(',')[0], sub: r.display_name, lat: +r.lat, lon: +r.lon, kind: 'online' }));
          if (extra.length) paint([...items, ...extra]);
        } catch { /* offline */ }
      }, 450);
    }
  };
  const pick = it => {
    if (!it) return;
    close();
    input.value = it.ar || it.en || '';
    input.blur();
    map.flyTo({ center: [it.lon, it.lat], zoom: Math.max(map.getZoom(), it.kind === 'city' ? 12 : 15) });
    openPlace({ lat: it.lat, lon: it.lon, name: it.ar || it.en, en: it.ar ? it.en : '', kind: it.kind, ele: it.ele, nearName: it.nearName });
  };
  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (input.value.trim()) run(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      list.querySelectorAll('li[data-i]').forEach(li => li.setAttribute('aria-selected', String(+li.dataset.i === active)));
    } else if (e.key === 'Enter') { e.preventDefault(); pick(items[active >= 0 ? active : 0]); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) pick(items[+li.dataset.i]); });
  clr.addEventListener('click', () => { input.value = ''; clr.hidden = true; close(); input.focus(); });
}

/* ---------- place details ---------- */
function onMapClick(e, long = false) {
  if (S.measure) { addMeasurePoint(e.lngLat); return; }
  if (S.pickFor) { const { lng, lat } = e.lngLat; const cb = S.pickFor; S.pickFor = null; cb({ lat, lon: lng, name: '' }); return; }
  const feats = map.queryRenderedFeatures(e.point, { layers: ['cameras', 'tides', 'marks', 'peaks'].filter(id => map.getLayer(id)) });
  const f = feats[0];
  if (f?.layer.id === 'tides') { openPanel('tide', { id: f.properties.id }); return; }
  if (f?.layer.id === 'cameras') { const c = S.cameras[f.properties.i]; openPlace({ lat: c.lat, lon: c.lon, name: 'كاميرا سرعة', camera: c }); return; }
  if (f?.layer.id === 'marks') { const w = S.waypoints.find(x => x.id === f.properties.id); if (w) { openPlace({ ...w, waypoint: w }); return; } }
  if (f?.layer.id === 'peaks') { const [lon, lat] = f.geometry.coordinates; openPlace({ lat, lon, name: f.properties.name, kind: 'peak', ele: f.properties.ele }); return; }
  if (S.nav && !long) return;
  openPlace({ lat: e.lngLat.lat, lon: e.lngLat.lng });
}

function openPlace(p) {
  S.pick = { ...p, token: Math.random() };
  setData('pick', FC([pointF(p.lon, p.lat)]));
  openPanel('place', S.pick);
  enrichPlace(S.pick);
}

PANELS.place = p => {
  const near = S.places?.nearest(p.lat, p.lon, ['city', 'town', 'village', 'suburb', 'hamlet', 'locality'], 25);
  const admin = S.admin?.locate(p.lat, p.lon) || {};
  p.near = near; p.admin = admin;
  const title = p.name || (near && near.dist < 600 ? (near.ar || near.en) : 'موقع محدد');
  const kind = p.camera ? 'كاميرا مراقبة السرعة' : p.waypoint ? 'نقطة محفوظة' : KIND_AR[p.kind] || '';
  const dist = S.pos ? `${fmtDist(haversine(S.pos.lat, S.pos.lon, p.lat, p.lon))} باتجاه ${compassWord(bearing(S.pos.lat, S.pos.lon, p.lat, p.lon))} (${fmtNum(Math.round(bearing(S.pos.lat, S.pos.lon, p.lat, p.lon)))}°)` : '';
  const tide = S.tideData && tides.nearestStation(S.tideData.stations, p.lat, p.lon);
  const formats = [['dd', 'عشري', fmtDD(p.lat, p.lon)], ['dms', 'درجات', fmtDMS(p.lat, p.lon)], ['ddm', 'دقائق', fmtDDM(p.lat, p.lon)], ['utm', 'UTM', fmtUTM(p.lat, p.lon)], ['mgrs', 'MGRS', fmtMGRS(p.lat, p.lon)]];
  return `${head(kind || 'تفاصيل الموقع')}
    <div class="title">${esc(title)}</div>
    ${p.en ? `<div class="sub num">${esc(p.en)}</div>` : ''}
    <div class="sub" id="pl-line">${esc(placeLine({ near, admin }))}</div>
    ${p.camera ? `<div class="card"><div class="kv"><span class="k">الحد الأقصى</span><b>${p.camera.speed ? `${fmtNum(p.camera.speed)} كم/س` : 'غير معروف'}</b>
      <span class="k">اتجاه المراقبة</span><span>${p.camera.dir != null ? `${compassWord(p.camera.dir)} (${p.camera.dirSrc === 'tag' ? 'من البيانات' : 'تقديري من الطريق'})` : 'غير محدد'}</span></div></div>` : ''}
    <div class="actions">
      <button class="btn" data-act="directions">${icon('route', 18)} الاتجاهات</button>
      <button class="btn light" data-act="goto-start">${icon('goto', 18)} اذهب مباشرة</button>
      <button class="btn light" data-act="${p.waypoint ? 'wpt-delete' : 'wpt-save'}">${icon(p.waypoint ? 'trash' : 'star', 18)} ${p.waypoint ? 'حذف النقطة' : 'حفظ نقطة'}</button>
      <button class="btn ghost" data-act="share">${icon('share', 18)} مشاركة</button>
    </div>
    <div class="card"><div class="kv">
      <span class="k">الارتفاع</span><span id="pl-ele">…</span>
      <span class="k">الطريق</span><span id="pl-road">…</span>
      ${dist ? `<span class="k">من موقعك</span><span>${dist}</span>` : ''}
      ${tide && tide.km < 60 ? `<span class="k">المد والجزر</span><button class="btn light" data-act="panel" data-panel="tide" data-id="${tide.station.id}">${icon('wave', 16)} ${esc(tide.station.ar)} (${fmtNum(Math.round(tide.km))} كم)</button>` : ''}
    </div></div>
    <div class="coords">${formats.map(([k, lab, v]) => `<div class="coord"><span class="lab">${lab}</span><span class="num grow">${esc(v)}</span><button class="icon-btn" data-act="copy" data-text="${esc(v)}" aria-label="نسخ">${icon('copy', 18)}</button></div>`).join('')}</div>`;
};

async function enrichPlace(p) {
  const fill = (id, html) => { if (S.pick?.token === p.token) { const el = document.getElementById(id); if (el) el.innerHTML = html; } };
  elevationAt(p.lat, p.lon).then(e => fill('pl-ele', e == null ? '<span class="muted">غير متوفر (نزّل التضاريس)</span>' : `<b>${fmtNum(Math.round(e))} م</b> فوق سطح البحر`));
  router('roadAt', { lat: p.lat, lon: p.lon, maxDist: 250 }).then(r => {
    if (!r) return fill('pl-road', '<span class="muted">لا يوجد طريق قريب (أبعد من ٢٥٠ م)</span>');
    const CLS = { motorway: 'طريق سريع', trunk: 'طريق رئيسي', primary: 'طريق رئيسي', secondary: 'طريق ثانوي', tertiary: 'طريق فرعي', residential: 'شارع سكني',
      unclassified: 'طريق محلي', service: 'طريق خدمة', track: 'طريق ترابي', path: 'ممر مشاة', footway: 'ممر مشاة' };
    const bits = [r.name || CLS[r.cls] || r.cls, r.unpaved ? `<span class="pill unpaved">غير معبّد${r.grade ? ` (درجة ${fmtNum(r.grade)})` : ''}${r.sand ? ' رملي' : ''}</span>` : '',
      r.maxspeed ? `الحد ${fmtNum(r.maxspeed)} كم/س` : '', r.dist > 25 ? `<span class="muted">على بعد ${fmtDist(r.dist)}</span>` : ''];
    fill('pl-road', bits.filter(Boolean).join(' · '));
    const line = placeLine({ near: p.near, admin: p.admin, road: r.dist < 60 ? r : null });
    fill('pl-line', esc(line));
  }).catch(() => fill('pl-road', '<span class="muted">بيانات الطرق غير محمّلة</span>'));
}

/* ---------- waypoints ---------- */
function drawWaypoints() { setData('marks', FC(S.waypoints.map(w => pointF(w.lon, w.lat, { id: w.id, name: w.name })))); }
async function saveWaypoint(p) {
  const name = prompt('اسم النقطة', p.name || (p.near ? `قرب ${p.near.ar || p.near.en}` : 'نقطة'));
  if (name == null) return;
  const ele = await elevationAt(p.lat, p.lon);
  S.waypoints.unshift({ id: `w${Date.now()}`, name: name.trim() || 'نقطة', lat: p.lat, lon: p.lon, ele, created: Date.now() });
  await saveWaypoints(S.waypoints);
  drawWaypoints();
  toast('تم حفظ النقطة');
}

/* ---------- routing ---------- */
const myPoint = () => (S.pos ? { lat: S.pos.lat, lon: S.pos.lon, name: 'موقعي', mine: true } : null);
function startDirections(to) {
  S.routePoints = [myPoint(), { lat: to.lat, lon: to.lon, name: to.name || (to.near ? `قرب ${to.near.ar || to.near.en}` : 'الوجهة') }];
  if (!S.routePoints[0]) {
    S.awaitMine = true;
    if (!gps.active) { try { gps.start(); } catch { /* no gps */ } }
    toast('جارٍ تحديد موقعك… أو اختر نقطة البداية من الخريطة', 4000);
  }
  S.route = null;
  openPanel('route');
  computeRoute();
}
async function computeRoute() {
  const pts = S.routePoints;
  if (pts.length < 2 || pts.some(p => !p)) { rerender('route'); return; }
  S.routeBusy = true; rerender('route');
  try {
    const r = await planRoute(pts, S.profile);
    S.routeBusy = false;
    if (r.error) {
      S.route = null;
      const msg = { 'start-far': 'نقطة البداية بعيدة عن أي طريق مناسب', 'end-far': 'الوجهة بعيدة عن أي طريق مناسب', 'no-route': 'لا يوجد طريق متصل بين النقطتين في بيانات عُمان', 'roads-missing': 'بيانات الطرق غير محمّلة — نزّل الخرائط' }[r.error] || r.error;
      S.routeError = msg + (r.error.endsWith('far') && S.profile === 'car' ? ' — جرّب «دفع رباعي» أو «اذهب مباشرة»' : '');
      drawRoute(null);
    } else {
      S.routeError = null;
      S.route = r;
      drawRoute(r);
      fitLine(r.coords);
      elevationProfile(r.coords, cumulative(r.coords)).then(pr => { if (S.route === r) { r.elevation = pr; rerender('route'); } }).catch(() => {});
    }
  } catch (err) {
    S.routeBusy = false; S.route = null;
    S.routeError = err.message === 'roads-missing' ? 'بيانات الطرق غير محمّلة — نزّل الخرائط من القائمة' : `تعذّر حساب المسار: ${err.message}`;
  }
  rerender('route');
}
function drawRoute(r, doneIndex = 0) {
  if (!r) { setData('route', FC()); setData('route-offroad', FC()); return; }
  const feats = [];
  for (const [a, b, dirt] of r.segs) {
    if (b <= doneIndex) feats.push(lineF(r.coords.slice(a, b + 1), { done: true }));
    else if (a < doneIndex) { feats.push(lineF(r.coords.slice(a, doneIndex + 1), { done: true })); feats.push(lineF(r.coords.slice(doneIndex, b + 1), { unpaved: dirt })); }
    else feats.push(lineF(r.coords.slice(a, b + 1), { unpaved: dirt }));
  }
  setData('route', FC(feats));
  setData('route-offroad', FC(r.offroad.map(c => lineF(c))));
}
function fitLine(coords, pad = 60) {
  if (!coords?.length) return;
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const [x, y] of coords) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const wide = innerWidth >= 900;
  map.fitBounds([[minX, minY], [maxX, maxY]], { padding: { top: 90, bottom: wide ? pad : innerHeight * 0.5, left: pad, right: wide ? 430 : pad }, maxZoom: 16, duration: 700 });
}

function elevationChart(pr, total) {
  if (!pr) return '';
  const W = 340, H = 90, pts = pr.points.filter(p => p.ele != null);
  const span = Math.max(20, pr.max - pr.min);
  const x = d => (d / total) * W, y = e => H - 6 - ((e - pr.min) / span) * (H - 16);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.ele).toFixed(1)}`).join('');
  return `<div class="card"><div class="row small"><b class="grow">مقطع الارتفاع</b><span>↑ ${fmtNum(Math.round(pr.up))} م</span><span>↓ ${fmtNum(Math.round(pr.down))} م</span></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="transform:scaleX(-1)"><path d="${path}L${W},${H}L0,${H}Z" fill="var(--brand-soft)"/><path d="${path}" fill="none" stroke="var(--brand)" stroke-width="2"/></svg>
    <div class="row small muted"><span class="grow">أدنى ${fmtNum(Math.round(pr.min))} م</span><span>أعلى ${fmtNum(Math.round(pr.max))} م</span></div></div>`;
}

PANELS.route = () => {
  const pts = S.routePoints, r = S.route;
  const field = (p, i) => `<div class="field"><span class="dot" style="background:${i === 0 ? '#15803d' : i === pts.length - 1 ? '#d93025' : '#f59e0b'}"></span>
    <span class="grow">${p ? esc(p.name || fmtDD(p.lat, p.lon)) : '<span class="muted">اضغط على الخريطة لاختيار نقطة</span>'}</span>
    <button class="icon-btn" data-act="route-pick" data-i="${i}" aria-label="اختيار من الخريطة">${icon('pin', 18)}</button>
    ${i === 0 && S.pos ? `<button class="icon-btn" data-act="route-mine" aria-label="موقعي">${icon('locate', 18)}</button>` : ''}
    ${pts.length > 2 ? `<button class="icon-btn" data-act="route-del" data-i="${i}" aria-label="حذف">${icon('close', 16)}</button>` : ''}</div>`;
  const prof = [['car', 'car'], ['4x4', 'jeep'], ['walk', 'walk']].map(([id, ic]) => `<button data-act="profile" data-p="${id}" aria-pressed="${S.profile === id}">${icon(ic, 18)} ${PROFILE_LABEL[id]}</button>`).join('');
  let res = '';
  if (S.routeBusy) res = '<p class="muted">جارٍ حساب المسار بدون إنترنت…</p>';
  else if (S.routeError) res = `<div class="warn-box">${esc(S.routeError)}</div>`;
  else if (r) {
    const paved = r.distance - r.unpaved;
    res = `<div class="row" style="align-items:baseline;gap:12px;margin-top:8px"><span class="big-num time-ok">${fmtDur(r.duration)}</span><span class="sub">${fmtDist(r.distance + r.offroadDistance)} · الوصول ${omanTime(Date.now() + r.duration * 1000)}</span></div>
      ${r.via.length ? `<div class="sub">عبر ${esc(r.via.join('، '))}</div>` : ''}
      <div class="pills"><span class="pill">معبّد ${fmtDist(paved)}</span>${r.unpaved > 50 ? `<span class="pill unpaved">ترابي ${fmtDist(r.unpaved)}</span>` : ''}${r.offroadDistance > 25 ? `<span class="pill unpaved">بدون طريق ${fmtDist(r.offroadDistance)}</span>` : ''}</div>
      <div class="actions"><button class="btn big" data-act="nav-start">${icon('follow', 18)} ابدأ الملاحة</button><button class="btn ghost" data-act="route-gpx">${icon('download', 18)} GPX</button><button class="btn ghost" data-act="route-add">${icon('plus', 18)} نقطة توقف</button></div>
      ${elevationChart(r.elevation, r.distance)}
      <ol class="steps">${r.steps.map((s, i) => `<li data-act="step" data-i="${i}"><span class="mv">${maneuverIcon(s, 26)}</span><span class="grow"><div>${esc(instruction(s))}</div><div class="d">${s.distance ? fmtDist(s.distance) : ''}</div></span></li>`).join('')}</ol>`;
  }
  return `${head('الاتجاهات')}${pts.map(field).join('')}
    <div class="row" style="margin:8px 0"><div class="seg grow" role="group" aria-label="وسيلة التنقل">${prof}</div><button class="icon-btn" data-act="route-swap" aria-label="عكس الاتجاه">${icon('swap')}</button></div>
    ${res}`;
};

/* ---------- navigation ---------- */
function startNav() {
  if (!S.route) return;
  S.nav = new Navigation(S.route, { speak });
  document.body.classList.add('navigating');
  $('#navTop').hidden = false; $('#navBottom').hidden = false;
  $('#sheet').hidden = true;
  if (!gps.active) { try { gps.start(); } catch { toast('الـGPS غير متاح'); } }
  gps.enableCompass();
  S.follow = 2; updateLocButton();
  keepAwake(true);
  speak(`${instruction(S.route.steps[0])}. المسافة ${fmtDist(S.route.distance)}`);
  if (S.pos) onPosition(S.pos);
}
function stopNav() {
  S.nav = null;
  document.body.classList.remove('navigating');
  $('#navTop').hidden = true; $('#navBottom').hidden = true; $('#camAlert').hidden = true;
  if (S.route) drawRoute(S.route);
  keepAwake(!!S.recorder.active);
  map.easeTo({ pitch: 0, bearing: 0 });
  S.follow = S.pos ? 1 : 0; updateLocButton();
  if (S.route) openPanel('route');
}
let rerouting = false, lastReroute = 0;
async function reroute(pos) {
  if (rerouting || Date.now() - lastReroute < 12000) return;
  rerouting = true; lastReroute = Date.now();
  toast('إعادة حساب المسار…');
  speak('إعادة حساب المسار');
  try {
    const rest = S.routePoints.slice(1);
    const r = await planRoute([{ lat: pos.lat, lon: pos.lon, name: 'موقعي', mine: true }, ...rest], S.profile);
    if (!r.error && S.nav) { S.route = r; S.routePoints[0] = myPoint(); S.nav = new Navigation(r, { speak }); drawRoute(r); }
  } catch { /* keep the old route */ }
  rerouting = false;
}
function renderNav(u) {
  if (!u) return;
  $('#navIcon').innerHTML = maneuverIcon(u.next, 52);
  $('#navDist').textContent = u.next.type === 'arrive' && u.distToNext < 30 ? 'وصلت' : fmtDist(u.distToNext);
  $('#navInstr').textContent = instruction(u.next);
  const then = $('#navThen');
  if (u.nextNext && u.nextNext.distance !== undefined && u.next.distance < 400 && u.nextNext.type !== 'arrive') {
    then.hidden = false;
    then.innerHTML = `ثم ${maneuverIcon(u.nextNext, 18)} ${esc(instruction(u.nextNext))}`;
  } else then.hidden = true;
  $('#navTime').textContent = fmtDur(u.remainingTime);
  $('#navRemain').textContent = `${fmtDist(u.remaining)} · الوصول ${omanTime(Date.now() + u.remainingTime * 1000)}`;
  if (u.arrived && !S.nav.arrivedAt) {
    S.nav.arrivedAt = Date.now();
    const nav = S.nav;
    setTimeout(() => { if (S.nav === nav) { toast('وصلت إلى وجهتك'); stopNav(); } }, 4000);
  }
}

/* ---------- go to (direct, off-road) ---------- */
function startGoto(p) {
  S.goto = { lat: p.lat, lon: p.lon, name: p.name || 'الهدف' };
  if (!gps.active) { try { gps.start(); } catch { toast('الـGPS غير متاح'); } }
  gps.enableCompass();
  openPanel('goto');
  updateGoto();
}
function updateGoto() {
  const g = S.goto;
  if (!g) return;
  if (S.pos) setData('route-offroad', FC([lineF([[S.pos.lon, S.pos.lat], [g.lon, g.lat]])]));
  if (S.panel !== 'goto') return;
  const el = document.getElementById('goto-live');
  if (!el) return;
  if (!S.pos) { el.innerHTML = '<p class="muted">بانتظار تحديد موقعك بالـGPS…</p>'; return; }
  const d = haversine(S.pos.lat, S.pos.lon, g.lat, g.lon), brg = bearing(S.pos.lat, S.pos.lon, g.lat, g.lon);
  const heading = S.pos.heading;
  const rel = heading == null ? brg - map.getBearing() : angleDiff(heading, brg);
  const kmh = (S.pos.speed || 0) * 3.6;
  el.innerHTML = `<div class="goto-arrow"><svg viewBox="0 0 24 24" width="110" height="110" style="transform:rotate(${rel}deg)"><path d="M12 2l7 19-7-4-7 4z" fill="currentColor"/></svg></div>
    <div style="text-align:center"><div class="big-num">${fmtDist(d)}</div>
    <div class="sub">الاتجاه ${compassWord(brg)} · ${fmtNum(Math.round(brg))}°${heading == null ? ' (السهم بالنسبة لشمال الخريطة — حرّك الجهاز أو تحرّك ليظهر اتجاهك)' : ''}</div>
    ${kmh > 3 ? `<div class="sub">السرعة ${fmtSpeed(kmh)} · الوصول بعد ${fmtDurLong(d / (S.pos.speed || 1))}</div>` : ''}</div>`;
  if (d < 25 && !S.goto.arrived) { S.goto.arrived = true; speak('وصلت إلى الهدف'); toast('وصلت إلى الهدف'); }
}
PANELS.goto = () => `${head(`اذهب مباشرة إلى ${S.goto?.name || ''}`)}
  <p class="muted small">ملاحة بخط مستقيم بدون طرق — مناسبة للصحراء والجبال. انتبه للعوائق والأودية.</p>
  <div id="goto-live"></div>
  <div class="actions"><button class="btn danger" data-act="goto-stop">${icon('close', 18)} إنهاء</button></div>`;

/* ---------- GPS ---------- */
function updateLocButton() {
  const b = $('#locBtn');
  b.classList.toggle('active', S.follow > 0);
  b.innerHTML = icon(S.follow === 2 ? 'follow' : 'locate');
}
function onPosition(pos) {
  const first = !S.pos;
  S.pos = pos;
  if (S.awaitMine && S.routePoints.length && !S.routePoints[0]) { S.awaitMine = false; S.routePoints[0] = myPoint(); computeRoute(); }
  if (!meMarker) meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([pos.lon, pos.lat]).addTo(map);
  meMarker.setLngLat([pos.lon, pos.lat]);
  const navMode = !!S.nav;
  meEl.classList.toggle('nav', navMode);
  meEl.querySelector('.cone').style.display = pos.heading == null || navMode ? 'none' : '';
  meMarker.setRotation(pos.heading ?? 0);
  setData('accuracy', pos.acc && pos.acc < 2000 ? FC([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circle(pos.lat, pos.lon, pos.acc)] } }]) : FC());
  // trip computer
  const t = S.trip;
  if (t.last && pos.acc < 40) { const d = haversine(t.last.lat, t.last.lon, pos.lat, pos.lon); if (d > 2) { t.odo += d; if (pos.speed > 0.8) t.moving += (pos.time - t.last.time) / 1000; } }
  if (pos.acc < 40) { t.last = pos; t.max = Math.max(t.max, pos.speed || 0); }
  if (S.recorder.add(pos)) { setData('track', FC([lineF(S.recorder.points.map(p => [p[0], p[1]]))])); refreshChips(); }
  // map follow
  const kmh = (pos.speed || 0) * 3.6;
  if (S.follow) {
    const opts = { center: [pos.lon, pos.lat], duration: 600 };
    if (first) opts.zoom = Math.max(map.getZoom(), 15);
    if (S.follow === 2 && pos.heading != null) opts.bearing = pos.heading;
    if (navMode) { opts.pitch = 50; opts.zoom = kmh > 90 ? 15 : kmh > 50 ? 16 : 17; opts.offset = [0, innerHeight * 0.18]; }
    map.easeTo(opts);
  }
  // navigation
  if (S.nav) {
    const u = S.nav.update(pos);
    renderNav(u);
    if (u?.offRoute) reroute(pos);
    else if (u && (!S.lastDraw || Date.now() - S.lastDraw > 2500)) { S.lastDraw = Date.now(); drawRoute(S.route, u.snap.index); }
  }
  // speed, limit and cameras
  const showSpeed = navMode || kmh > 8;
  $('#speedBox').hidden = !showSpeed;
  if (showSpeed) {
    $('#spdVal').textContent = fmtNum(Math.round(kmh));
    if (!S.limitAt || Date.now() - S.limitAt > 4000) {
      S.limitAt = Date.now();
      router('roadAt', { lat: pos.lat, lon: pos.lon, maxDist: 35 }).then(r => { S.limit = r?.maxspeed || null; paintLimit(); }).catch(() => {});
    }
    paintLimit();
  }
  if (S.camWatch && S.settings.camAlerts && (navMode || kmh > 20)) {
    const a = S.camWatch.update(pos);
    const box = $('#camAlert');
    if (a) {
      box.hidden = false;
      box.classList.toggle('speeding', a.speeding);
      box.innerHTML = `${icon('camera', 30)}<div class="grow">كاميرا سرعة بعد ${fmtDist(a.dist)}${a.camera.speed ? ` — الحد ${fmtNum(a.camera.speed)}` : ''}</div>${a.camera.speed ? `<div class="limit">${fmtNum(a.camera.speed)}</div>` : ''}`;
      if (a.speeding && !S.beepAt || (a.speeding && Date.now() - S.beepAt > 3000)) { S.beepAt = Date.now(); navigator.vibrate?.([200, 100, 200]); }
    } else box.hidden = true;
  }
  if (S.goto) updateGoto();
  if (S.panel === 'tools') updateTrip();
}
function paintLimit() {
  const sign = $('#limitSign'), kmh = (S.pos?.speed || 0) * 3.6;
  sign.hidden = !S.limit;
  if (S.limit) sign.textContent = fmtNum(S.limit);
  $('#speedBox .speed').classList.toggle('over', !!S.limit && kmh > S.limit + 2);
}
gps.addEventListener('position', e => onPosition(e.detail));
gps.addEventListener('heading', e => {
  if (!S.pos) return;
  meMarker?.setRotation(e.detail);
  if (meEl.querySelector('.cone')) meEl.querySelector('.cone').style.display = S.nav ? 'none' : '';
  if (S.follow === 2 && !S.nav) map.easeTo({ bearing: e.detail, duration: 200 });
  if (S.goto) updateGoto();
});
gps.addEventListener('error', e => {
  const code = e.detail?.code;
  toast(code === 1 ? 'لم يُسمح بالوصول إلى الموقع — فعّله من إعدادات المتصفح' : 'تعذّر تحديد الموقع، تأكد من تشغيل الـGPS', 4500);
});

function locate() {
  if (!gps.active) { try { gps.start(); } catch { toast('المتصفح لا يدعم تحديد الموقع'); return; } S.follow = 1; updateLocButton(); if (S.pos) map.easeTo({ center: [S.pos.lon, S.pos.lat], zoom: Math.max(map.getZoom(), 15) }); return; }
  if (S.follow === 0) { S.follow = 1; if (S.pos) map.easeTo({ center: [S.pos.lon, S.pos.lat], zoom: Math.max(map.getZoom(), 15) }); }
  else if (S.follow === 1) { S.follow = 2; gps.enableCompass(); toast('وضع الاتجاه: الخريطة تدور مع اتجاهك'); }
  else { S.follow = 1; map.easeTo({ bearing: 0 }); }
  updateLocButton();
}

/* ---------- measure ---------- */
function startMeasure() { S.measure = []; S.panelArgs = null; renderMeasure(); toast('اضغط على الخريطة لإضافة نقاط القياس'); }
function addMeasurePoint(ll) { S.measure.push([ll.lng, ll.lat]); renderMeasure(); }
function stopMeasure() { S.measure = null; setData('measure', FC()); }
function renderMeasure() {
  const m = S.measure || [];
  const feats = m.map(c => pointF(c[0], c[1]));
  if (m.length > 1) feats.push(lineF(m));
  if (m.length > 2 && S.measureArea) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...m, m[0]]] } });
  setData('measure', FC(feats));
  const el = document.getElementById('measure-out');
  if (el) {
    const len = lineLength(S.measureArea && m.length > 2 ? [...m, m[0]] : m);
    el.innerHTML = `<div class="kv"><span class="k">النقاط</span><b>${fmtNum(m.length)}</b><span class="k">${S.measureArea ? 'المحيط' : 'المسافة'}</span><b>${fmtDist(len)}</b>
      ${S.measureArea && m.length > 2 ? `<span class="k">المساحة</span><b>${(() => { const a = ringArea([...m, m[0]]); return a > 1e6 ? `${fmtNum(a / 1e6, 2)} كم²` : `${fmtNum(Math.round(a))} م²`; })()}</b>` : ''}</div>`;
  }
}

/* ---------- tools ---------- */
function updateTrip() {
  const el = document.getElementById('trip');
  if (!el) return;
  const t = S.trip, p = S.pos;
  el.innerHTML = `<div class="kv">
    <span class="k">السرعة</span><b>${p ? fmtSpeed((p.speed || 0) * 3.6) : '—'}</b>
    <span class="k">أقصى سرعة</span><span>${fmtSpeed(t.max * 3.6)}</span>
    <span class="k">متوسط (أثناء الحركة)</span><span>${t.moving > 10 ? fmtSpeed((t.odo / t.moving) * 3.6) : '—'}</span>
    <span class="k">العدّاد</span><span>${fmtDist(t.odo)}</span>
    <span class="k">زمن الحركة</span><span>${t.moving > 0 ? fmtDurLong(t.moving) : '—'}</span>
    <span class="k">الاتجاه</span><span>${p?.heading != null ? `${compassWord(p.heading)} (${fmtNum(Math.round(p.heading))}°)` : '—'}</span>
    <span class="k">ارتفاع GPS</span><span>${p?.alt != null ? `${fmtNum(Math.round(p.alt))} م` : '—'}</span>
    <span class="k">دقة الموقع</span><span>${p ? `± ${fmtNum(Math.round(p.acc))} م` : '—'}</span>
    <span class="k">الإحداثيات</span><span class="num">${p ? fmtDD(p.lat, p.lon) : '—'}</span></div>`;
}
PANELS.tools = () => `${head('الأدوات')}
  <div class="card"><b>قياس المسافة والمساحة</b>
    <div class="actions">${S.measure ? `<button class="btn" data-act="measure-stop">${icon('check', 18)} إنهاء القياس</button><button class="btn ghost" data-act="measure-undo">تراجع</button>
      <button class="btn ghost" data-act="measure-area">${S.measureArea ? 'قياس مسافة' : 'قياس مساحة'}</button>` : `<button class="btn light" data-act="measure-start">${icon('ruler', 18)} ابدأ القياس</button>`}</div>
    <div id="measure-out"></div></div>
  <div class="card"><b>الانتقال إلى إحداثيات</b>
    <div class="field"><input id="coordIn" class="num" placeholder="23.5880, 58.3829 أو 23°35'N 58°23'E" inputmode="decimal"><button class="btn" data-act="coord-go">اذهب</button></div></div>
  <div class="card"><div class="row"><b class="grow">عدّاد الرحلة</b><button class="btn ghost" data-act="trip-reset">تصفير</button></div><div id="trip"></div></div>
  <div class="actions"><button class="btn light" data-act="compass">${icon('north', 18)} تفعيل البوصلة</button></div>`;

/* ---------- tracks & waypoints ---------- */
PANELS.tracks = () => {
  setTimeout(renderTrackList, 0);
  const r = S.recorder;
  return `${head('المسارات والنقاط')}
    <div class="card">${r.active ? `<div class="kv"><span class="k">المسافة</span><b>${fmtDist(r.distance)}</b><span class="k">زمن الحركة</span><span>${fmtDurLong(r.moving || 1)}</span>
      <span class="k">صعود / هبوط</span><span>${fmtNum(Math.round(r.ascent))} / ${fmtNum(Math.round(r.descent))} م</span></div>
      <div class="actions"><button class="btn" data-act="rec-pause">${icon(r.paused ? 'play' : 'pause', 18)} ${r.paused ? 'استئناف' : 'إيقاف مؤقت'}</button><button class="btn danger" data-act="rec-stop">${icon('stop', 18)} إنهاء وحفظ</button></div>`
      : `<b>تسجيل مسار الرحلة</b><p class="muted small">يسجّل طريقك بالـGPS ويحفظه لتصديره GPX أو للعودة بنفس الطريق.</p><div class="actions"><button class="btn" data-act="rec-start">${icon('rec', 18)} ابدأ التسجيل</button></div>`}</div>
    <div class="actions"><label class="btn light">${icon('upload', 18)} استيراد GPX<input type="file" accept=".gpx,application/gpx+xml" data-act="gpx-import" hidden></label>
      <button class="btn ghost" data-act="wpt-export">${icon('download', 18)} تصدير النقاط GPX</button>${S.overlay.gpx?.features?.length ? `<button class="btn ghost" data-act="gpx-clear">إخفاء المسار المعروض</button>` : ''}</div>
    <h3 class="small muted">المسارات المحفوظة</h3><ul class="list" id="trackList"><li class="muted small">…</li></ul>
    <h3 class="small muted">النقاط المحفوظة (${fmtNum(S.waypoints.length)})</h3>
    <ul class="list">${S.waypoints.map(w => `<li><button class="item" data-act="wpt-open" data-id="${w.id}"><span class="badge">${icon('star', 18)}</span><span class="grow"><div class="t">${esc(w.name)}</div><div class="s num">${fmtDD(w.lat, w.lon)}${w.ele != null ? ` · ${fmtNum(Math.round(w.ele))} م` : ''}</div></span></button></li>`).join('') || '<li class="muted small">لا توجد نقاط بعد — افتح أي موقع واضغط «حفظ نقطة».</li>'}</ul>`;
};
async function renderTrackList() {
  const el = document.getElementById('trackList');
  if (!el) return;
  const list = await listTracks();
  el.innerHTML = list.map(t => `<li class="row"><button class="item grow" data-act="track-show" data-id="${t.id}"><span class="badge">${icon('track', 18)}</span><span class="grow"><div class="t">${esc(t.name)}</div><div class="s">${fmtDist(t.distance || 0)} · ${fmtNum(t.points)} نقطة${t.imported ? ' · مستورد' : ''}</div></span></button>
    <button class="icon-btn" data-act="track-gpx" data-id="${t.id}" aria-label="تصدير">${icon('download', 18)}</button><button class="icon-btn" data-act="track-del" data-id="${t.id}" aria-label="حذف">${icon('trash', 18)}</button></li>`).join('') || '<li class="muted small">لا توجد مسارات محفوظة.</li>';
}

/* ---------- tides ---------- */
PANELS.tides = () => {
  if (!S.tideData) return `${head('المد والجزر')}<p class="muted">بيانات المد والجزر غير محمّلة.</p>`;
  const ref = S.pos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const now = Date.now();
  const rows = S.tideData.stations.map(s => ({ s, km: haversine(ref.lat, ref.lon, s.lat, s.lon) / 1000 })).sort((a, b) => a.km - b.km);
  return `${head('المد والجزر')}<p class="muted small">توقعات محسوبة من قياسات محطات المد الفعلية. الأوقات بتوقيت عُمان والارتفاع فوق أدنى جزر فلكي.</p>
    <ul class="list">${rows.map(({ s, km }) => {
      const ex = tides.extremes(s, S.tideData.table, now, now + 26 * 3600e3).slice(0, 2);
      return `<li><button class="item" data-act="panel" data-panel="tide" data-id="${s.id}"><span class="badge">${icon('wave', 18)}</span><span class="grow"><div class="t">${esc(s.ar)}</div>
        <div class="s">${ex.map(e => `${e.high ? 'مد' : 'جزر'} ${omanTime(e.t)} (${fmtNum(e.h, 2)} م)`).join(' · ')}</div></span><span class="small muted">${fmtNum(Math.round(km))} كم</span></button></li>`;
    }).join('')}</ul>`;
};
PANELS.tide = args => {
  const st = S.tideData?.stations.find(s => s.id === args.id);
  if (!st) return `${head('المد والجزر')}<p class="muted">المحطة غير موجودة.</p>`;
  const T = S.tideData.table;
  const dayOffset = args.day || 0;
  const now = Date.now();
  const dayStart = (() => { const d = new Date(now + 4 * 3600e3); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 4 * 3600e3 + dayOffset * 86400e3; })();
  const c = tides.compile(st, T, now);
  const h0 = tides.height(c, now), h1 = tides.height(c, now + 10 * 60e3);
  const ex = tides.extremes(st, T, dayStart, dayStart + 86400e3);
  const nextEx = tides.extremes(st, T, now, now + 26 * 3600e3)[0];
  // 3-day chart from the start of the selected day
  const pts = tides.curve(st, T, dayStart, dayStart + 3 * 86400e3, 20);
  const W = 340, H = 120, hMax = st.hat + 0.1;
  const x = t => ((t - dayStart) / (3 * 86400e3)) * W, y = h => H - 8 - (h / hMax) * (H - 16);
  const path = pts.map(([t, h], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(h).toFixed(1)}`).join('');
  const nowX = x(now);
  const type = st.form < 0.25 ? 'نصف يومي' : st.form < 1.5 ? 'مختلط يغلب عليه النصف يومي' : st.form < 3 ? 'مختلط يغلب عليه اليومي' : 'يومي';
  const v = st.validation || {};
  const dayLabel = new Intl.DateTimeFormat('ar-OM', { timeZone: 'Asia/Muscat', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(dayStart + 6 * 3600e3));
  return `${head(`المد والجزر — ${st.ar}`)}
    <div class="card"><div class="row"><div class="grow"><div class="muted small">الآن</div><div class="big-num">${fmtNum(h0, 2)} م</div></div>
      <div class="sub">${h1 > h0 ? '↑ يرتفع (مد)' : '↓ ينخفض (جزر)'}</div></div>
      ${nextEx ? `<div class="sub">${nextEx.high ? 'المد العالي التالي' : 'الجزر التالي'}: ${omanTime(nextEx.t)} (${fmtNum(nextEx.h, 2)} م) بعد ${fmtDurLong((nextEx.t - now) / 1000)}</div>` : ''}</div>
    <div class="row"><button class="icon-btn" data-act="tide-day" data-id="${st.id}" data-day="${dayOffset - 1}" aria-label="اليوم السابق">${icon('back')}</button>
      <b class="grow" style="text-align:center">${dayLabel}</b>
      <button class="icon-btn" data-act="tide-day" data-id="${st.id}" data-day="${dayOffset + 1}" aria-label="اليوم التالي" style="transform:scaleX(-1)">${icon('back')}</button></div>
    <table class="tbl">${ex.map(e => `<tr><td>${e.high ? '🔼 مد عالٍ' : '🔽 جزر'}</td><td class="num">${omanTime(e.t)}</td><td class="num">${fmtNum(e.h, 2)} م</td></tr>`).join('')}</table>
    <svg class="chart" viewBox="0 0 ${W} ${H}" style="margin-top:10px;transform:scaleX(-1)"><path d="${path}L${W},${H}L0,${H}Z" fill="rgba(2,132,199,.15)"/><path d="${path}" fill="none" stroke="#0284c7" stroke-width="2"/>
      ${nowX >= 0 && nowX <= W ? `<line x1="${nowX}" x2="${nowX}" y1="0" y2="${H}" stroke="#dc2626" stroke-dasharray="3 3"/>` : ''}
      ${[1, 2].map(d => `<line x1="${(W * d) / 3}" x2="${(W * d) / 3}" y1="0" y2="${H}" stroke="var(--line)"/>`).join('')}</svg>
    <p class="muted small">المنحنى لثلاثة أيام؛ الخط الأحمر = الآن.</p>
    <div class="card"><div class="kv"><span class="k">أعلى مد فلكي</span><span>${fmtNum(st.hat, 2)} م</span><span class="k">متوسط المد العالي (الربيعي)</span><span>${fmtNum(st.mhws, 2)} م</span>
      <span class="k">متوسط الجزر (الربيعي)</span><span>${fmtNum(st.mlws, 2)} م</span><span class="k">نوع المد</span><span>${type}</span>
      <span class="k">مصدر البيانات</span><span class="small">${esc(st.source)}</span>
      <span class="k">دقة الاختبار</span><span class="small">${v.time_mae_min != null ? `الوقت ± ${fmtNum(v.time_mae_min)} دقيقة، الارتفاع ± ${fmtNum(v.height_mae_cm)} سم (فترة اختبار لم تُستخدم في الحساب)` : '—'}</span></div></div>
    <div class="warn-box">توقعات فلكية لا تشمل تأثير الرياح والضغط الجوي. لا تعتمد عليها وحدها في الملاحة البحرية أو عبور المناطق المغمورة.</div>`;
};

/* ---------- sun & moon ---------- */
PANELS.sun = () => {
  const ref = S.pos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const st = sunTimes(Date.now(), ref.lat, ref.lon), mp = moonPhase(Date.now());
  const t = v => (Number.isFinite(v) ? omanTime(v) : '—');
  return `${head('الشمس والقمر')}<p class="muted small">${S.pos ? 'لموقعك الحالي' : 'لمركز الخريطة'} · بتوقيت عُمان</p>
    <div class="card"><div class="kv"><span class="k">الفجر (الشفق المدني)</span><span>${t(st.dawn)}</span><span class="k">الشروق</span><b>${t(st.sunrise)}</b>
      <span class="k">الظهيرة الشمسية</span><span>${t(st.solarNoon)}</span><span class="k">الغروب</span><b>${t(st.sunset)}</b><span class="k">آخر ضوء</span><span>${t(st.dusk)}</span>
      <span class="k">طول النهار</span><span>${fmtDurLong((st.sunset - st.sunrise) / 1000)}</span></div></div>
    <div class="card"><div class="kv"><span class="k">طور القمر</span><b>${moonPhaseName(mp.phase)}</b><span class="k">الإضاءة</span><span>${fmtNum(Math.round(mp.fraction * 100))}٪</span></div></div>
    <p class="muted small">مفيد لتخطيط الرحلات الصحراوية والتخييم: احرص على الوصول قبل آخر ضوء.</p>`;
};

/* ---------- layers & settings ---------- */
PANELS.layers = () => {
  const sh = S.settings.show;
  const t = (key, label, note = '') => `<label class="toggle"><input type="checkbox" data-act="toggle-layer" data-key="${key}" ${sh[key] ? 'checked' : ''}><span class="grow">${label}${note ? `<div class="muted small">${note}</div>` : ''}</span></label>`;
  return `${head('الطبقات')}
    <div class="seg" role="group" aria-label="نمط الخريطة">${[['auto', 'تلقائي'], ['light', 'نهاري'], ['dark', 'ليلي']].map(([v, l]) => `<button data-act="theme" data-v="${v}" aria-pressed="${S.settings.theme === v}">${l}</button>`).join('')}</div>
    <div style="margin-top:8px">
    ${t('offroad', 'الطرق الترابية والممرات والجروف', 'تمييز طرق الدفع الرباعي')}
    ${t('hillshade', 'تظليل التضاريس')}
    ${t('contours', 'خطوط الكنتور (الارتفاعات)')}
    ${t('peaks', 'القمم وارتفاعاتها')}
    ${t('cameras', 'كاميرات السرعة')}
    ${t('tides', 'محطات المد والجزر')}
    ${t('satellite', 'صور الأقمار الصناعية', 'تحتاج إنترنت (Esri)')}
    <label class="toggle"><input type="checkbox" data-act="toggle-3d" ${S.terrain3d ? 'checked' : ''}><span class="grow">عرض ثلاثي الأبعاد للتضاريس</span></label></div>
    <div class="seg" role="group" aria-label="لغة الأسماء" style="margin-top:8px">${[['ar', 'الأسماء بالعربية'], ['en', 'English names']].map(([v, l]) => `<button data-act="lang" data-v="${v}" aria-pressed="${S.settings.lang === v}">${l}</button>`).join('')}</div>`;
};
PANELS.settings = () => `${head('الإعدادات')}
  <label class="toggle"><input type="checkbox" data-act="set" data-key="voice" ${S.settings.voice ? 'checked' : ''}><span class="grow">التوجيه الصوتي بالعربية</span></label>
  <label class="toggle"><input type="checkbox" data-act="set" data-key="camAlerts" ${S.settings.camAlerts ? 'checked' : ''}><span class="grow">تنبيهات كاميرات السرعة</span></label>
  <div class="card"><b>جودة التضاريس عند التنزيل</b><div class="seg" style="margin-top:8px">${[[10, 'خفيفة'], [11, 'متوسطة'], [12, 'عالية جداً']].map(([z, l]) => `<button data-act="terrain-q" data-z="${z}" aria-pressed="${S.settings.terrainZoom === z}">${l} (~${fmtNum(region.ARCHIVES.terrain.approxMB[z])} م.ب)</button>`).join('')}</div></div>
  <div class="actions"><button class="btn ghost" data-act="test-voice">${icon('volume', 18)} تجربة الصوت</button></div>`;

PANELS.about = () => `${head('المصادر والدقة')}
  <div class="card small"><b>الخريطة والطرق والأماكن:</b> © مساهمو OpenStreetMap (ترخيص ODbL)، عبر Protomaps وopenstreetmap.fr — بيانات حتى ${esc(S.manifest?.osmTimestamp?.slice(0, 10) || 'أكتوبر ٢٠٢٦')}.</div>
  <div class="card small"><b>التضاريس:</b> Mapterhorn (بيانات ارتفاع عالمية ~٣٠ م).</div>
  <div class="card small"><b>المد والجزر:</b> ثوابت توافقية حسبناها من قياسات محطات UHSLC (مسقط، مصيرة، صلالة) وIOC (قريات، الأشخرة، الدقم، مجيس، خور ودام، دبا)، مع اختبار الدقة على فترات لم تدخل في الحساب.</div>
  <div class="card small"><b>كاميرات السرعة:</b> من OpenStreetMap (${fmtNum(S.cameras.length)} كاميرا) — قد تكون ناقصة أو قديمة؛ اتبع اللوحات دائماً.</div>
  <div class="card small"><b>الملاحة بدون نت:</b> محرك مسارات داخل التطبيق يراعي الاتجاه الواحد و${fmtNum(3781)} قيداً على الانعطاف، ويدعم الطرق الترابية لسيارات الدفع الرباعي.</div>
  <div class="warn-box">التطبيق مساعد للملاحة. انتبه للطريق واتبع الإشارات والأنظمة المرورية، وتحقق من حالة الأودية والطرق الترابية قبل السفر.</div>
  <div class="actions"><button class="btn light" data-act="install">${icon('download', 18)} تثبيت التطبيق على الجهاز</button></div>`;

/* ---------- offline manager ---------- */
PANELS.offline = () => {
  setTimeout(refreshOffline, 0);
  return `${head('الخرائط بدون إنترنت')}<div id="offline-body"><p class="muted">…</p></div>`;
};
async function refreshOffline() {
  const el = document.getElementById('offline-body');
  if (!el) return;
  const st = await region.status();
  const mb = b => `${fmtNum(b / 1048576, b > 1048576 * 100 ? 0 : 1)} م.ب`;
  const row = (id, rec, extra = '') => {
    const d = S.download?.parts?.[id];
    const state = rec?.status === 'complete' ? `<span class="chip ok">${icon('check', 14)} جاهز</span>` : rec?.status === 'partial' ? '<span class="chip warn">غير مكتمل</span>' : '<span class="chip">غير منزّل</span>';
    return `<div class="card"><div class="row"><b class="grow">${region.ARCHIVES[id].label}</b>${state}</div>
      <div class="muted small">${rec ? `${mb(rec.bytes)} · تفاصيل حتى مستوى ${fmtNum(rec.header?.maxZoom ?? rec.params?.maxZoom)}${rec.imported ? ' · مستورد من ملف' : ''}` : id === 'basemap' ? `حوالي ${fmtNum(region.ARCHIVES.basemap.approxMB)} م.ب — كل الطرق والأسماء والمباني` : `حوالي ${fmtNum(region.ARCHIVES.terrain.approxMB[S.settings.terrainZoom])} م.ب — تظليل، كنتور، ارتفاعات`}</div>
      ${d ? `<div class="progress"><i style="width:${Math.round(d.pct * 100)}%"></i></div><div class="muted small">${esc(d.text || '')}</div>` : ''}
      ${extra}
      ${rec?.status === 'complete' ? `<div class="actions"><button class="btn ghost" data-act="dl-export" data-id="${id}">${icon('download', 16)} حفظ كملف .pmtiles</button><button class="btn danger" data-act="dl-delete" data-id="${id}">${icon('trash', 16)} حذف</button></div>` : ''}</div>`;
  };
  const allReady = st.basemap?.status === 'complete' && st.terrain?.status === 'complete' && st.data.cached === st.data.total;
  const used = st.storage ? `${mb(st.storage.usage)} من ${mb(st.storage.quota)}` : 'غير معروف';
  el.innerHTML = `
    <p class="sub">نزّل خريطة عُمان كاملة على جهازك لتعمل الخريطة والبحث والملاحة والتضاريس والمد والجزر بدون إنترنت.</p>
    <div class="card"><div class="row"><b class="grow">البيانات (بحث، طرق للملاحة، كاميرات، مد وجزر)</b>${st.data.cached === st.data.total ? `<span class="chip ok">${icon('check', 14)} جاهز</span>` : `<span class="chip">${fmtNum(st.data.cached)}/${fmtNum(st.data.total)}</span>`}</div>
      <div class="muted small">حوالي ٩ م.ب</div>${S.download?.parts?.data ? `<div class="progress"><i style="width:${Math.round(S.download.parts.data.pct * 100)}%"></i></div>` : ''}</div>
    ${row('basemap', st.basemap)}
    ${row('terrain', st.terrain, `<div class="seg" style="margin-top:8px">${[[10, 'خفيفة'], [11, 'متوسطة'], [12, 'عالية']].map(([z, l]) => `<button data-act="terrain-q" data-z="${z}" aria-pressed="${S.settings.terrainZoom === z}">${l}</button>`).join('')}</div>`)}
    <div class="actions">${S.download ? `<button class="btn danger" data-act="dl-cancel">${icon('stop', 18)} إيقاف</button>` : allReady ? `<button class="btn light" data-act="dl-update">${icon('download', 18)} تحديث البيانات</button>` : `<button class="btn big" data-act="dl-start">${icon('download')} ${st.basemap?.status === 'partial' || st.terrain?.status === 'partial' ? 'استئناف التنزيل' : 'تنزيل الكل'}</button>`}</div>
    <div class="muted small">المساحة المستخدمة: ${used} · ${st.persisted ? 'التخزين محمي من الحذف التلقائي ✓' : 'قد يحذف المتصفح البيانات عند امتلاء الجهاز'}</div>
    ${st.persisted ? '' : `<div class="actions"><button class="btn ghost" data-act="dl-persist">طلب تخزين دائم</button></div>`}
    <div class="card"><b>استيراد ملف خرائط</b><p class="muted small">إن كان لديك ملف .pmtiles (مثلاً نسخته من جهاز آخر أو أنشأته بأداة pmtiles)، يمكنك استيراده بدون إنترنت.</p>
      <label class="btn light">${icon('upload', 18)} اختيار ملف<input type="file" accept=".pmtiles" data-act="dl-import" hidden></label></div>
    <p class="muted small">التنزيل يُستأنف تلقائياً إن انقطع الاتصال. يُفضّل استخدام شبكة Wi-Fi.</p>`;
  fillIcons(el);
}

async function startDownload(update = false) {
  if (S.download) return;
  if (!navigator.onLine) { toast('التنزيل يحتاج اتصالاً بالإنترنت'); return; }
  const ctrl = new AbortController();
  S.download = { ctrl, pct: 0, parts: {} };
  region.requestPersist();
  keepAwake(true);
  const parts = S.download.parts;
  const tick = () => { const p = Object.values(parts); S.download && (S.download.pct = p.length ? p.reduce((s, x) => s + x.pct, 0) / 3 : 0); refreshChips(); if (S.panel === 'offline') refreshOffline(); };
  let ticking = 0;
  const throttled = () => { const now = Date.now(); if (now - ticking > 700) { ticking = now; tick(); } };
  try {
    parts.data = { pct: 0 }; tick();
    await region.downloadData({ force: update, onProgress: f => { parts.data.pct = f; throttled(); } });
    for (const id of ['basemap', 'terrain']) {
      const rec = await DB.get('archives', id);
      const wantZoom = id === 'terrain' ? S.settings.terrainZoom : region.ARCHIVES[id].maxZoom;
      if (!update && rec?.status === 'complete' && (id !== 'terrain' || rec.params?.maxZoom === wantZoom)) { parts[id] = { pct: 1, text: 'جاهز' }; continue; }
      parts[id] = { pct: 0, text: 'تجهيز قائمة البلاطات…' }; tick();
      await region.downloadArchive(id, {
        maxZoom: wantZoom, signal: ctrl.signal,
        onProgress: p => {
          if (p.phase === 'plan') parts[id].text = p.targets ? `تحديد ${fmtNum(p.targets)} بلاطة…` : 'قراءة فهرس الخريطة…';
          else { parts[id].pct = p.total ? p.done / p.total : 0; parts[id].text = `${fmtNum(p.done / 1048576, 0)} / ${fmtNum(p.total / 1048576, 0)} م.ب`; }
          throttled();
        },
      });
      parts[id] = { pct: 1, text: 'اكتمل' };
    }
    toast('اكتمل التنزيل — التطبيق جاهز للعمل بدون إنترنت', 4500);
    reloadTiles();
    terrainChanged();
    if (!S.places) loadData();
  } catch (err) {
    if (ctrl.signal.aborted) toast('تم إيقاف التنزيل — يمكنك الاستئناف لاحقاً');
    else toast(`توقف التنزيل: ${err.message} — اضغط «استئناف»`, 5000);
  }
  S.download = null;
  keepAwake(!!S.nav || S.recorder.active);
  refreshChips();
  if (S.panel === 'offline') refreshOffline();
}
async function terrainChanged() { await loadTerrainScope(); restyle(); }
function reloadTiles() {
  const sources = map.getStyle().sources;
  for (const id of ['protomaps', 'terrain', 'terrain3d']) map.getSource(id)?.setTiles?.(sources[id].tiles);
}

/* ---------- UI wiring ---------- */
function wireUI() {
  wireSearch();
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
  S.install = async () => {
    if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; return; }
    toast(/iphone|ipad/i.test(navigator.userAgent) ? 'في Safari: زر المشاركة ← «إضافة إلى الشاشة الرئيسية»' : 'من قائمة المتصفح اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية»', 6000);
  };
}

const ACTIONS = {
  menu: openDrawer, 'drawer-close': closeDrawer, close: closePanel, back,
  panel: el => openPanel(el.dataset.panel, el.dataset.id ? { id: el.dataset.id } : undefined),
  'sheet-size': () => { S.sheetFull = !S.sheetFull; $('#sheet').classList.toggle('full', S.sheetFull); },
  locate, north: () => map.easeTo({ bearing: 0, pitch: S.terrain3d ? map.getPitch() : 0 }),
  terrain3d: () => toggle3D(!S.terrain3d),
  copy: el => copyText(el.dataset.text),
  share: async () => {
    const p = S.pick; if (!p) return;
    const url = `${location.href.split('#')[0]}#${p.lat.toFixed(6)},${p.lon.toFixed(6)},${Math.round(Math.max(map.getZoom(), 14))}${p.name ? `,${encodeURIComponent(p.name)}` : ''}`;
    const text = `${p.name || 'موقع'} — ${fmtDD(p.lat, p.lon)}\nhttps://www.google.com/maps?q=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
    if (navigator.share) { try { await navigator.share({ title: p.name || 'موقع', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    copyText(`${text}\n${url}`);
  },
  directions: () => S.pick && startDirections(S.pick),
  'goto-start': () => S.pick && startGoto(S.pick),
  'goto-stop': () => { S.goto = null; setData('route-offroad', FC()); closePanel(); },
  'wpt-save': () => S.pick && saveWaypoint(S.pick),
  'wpt-delete': async () => { const w = S.pick?.waypoint; if (!w) return; S.waypoints = S.waypoints.filter(x => x.id !== w.id); await saveWaypoints(S.waypoints); drawWaypoints(); closePanel(); toast('تم الحذف'); },
  'wpt-open': el => { const w = S.waypoints.find(x => x.id === el.dataset.id); if (w) { map.flyTo({ center: [w.lon, w.lat], zoom: 15 }); openPlace({ ...w, waypoint: w }); } },
  'wpt-export': () => download('oman-waypoints.gpx', toGPX({ name: 'نقاط محفوظة', waypoints: S.waypoints })),
  profile: el => { S.profile = el.dataset.p; S.settings.profile = S.profile; saveSettings(); computeRoute(); },
  'route-swap': () => { S.routePoints.reverse(); computeRoute(); },
  'route-mine': () => { S.routePoints[0] = myPoint(); computeRoute(); },
  'route-pick': el => { const i = +el.dataset.i; S.pickFor = p => { S.routePoints[i] = { ...p, name: 'نقطة على الخريطة' }; computeRoute(); }; toast('اضغط على الخريطة لاختيار النقطة'); if (innerWidth < 900) S.sheetFull = false; },
  'route-del': el => { S.routePoints.splice(+el.dataset.i, 1); computeRoute(); },
  'route-add': () => { S.pickFor = p => { S.routePoints.splice(S.routePoints.length - 1, 0, { ...p, name: 'نقطة توقف' }); computeRoute(); }; toast('اضغط على الخريطة لإضافة نقطة توقف'); },
  'route-gpx': () => S.route && download('oman-route.gpx', toGPX({ name: 'مسار', routes: [{ name: S.routePoints.map(p => p.name).join(' ← '), points: S.route.coords }], tracks: [{ name: 'مسار', points: S.route.coords }] })),
  step: el => { const s = S.route?.steps[+el.dataset.i]; if (s) map.flyTo({ center: s.location, zoom: 17 }); },
  'nav-start': startNav, 'nav-stop': stopNav,
  'nav-voice': () => { S.settings.voice = !S.settings.voice; saveSettings(); $('#voiceBtn').innerHTML = icon(S.settings.voice ? 'volume' : 'mute'); toast(S.settings.voice ? 'التوجيه الصوتي مفعّل' : 'تم كتم الصوت'); },
  'nav-steps': () => { openPanel('route'); },
  'nav-overview': () => { S.follow = 0; updateLocButton(); fitLine(S.route?.coords); },
  'rec-start': () => { if (!gps.active) { try { gps.start(); } catch { toast('الـGPS غير متاح'); return; } } S.recorder.start(); keepAwake(true); setData('track', FC()); refreshChips(); rerender('tracks'); toast('بدأ تسجيل المسار'); },
  'rec-pause': () => { S.recorder.paused = !S.recorder.paused; rerender('tracks'); },
  'rec-stop': async () => { const t = S.recorder.stop(); keepAwake(!!S.nav); refreshChips(); if (t.points.length > 1) { await saveTrack(t); toast('تم حفظ المسار'); } else toast('المسار قصير جداً ولم يُحفظ'); rerender('tracks'); },
  'track-show': async el => { const t = await loadTrack(el.dataset.id); if (!t) return; setData('gpx', FC([lineF(t.points.map(p => [p[0], p[1]]), { name: t.name })])); fitLine(t.points); },
  'track-gpx': async el => { const t = await loadTrack(el.dataset.id); if (t) download(`${t.name.replace(/[\\/:*?"<>|]/g, '-')}.gpx`, toGPX({ name: t.name, tracks: [t] })); },
  'track-del': async el => { if (!confirm('حذف هذا المسار؟')) return; await deleteTrack(el.dataset.id); renderTrackList(); },
  'gpx-clear': () => { setData('gpx', FC()); rerender('tracks'); },
  'measure-start': () => { startMeasure(); rerender('tools'); renderMeasure(); },
  'measure-stop': () => { stopMeasure(); S.measureArea = false; rerender('tools'); },
  'measure-undo': () => { S.measure?.pop(); renderMeasure(); },
  'measure-area': () => { S.measureArea = !S.measureArea; rerender('tools'); renderMeasure(); },
  'coord-go': () => { const c = parseCoords($('#coordIn')?.value || ''); if (!c) { toast('صيغة الإحداثيات غير مفهومة'); return; } map.flyTo({ center: [c.lon, c.lat], zoom: 15 }); openPlace({ lat: c.lat, lon: c.lon }); },
  'trip-reset': () => { S.trip = { odo: 0, max: 0, moving: 0, last: null }; updateTrip(); },
  compass: async () => { toast((await gps.enableCompass()) ? 'تم تفعيل البوصلة' : 'البوصلة غير متاحة على هذا الجهاز'); },
  'tide-day': el => openPanelReplace('tide', { id: el.dataset.id, day: +el.dataset.day }),
  theme: el => { S.settings.theme = el.dataset.v; saveSettings(); restyle(); rerender('layers'); },
  lang: el => { S.settings.lang = el.dataset.v; saveSettings(); restyle(); rerender('layers'); },
  'terrain-q': el => { S.settings.terrainZoom = +el.dataset.z; saveSettings(); rerender('settings'); if (S.panel === 'offline') refreshOffline(); },
  'test-voice': () => { const v = S.settings.voice; S.settings.voice = true; speak('بعد ٣٠٠ متر، انعطف يميناً إلى شارع السلطان قابوس'); S.settings.voice = v; },
  install: () => S.install?.(),
  'dl-start': () => startDownload(false), 'dl-update': () => startDownload(true),
  'dl-cancel': () => S.download?.ctrl.abort(),
  'dl-delete': async el => { if (!confirm('حذف هذه البيانات من الجهاز؟')) return; await region.removeArchive(el.dataset.id); reloadTiles(); terrainChanged(); refreshOffline(); },
  'dl-export': async el => { try { const blob = await region.exportArchive(el.dataset.id); const url = URL.createObjectURL(blob); const a = Object.assign(document.createElement('a'), { href: url, download: `oman-${el.dataset.id}.pmtiles` }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); } catch (e) { toast(e.message); } },
  'dl-persist': async () => { toast((await region.requestPersist()) ? 'تم تفعيل التخزين الدائم' : 'لم يوافق المتصفح — ثبّت التطبيق على الشاشة الرئيسية ليزيد احتمال الموافقة', 5000); refreshOffline(); },
};
function openPanelReplace(name, args) { S.panel = name; S.panelArgs = args; renderPanel(); }

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
}
async function onChange(e) {
  const el = e.target;
  const act = el.dataset.act;
  if (act === 'toggle-layer') {
    const key = el.dataset.key;
    if (key === 'satellite' && el.checked && !navigator.onLine) { toast('صور الأقمار الصناعية تحتاج اتصالاً بالإنترنت'); }
    S.settings.show[key] = el.checked; saveSettings(); setGroup(key, el.checked);
  } else if (act === 'toggle-3d') toggle3D(el.checked);
  else if (act === 'set') { S.settings[el.dataset.key] = el.checked; saveSettings(); }
  else if (act === 'gpx-import' && el.files?.[0]) {
    try {
      const g = parseGPX(await el.files[0].text());
      for (const t of [...g.tracks, ...g.routes]) await saveTrack({ id: `i${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: t.name || el.files[0].name, started: Date.now(), points: t.points, distance: lineLength(t.points), imported: true });
      if (g.waypoints.length) { S.waypoints = [...g.waypoints.map((w, i) => ({ id: `w${Date.now()}${i}`, name: w.name || 'نقطة', lat: w.lat, lon: w.lon, ele: w.ele, created: Date.now() })), ...S.waypoints]; await saveWaypoints(S.waypoints); drawWaypoints(); }
      const all = [...g.tracks, ...g.routes];
      if (all.length) { setData('gpx', FC(all.map(t => lineF(t.points.map(p => [p[0], p[1]]))))); fitLine(all.flatMap(t => t.points)); }
      toast(`تم استيراد ${fmtNum(all.length)} مسار و${fmtNum(g.waypoints.length)} نقطة`);
      rerender('tracks');
    } catch (err) { toast(err.message); }
    el.value = '';
  } else if (act === 'dl-import' && el.files?.[0]) {
    try {
      toast('جارٍ الاستيراد…');
      const rec = await region.importArchive(el.files[0], {});
      toast(`تم استيراد ${rec.id === 'basemap' ? 'الخريطة' : 'التضاريس'}`);
      reloadTiles(); terrainChanged(); refreshOffline();
    } catch (err) { toast(err.message); }
    el.value = '';
  }
}

function toggle3D(on) {
  S.terrain3d = on;
  $('#btn3d').classList.toggle('active', on);
  if (on) { map.setTerrain({ source: 'terrain3d', exaggeration: 1.3 }); map.easeTo({ pitch: 60, duration: 800 }); }
  else { map.setTerrain(null); map.easeTo({ pitch: 0, duration: 600 }); }
  rerender('layers');
}

boot();

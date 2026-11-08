// MapLibre style: Protomaps basemap (served by the service worker from the offline archive)
// plus terrain shading, contours, off-road emphasis and the app's overlays.
import { layers, namedFlavor } from '../vendor/protomaps-basemaps.mjs';

export const BASE = new URL('..', import.meta.url).href;

const ATTR_OSM = '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const ATTR_DEM = '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>';

export const OVERLAY_SOURCES = ['route', 'route-offroad', 'track', 'gpx', 'measure', 'marks', 'peaks', 'cameras', 'tides', 'accuracy', 'pick'];
const empty = () => ({ type: 'FeatureCollection', features: [] });

function basemap(flavor, lang) {
  const L = layers('protomaps', namedFlavor(flavor), { lang });
  // Noto Sans Italic has no Arabic glyphs; Arabic water names would vanish.
  return JSON.parse(JSON.stringify(L).replaceAll('Noto Sans Italic', 'Noto Sans Regular'));
}

/**
 * opts: { flavor: 'light'|'dark', lang: 'ar'|'en', show: {hillshade, contours, offroad, satellite, cameras, tides, peaks},
 *         contourTiles: url, data: {sourceId: GeoJSON} }
 */
export function buildStyle(opts) {
  const { flavor = 'light', lang = 'ar', show = {}, contourTiles, data = {}, terrain: dem = {} } = opts;
  // dem: { maxzoom, bounds } of the terrain that can actually be served (offline: the downloaded archive)
  const demExtra = { maxzoom: dem.maxzoom ?? 12, ...(dem.bounds ? { bounds: dem.bounds } : {}) };
  const hasDem = dem.available !== false;
  const dark = flavor === 'dark';
  const vis = on => (on ? 'visible' : 'none');
  const sources = {
    protomaps: { type: 'vector', tiles: [`${BASE}tiles/basemap/{z}/{x}/{y}.mvt`], minzoom: 0, maxzoom: 15, attribution: ATTR_OSM },
    terrain: { type: 'raster-dem', tiles: [`${BASE}tiles/terrain/{z}/{x}/{y}.webp`], tileSize: 512, minzoom: 0, encoding: 'terrarium', attribution: ATTR_DEM, ...demExtra },
    terrain3d: { type: 'raster-dem', tiles: [`${BASE}tiles/terrain/{z}/{x}/{y}.webp`], tileSize: 512, minzoom: 0, encoding: 'terrarium', ...demExtra },
    satellite: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri' },
  };
  if (contourTiles && hasDem) sources.contours = { type: 'vector', tiles: [contourTiles], maxzoom: 15, ...(dem.bounds ? { bounds: dem.bounds } : {}) };
  for (const id of OVERLAY_SOURCES) sources[id] = { type: 'geojson', data: data[id] || empty() };

  const base = basemap(flavor, lang);
  const before = id => base.findIndex(l => l.id === id);
  const insert = (anchorId, newLayers) => { const i = before(anchorId); base.splice(i < 0 ? base.length : i, 0, ...newLayers); };

  const brown = dark ? '#d8a878' : '#8a5a2b';
  // satellite imagery sits above land/water fills and below roads and labels
  insert('roads_tunnels_other_casing', [{ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: vis(show.satellite) }, paint: { 'raster-opacity': 1 } }]);
  insert('water', [
    { id: 'hillshade', type: 'hillshade', source: 'terrain', layout: { visibility: vis(show.hillshade && hasDem) },
      paint: { 'hillshade-exaggeration': dark ? 0.35 : 0.45, 'hillshade-shadow-color': dark ? '#000000' : '#5b4a32',
        'hillshade-highlight-color': dark ? '#3a3a3a' : '#ffffff', 'hillshade-accent-color': dark ? '#222222' : '#6e5d45' } },
    ...(contourTiles && hasDem ? [{
      id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 9, layout: { visibility: vis(show.contours), 'line-join': 'round' },
      paint: { 'line-color': brown, 'line-opacity': ['match', ['get', 'level'], 1, 0.55, 0.3], 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.6] },
    }] : []),
  ]);
  insert('roads_minor_service_casing', [
    { id: 'cliffs', type: 'line', source: 'protomaps', 'source-layer': 'earth', minzoom: 12, filter: ['==', ['get', 'kind'], 'cliff'],
      layout: { visibility: vis(show.offroad) }, paint: { 'line-color': dark ? '#c9b49a' : '#4e3b2a', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 16, 2.2] } },
  ]);
  insert('roads_bridges_other_casing', [
    { id: 'tracks-casing', type: 'line', source: 'protomaps', 'source-layer': 'roads', minzoom: 11,
      filter: ['==', ['get', 'kind_detail'], 'track'], layout: { visibility: vis(show.offroad), 'line-cap': 'round' },
      paint: { 'line-color': dark ? '#1b1b1b' : '#ffffff', 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 4, 17, 8] } },
    { id: 'tracks', type: 'line', source: 'protomaps', 'source-layer': 'roads', minzoom: 11,
      filter: ['==', ['get', 'kind_detail'], 'track'], layout: { visibility: vis(show.offroad) },
      paint: { 'line-color': dark ? '#e0a46c' : '#a0521e', 'line-dasharray': [2.5, 1.2], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 14, 2.2, 17, 4.5] } },
    { id: 'paths', type: 'line', source: 'protomaps', 'source-layer': 'roads', minzoom: 13,
      filter: ['in', ['get', 'kind_detail'], ['literal', ['path', 'footway', 'bridleway', 'steps', 'cycleway']]], layout: { visibility: vis(show.offroad) },
      paint: { 'line-color': dark ? '#bfae9b' : '#6f5f4f', 'line-dasharray': [1, 1.6], 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 17, 2.4] } },
    // route drawn above roads, below labels
    { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? '#0b3d91' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 12, 9, 17, 16] } },
    { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['case', ['==', ['get', 'done'], true], '#9aa0a6', ['==', ['get', 'unpaved'], true], '#d97706', '#1a73e8'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 12, 6, 17, 11] } },
    { id: 'route-offroad', type: 'line', source: 'route-offroad', paint: { 'line-color': '#d97706', 'line-width': 3, 'line-dasharray': [1, 1.5] } },
    { id: 'gpx', type: 'line', source: 'gpx', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7c3aed', 'line-width': 4, 'line-opacity': 0.85 } },
    { id: 'track', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e11d48', 'line-width': 4 } },
  ]);
  insert('address_label', contourTiles && hasDem ? [{
    id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 11, filter: ['>', ['get', 'level'], 0],
    layout: { visibility: vis(show.contours), 'symbol-placement': 'line', 'text-size': 10, 'text-font': ['Noto Sans Regular'],
      'text-field': ['concat', ['number-format', ['get', 'ele'], { locale: 'ar' }], ' م'] },
    paint: { 'text-color': brown, 'text-halo-color': dark ? '#111' : '#fff', 'text-halo-width': 1.2 },
  }] : []);

  const halo = dark ? '#111111' : '#ffffff';
  const overlays = [
    { id: 'accuracy', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.12 } },
    { id: 'accuracy-line', type: 'line', source: 'accuracy', paint: { 'line-color': '#1a73e8', 'line-opacity': 0.4, 'line-width': 1 } },
    { id: 'measure-fill', type: 'fill', source: 'measure', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#0f766e', 'fill-opacity': 0.15 } },
    { id: 'measure-line', type: 'line', source: 'measure', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#0f766e', 'line-width': 3, 'line-dasharray': [2, 1] } },
    { id: 'measure-points', type: 'circle', source: 'measure', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#0f766e', 'circle-stroke-width': 2.5 } },
    { id: 'peaks', type: 'symbol', source: 'peaks', minzoom: 9, layout: { visibility: vis(show.peaks !== false),
      'text-field': ['concat', '▲ ', ['get', 'name'], ['case', ['has', 'ele'], ['concat', '\n', ['number-format', ['get', 'ele'], { locale: 'ar' }], ' م'], '']],
      'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 13], 'text-anchor': 'top', 'text-offset': [0, -0.4],
      'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'ele'], 0]] },
      paint: { 'text-color': dark ? '#e5c9a8' : '#5a3a17', 'text-halo-color': halo, 'text-halo-width': 1.4 } },
    { id: 'marks', type: 'circle', source: 'marks', paint: { 'circle-radius': 7, 'circle-color': ['coalesce', ['get', 'color'], '#f59e0b'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
    { id: 'marks-label', type: 'symbol', source: 'marks', minzoom: 11, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top' },
      paint: { 'text-color': dark ? '#fde68a' : '#92400e', 'text-halo-color': halo, 'text-halo-width': 1.4 } },
    { id: 'tides', type: 'circle', source: 'tides', layout: { visibility: vis(show.tides !== false) }, minzoom: 5,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 5, 12, 9], 'circle-color': '#0284c7', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
    { id: 'tides-label', type: 'symbol', source: 'tides', minzoom: 7, layout: { visibility: vis(show.tides !== false), 'text-field': ['concat', '〜 ', ['get', 'name']], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
      paint: { 'text-color': '#0369a1', 'text-halo-color': halo, 'text-halo-width': 1.4 } },
    { id: 'cameras', type: 'circle', source: 'cameras', minzoom: 10, layout: { visibility: vis(show.cameras !== false) },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 14, 10], 'circle-color': '#dc2626', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
    { id: 'cameras-label', type: 'symbol', source: 'cameras', minzoom: 12, filter: ['has', 'speed'], layout: { visibility: vis(show.cameras !== false),
      'text-field': ['number-format', ['get', 'speed'], { locale: 'ar' }], 'text-font': ['Noto Sans Medium'], 'text-size': 10, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff' } },
    { id: 'pick', type: 'circle', source: 'pick', paint: { 'circle-radius': 9, 'circle-color': '#d93025', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } },
  ];

  return {
    version: 8,
    glyphs: `${BASE}assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${BASE}assets/sprites/${dark ? 'dark' : 'light'}`,
    sources,
    layers: [...base, ...overlays],
  };
}

/** Layer ids toggled together by each switch in the layers panel. */
export const LAYER_GROUPS = {
  hillshade: ['hillshade'],
  contours: ['contours', 'contour-labels'],
  offroad: ['tracks-casing', 'tracks', 'paths', 'cliffs'],
  satellite: ['satellite'],
  cameras: ['cameras', 'cameras-label'],
  tides: ['tides', 'tides-label'],
  peaks: ['peaks'],
};

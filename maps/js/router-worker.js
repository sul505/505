// Web Worker running the offline router (js/router-core.js) off the main thread.
import { decodeGraph, route, roadAt } from './router-core.js';

let graph = null, loading = null;

async function load() {
  if (graph) return graph;
  loading ||= (async () => {
    const res = await fetch(new URL('../data/oman-roads.bin.gz', import.meta.url));
    if (!res.ok) throw new Error('roads-missing');
    let u8 = new Uint8Array(await res.arrayBuffer());
    // some servers decode .gz transparently; only gunzip when the gzip magic is still there
    if (u8[0] === 0x1f && u8[1] === 0x8b) {
      u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    graph = decodeGraph(u8);
    return graph;
  })().catch(err => { loading = null; throw err; });
  return loading;
}

self.onmessage = async ({ data }) => {
  const { id, type, args = {} } = data;
  try {
    const G = await load();
    let result;
    if (type === 'route') result = route(G, args.from, args.to, args.profile, { maxSnap: args.maxSnap });
    else if (type === 'roadAt') result = roadAt(G, args.lat, args.lon, args.maxDist);
    else result = { nodes: G.N, edges: G.M };
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

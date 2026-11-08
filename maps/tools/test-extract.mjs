// End-to-end check of js/extract.js against a live archive:
//   node maps/tools/test-extract.mjs <archive-url> <out.pmtiles> <maxZoom> [worldMaxZoom]
// Writes the extract to a file so it can be checked with `pmtiles verify` / `pmtiles tile`.
import { openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { RangeSource, planExtract, runExtract, chunkStarts } from '../js/extract.js';

const [, , url, outPath, maxZoom, worldMaxZoom = '-1'] = process.argv;
const boundary = JSON.parse(readFileSync(new URL('../data/oman-boundary.json', import.meta.url)));
const polygons = boundary.geometry.coordinates.map(p => p[0]);
const source = new RangeSource(url);

const t0 = Date.now();
const plan = await planExtract(source, { polygons, maxZoom: +maxZoom, padKm: 10, worldMaxZoom: +worldMaxZoom });
console.log('plan', JSON.stringify(plan.stats), `in ${(Date.now() - t0) / 1000}s`);
const starts = chunkStarts(plan);
const fd = openSync(outPath, 'w');
await runExtract(source, plan, {
  has: async () => false,
  write: async (i, bytes) => { writeSync(fd, bytes, 0, bytes.length, starts[i]); },
  onProgress: ({ done, total }) => process.stdout.write(`\r${(100 * done / total).toFixed(1)}%   `),
});
closeSync(fd);
console.log(`\ndone in ${(Date.now() - t0) / 1000}s -> ${outPath} (${plan.stats.bytes} bytes)`);

// Lists the app-shell files for the service worker and stamps a content hash into sw.js,
// so installed copies pick up new versions. Run after changing any app file:
//   node maps/tools/build-precache.mjs
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['data', 'tools', 'node_modules']);
const SKIP_FILES = new Set(['sw.js', 'precache.json', 'package.json', 'README.md']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).split('\\').join('/');
    if (statSync(full).isDirectory()) { if (!SKIP_DIRS.has(rel)) walk(full); continue; }
    if (SKIP_FILES.has(rel) || name.endsWith('.map')) continue;
    files.push(rel);
  }
})(ROOT);
const hash = createHash('sha256');
for (const f of files) { hash.update(f); hash.update(readFileSync(join(ROOT, f))); }
const build = hash.digest('hex').slice(0, 12);
writeFileSync(join(ROOT, 'precache.json'), JSON.stringify({ build, files: ['./', ...files] }, null, 1));
const swPath = join(ROOT, 'sw.js');
writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(/const BUILD = '[^']*';/, `const BUILD = '${build}';`));
console.log(`precache: ${files.length} files, build ${build}`);

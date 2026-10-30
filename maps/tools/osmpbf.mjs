// Minimal, dependency-free OpenStreetMap PBF reader (Node.js).
// Spec: https://wiki.openstreetmap.org/wiki/PBF_Format
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const utf8 = new TextDecoder();

class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
  more() { return this.pos < this.end; }
  varint() {
    const b = this.buf;
    let byte = b[this.pos++];
    if (byte < 0x80) return byte;
    // first 28 bits with bit ops, the rest with float math (exact up to 2^53)
    let x = byte & 0x7f;
    byte = b[this.pos++]; x |= (byte & 0x7f) << 7; if (byte < 0x80) return x;
    byte = b[this.pos++]; x |= (byte & 0x7f) << 14; if (byte < 0x80) return x;
    byte = b[this.pos++]; x |= (byte & 0x7f) << 21; if (byte < 0x80) return x;
    let mul = 2 ** 28;
    do {
      byte = b[this.pos++];
      x += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte >= 0x80);
    return x;
  }
  svarint() { const n = this.varint(); return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }
  bytesView() { const len = this.varint(); const start = this.pos; this.pos += len; return [start, this.pos]; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const len = this.varint(); this.pos += len; }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

// int64 fields arrive as unsigned varints; negative values wrap around 2^64.
const int64 = n => (n >= 2 ** 63 ? n - 2 ** 64 : n);

function packedVarints(buf, [start, end], signed, delta) {
  const r = new Reader(buf, start, end);
  const out = [];
  let acc = 0;
  while (r.more()) {
    const v = signed ? r.svarint() : r.varint();
    if (delta) { acc += v; out.push(acc); } else out.push(v);
  }
  return out;
}

function tagsFrom(keys, vals, strings) {
  if (!keys.length) return null;
  const t = {};
  for (let i = 0; i < keys.length; i++) t[strings[keys[i]]] = strings[vals[i]];
  return t;
}

/**
 * Parse a whole .osm.pbf file into memory.
 * Returns { nodes: {ids: Float64Array, lat: Float64Array, lon: Float64Array, count}, tagged: [{id,lat,lon,tags}],
 *           ways: [{id, refs: Float64Array, tags}], relations: [{id, tags, members:[{type, ref, role}]}] }
 */
export function readPbf(path, { onProgress } = {}) {
  const file = readFileSync(path);
  let cap = 1 << 20, count = 0;
  let ids = new Float64Array(cap), lat = new Float64Array(cap), lon = new Float64Array(cap);
  const grow = () => {
    cap *= 2;
    const ni = new Float64Array(cap); ni.set(ids); ids = ni;
    const na = new Float64Array(cap); na.set(lat); lat = na;
    const no = new Float64Array(cap); no.set(lon); lon = no;
  };
  const tagged = [], ways = [], relations = [];
  let pos = 0, header = null;

  while (pos < file.length) {
    const hlen = file.readUInt32BE(pos); pos += 4;
    const hr = new Reader(file, pos, pos + hlen); pos += hlen;
    let type = '', datasize = 0;
    while (hr.more()) {
      const key = hr.varint(), f = key >>> 3, w = key & 7;
      if (f === 1) { const [s, e] = hr.bytesView(); type = utf8.decode(file.subarray(s, e)); }
      else if (f === 3) datasize = hr.varint();
      else hr.skip(w);
    }
    const br = new Reader(file, pos, pos + datasize); pos += datasize;
    let raw = null;
    while (br.more()) {
      const key = br.varint(), f = key >>> 3, w = key & 7;
      if (f === 1) { const [s, e] = br.bytesView(); raw = file.subarray(s, e); }
      else if (f === 3) { const [s, e] = br.bytesView(); raw = inflateSync(file.subarray(s, e)); }
      else if (f === 4 || f === 6 || f === 7) throw new Error('lzma/lz4/zstd blobs are not supported');
      else br.skip(w);
    }
    if (type === 'OSMHeader') { header = raw; continue; }
    if (type !== 'OSMData') continue;

    // PrimitiveBlock
    const pr = new Reader(raw);
    const strings = [];
    const groups = [];
    let gran = 100, latOff = 0, lonOff = 0;
    while (pr.more()) {
      const key = pr.varint(), f = key >>> 3, w = key & 7;
      if (f === 1) {
        const [s, e] = pr.bytesView();
        const sr = new Reader(raw, s, e);
        while (sr.more()) {
          const k2 = sr.varint();
          if (k2 >>> 3 === 1) { const [a, b] = sr.bytesView(); strings.push(utf8.decode(raw.subarray(a, b))); }
          else sr.skip(k2 & 7);
        }
      } else if (f === 2) groups.push(pr.bytesView());
      else if (f === 17) gran = pr.varint();
      else if (f === 19) latOff = int64(pr.varint());
      else if (f === 20) lonOff = int64(pr.varint());
      else pr.skip(w);
    }
    const scale = gran * 1e-9;

    for (const g of groups) {
      const gr = new Reader(raw, g[0], g[1]);
      while (gr.more()) {
        const key = gr.varint(), f = key >>> 3, w = key & 7;
        if (f === 2) { // DenseNodes
          const [s, e] = gr.bytesView();
          const dr = new Reader(raw, s, e);
          let idv = [], latv = [], lonv = [], kv = [];
          while (dr.more()) {
            const k2 = dr.varint(), f2 = k2 >>> 3, w2 = k2 & 7;
            if (f2 === 1) idv = packedVarints(raw, dr.bytesView(), true, true);
            else if (f2 === 8) latv = packedVarints(raw, dr.bytesView(), true, true);
            else if (f2 === 9) lonv = packedVarints(raw, dr.bytesView(), true, true);
            else if (f2 === 10) kv = packedVarints(raw, dr.bytesView(), false, false);
            else dr.skip(w2);
          }
          let ki = 0;
          for (let i = 0; i < idv.length; i++) {
            if (count === cap) grow();
            const la = (latOff * 1e-9) + latv[i] * scale, lo = (lonOff * 1e-9) + lonv[i] * scale;
            ids[count] = idv[i]; lat[count] = la; lon[count] = lo; count++;
            if (kv.length) {
              let t = null;
              while (ki < kv.length && kv[ki] !== 0) {
                (t ||= {})[strings[kv[ki]]] = strings[kv[ki + 1]];
                ki += 2;
              }
              ki++; // skip the 0 delimiter
              if (t) tagged.push({ id: idv[i], lat: la, lon: lo, tags: t });
            }
          }
        } else if (f === 1) { // plain Node
          const [s, e] = gr.bytesView();
          const nr = new Reader(raw, s, e);
          let id = 0, la = 0, lo = 0, keys = [], vals = [];
          while (nr.more()) {
            const k2 = nr.varint(), f2 = k2 >>> 3, w2 = k2 & 7;
            if (f2 === 1) id = nr.svarint();
            else if (f2 === 2) keys = packedVarints(raw, nr.bytesView(), false, false);
            else if (f2 === 3) vals = packedVarints(raw, nr.bytesView(), false, false);
            else if (f2 === 8) la = (latOff * 1e-9) + nr.svarint() * scale;
            else if (f2 === 9) lo = (lonOff * 1e-9) + nr.svarint() * scale;
            else nr.skip(w2);
          }
          if (count === cap) grow();
          ids[count] = id; lat[count] = la; lon[count] = lo; count++;
          const t = tagsFrom(keys, vals, strings);
          if (t) tagged.push({ id, lat: la, lon: lo, tags: t });
        } else if (f === 3) { // Way
          const [s, e] = gr.bytesView();
          const wr = new Reader(raw, s, e);
          let id = 0, keys = [], vals = [], refs = [];
          while (wr.more()) {
            const k2 = wr.varint(), f2 = k2 >>> 3, w2 = k2 & 7;
            if (f2 === 1) id = wr.varint();
            else if (f2 === 2) keys = packedVarints(raw, wr.bytesView(), false, false);
            else if (f2 === 3) vals = packedVarints(raw, wr.bytesView(), false, false);
            else if (f2 === 8) refs = packedVarints(raw, wr.bytesView(), true, true);
            else wr.skip(w2);
          }
          ways.push({ id, refs: Float64Array.from(refs), tags: tagsFrom(keys, vals, strings) });
        } else if (f === 4) { // Relation
          const [s, e] = gr.bytesView();
          const rr = new Reader(raw, s, e);
          let id = 0, keys = [], vals = [], roles = [], memids = [], types = [];
          while (rr.more()) {
            const k2 = rr.varint(), f2 = k2 >>> 3, w2 = k2 & 7;
            if (f2 === 1) id = rr.varint();
            else if (f2 === 2) keys = packedVarints(raw, rr.bytesView(), false, false);
            else if (f2 === 3) vals = packedVarints(raw, rr.bytesView(), false, false);
            else if (f2 === 8) roles = packedVarints(raw, rr.bytesView(), false, false);
            else if (f2 === 9) memids = packedVarints(raw, rr.bytesView(), true, true);
            else if (f2 === 10) types = packedVarints(raw, rr.bytesView(), false, false);
            else rr.skip(w2);
          }
          const members = memids.map((ref, i) => ({ type: ['node', 'way', 'relation'][types[i]], ref, role: strings[roles[i]] }));
          relations.push({ id, tags: tagsFrom(keys, vals, strings), members });
        } else gr.skip(w);
      }
    }
    if (onProgress) onProgress(pos / file.length);
  }

  // Node ids are usually sorted in extracts; sort defensively so lookups can binary search.
  let sorted = true;
  for (let i = 1; i < count; i++) if (ids[i] < ids[i - 1]) { sorted = false; break; }
  if (!sorted) {
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => ids[a] - ids[b]);
    const ni = new Float64Array(count), na = new Float64Array(count), no = new Float64Array(count);
    order.forEach((o, i) => { ni[i] = ids[o]; na[i] = lat[o]; no[i] = lon[o]; });
    ids = ni; lat = na; lon = no;
  }
  return {
    header,
    nodes: { ids: ids.subarray(0, count), lat: lat.subarray(0, count), lon: lon.subarray(0, count), count },
    tagged, ways, relations,
  };
}

/** Binary search for a node id; returns index or -1. */
export function nodeIndex(nodes, id) {
  const ids = nodes.ids;
  let lo = 0, hi = nodes.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, v = ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

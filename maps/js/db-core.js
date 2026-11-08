// IndexedDB access shared by the page (imported for its side effect) and the service worker
// (importScripts). Defines self.OmanDB.
//   archives: {id, status, chunkStarts, chunkCount, header, params, stats, created, etag, srcUrl}
//   chunks:   [archiveId, index] -> Blob (index 0 = PMTiles header + directories)
//   kv:       key -> any (settings, saved places, tracks, waypoints, ...)
(function (g) {
  const NAME = 'oman-maps', VERSION = 1;
  let dbp = null;

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('archives')) db.createObjectStore('archives', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); dbp = null; };
          resolve(db);
        };
        req.onerror = () => { dbp = null; reject(req.error); };
      });
    }
    return dbp;
  }

  const done = t => new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
  const result = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  async function read(store, fn) {
    const db = await open();
    return result(fn(db.transaction(store, 'readonly').objectStore(store)));
  }
  async function write(store, fn) {
    const db = await open();
    const t = db.transaction(store, 'readwrite');
    fn(t.objectStore(store));
    return done(t);
  }
  const chunkRange = id => IDBKeyRange.bound([id, 0], [id, Infinity]);

  g.OmanDB = {
    open,
    get: (store, key) => read(store, s => s.get(key)),
    getAll: (store, query) => read(store, s => s.getAll(query)),
    getAllKeys: (store, query) => read(store, s => s.getAllKeys(query)),
    put: (store, value, key) => write(store, s => (key === undefined ? s.put(value) : s.put(value, key))),
    del: (store, key) => write(store, s => s.delete(key)),
    chunkRange,
    /** All chunk blobs of an archive, ordered by index. */
    chunks: id => read('chunks', s => s.getAll(chunkRange(id))),
    chunkIndexes: id => read('chunks', s => s.getAllKeys(chunkRange(id))).then(keys => keys.map(k => k[1])),
    putChunk: (id, index, blob) => write('chunks', s => s.put(blob, [id, index])),
    deleteArchive: async id => {
      await write('chunks', s => s.delete(chunkRange(id)));
      await write('archives', s => s.delete(id));
    },
  };
})(self);

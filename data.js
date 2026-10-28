/**
 * Dataset loading + normalisation (runs inside the Web Worker, or on the main
 * thread as a fallback). No DOM access.
 *
 * Supported input formats
 *   v3 (current)  tiled: meta lists a station index (every system + station name) and spatial tiles
 *                 (k-d tree cells with bounding boxes). Tiles are fetched on demand around the route start.
 *   v2            meta: { version: 2, commodities: [...], systems: { NAME: [x,y,z] },
 *                         shards: [{ file, bytes, count }] | stations: {...} }
 *                 station: [pad, distLs, flags, updatedUnixSeconds, [ci,buy,sell,supply,demand, ...]]
 *                 flags: bit0 = planetary/Odyssey surface, bit1 = fleet carrier
 *   legacy (v1)   meta/shards with  station: { system, pad, distLs, planetary, market: { NAME: {buy,sell,supply,demand} } }
 *
 * Normalised form (what the optimizer uses):
 *   data.commodities : string[]
 *   data.systems     : { NAME: {x,y,z} }
 *   data.stations    : { KEY: station }
 *   station = { key, name, system, pad, distLs, planetary, carrier, updated,
 *               ids:Uint16Array (sorted), buy/sell/supply/demand: Int32Array (aligned with ids) }
 *   A price is only "live" when it has stock/demand: buy>0 requires supply>0, sell>0 requires demand>0.
 */
(function (root) {
  'use strict';

  const FLAG_PLANETARY = 1;
  const FLAG_CARRIER = 2;
  const CARRIER_NAME_RE = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;

  function splitKey(key) {
    const i = key.indexOf('/');
    return i < 0 ? { system: key, name: '' } : { system: key.slice(0, i), name: key.slice(i + 1) };
  }

  function normalizeSystems(raw) {
    const out = {};
    for (const [name, v] of Object.entries(raw || {})) {
      if (Array.isArray(v)) out[name] = { x: v[0], y: v[1], z: v[2] };
      else out[name] = { x: v.x, y: v.y, z: v.z };
    }
    return out;
  }

  /** Build a sparse, id-sorted market from [ [id,buy,sell,supply,demand], ... ] rows. */
  function packMarket(rows) {
    rows.sort((a, b) => a[0] - b[0]);
    const n = rows.length;
    const ids = new Uint16Array(n);
    const buy = new Int32Array(n), sell = new Int32Array(n);
    const supply = new Int32Array(n), demand = new Int32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      let b = r[1] | 0, s = r[2] | 0;
      const sup = Math.min(r[3], 2147483647) | 0, dem = Math.min(r[4], 2147483647) | 0;
      if (b > 0 && sup <= 0) b = 0; // nothing to buy
      if (s > 0 && dem <= 0) s = 0; // station will not take it
      if (b <= 0 && s <= 0) continue;
      ids[k] = r[0]; buy[k] = b; sell[k] = s; supply[k] = sup; demand[k] = dem; k++;
    }
    return {
      ids: ids.slice(0, k), buy: buy.slice(0, k), sell: sell.slice(0, k),
      supply: supply.slice(0, k), demand: demand.slice(0, k),
    };
  }

  function stationFromV2(key, arr) {
    const { system, name } = splitKey(key);
    const flat = arr[4] || [];
    const rows = [];
    for (let i = 0; i + 4 < flat.length; i += 5) {
      rows.push([flat[i], flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4]]);
    }
    const flags = arr[2] | 0;
    return Object.assign({
      key, name, system,
      pad: arr[0] || 'M',
      distLs: arr[1] || 0,
      planetary: !!(flags & FLAG_PLANETARY),
      carrier: !!(flags & FLAG_CARRIER),
      updated: arr[3] || 0,
    }, packMarket(rows));
  }

  function stationFromLegacy(key, st, commodityIndex, commodities) {
    const { system, name } = splitKey(key);
    const rows = [];
    for (const [cname, c] of Object.entries(st.market || {})) {
      let id = commodityIndex.get(cname);
      if (id === undefined) { id = commodities.length; commodities.push(cname); commodityIndex.set(cname, id); }
      rows.push([id, c.buy || 0, c.sell || 0, c.supply || 0, c.demand || 0]);
    }
    return Object.assign({
      key, name: st.name || name,
      system: st.system || system,
      pad: st.pad || 'M',
      distLs: st.distLs || 0,
      planetary: !!st.planetary,
      carrier: !!st.carrier || CARRIER_NAME_RE.test(name),
      updated: st.updated || 0,
    }, packMarket(rows));
  }

  /** Turn a parsed meta + parsed shard bodies into the normalised dataset. */
  function buildDataset(meta, parts) {
    const data = {
      generated_at: meta.generated_at || null,
      generatedAt: Date.parse(meta.generated_at || '') / 1000 || 0,
      source: meta.source || '',
      commodities: (meta.commodities || []).slice(),
      systems: normalizeSystems(meta.systems),
      stations: {},
      hasAges: false,
    };
    const v2 = Number(meta.version) >= 2;
    const commodityIndex = new Map(data.commodities.map((n, i) => [n, i]));
    const sources = parts.slice();
    if (meta.stations) sources.unshift({ stations: meta.stations });
    for (const part of sources) {
      const stations = part.stations || part;
      for (const key of Object.keys(stations)) {
        const st = v2 ? stationFromV2(key, stations[key]) : stationFromLegacy(key, stations[key], commodityIndex, data.commodities);
        if (st.updated) data.hasAges = true;
        data.stations[key] = st;
      }
    }
    return data;
  }

  /** Download one JSON file, reporting decoded bytes as they arrive. */
  async function fetchJson(url, onBytes, cacheMode) {
    const res = await fetch(url, { cache: cacheMode || 'default' });
    if (!res.ok) throw new Error('Could not load ' + url + ' (HTTP ' + res.status + ')');
    if (!res.body || !res.body.getReader) {
      const text = await res.text();
      if (onBytes) onBytes(text.length);
      return JSON.parse(text);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (onBytes) onBytes(value.length);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return JSON.parse(new TextDecoder('utf-8').decode(all));
  }

  function baseOf(url) { return url.includes('/') ? url.slice(0, url.lastIndexOf('/') + 1) : ''; }

  /** v1/v2: everything in a few shard files, loaded up front. */
  async function loadEager(meta, metaUrl, report) {
    const shards = (meta.shards || []).map((s) => (typeof s === 'string' ? { file: s, bytes: 0 } : s));
    const total = shards.reduce((n, s) => n + (s.bytes || 0), 0);
    let loaded = 0, filesDone = 0;
    report({ phase: 'download', loaded, total, files: 0, filesTotal: shards.length });
    const base = baseOf(metaUrl);
    const parts = await Promise.all(shards.map(async (s) => {
      const part = await fetchJson(base + s.file, (n) => {
        loaded += n;
        report({ phase: 'download', loaded, total, files: filesDone, filesTotal: shards.length });
      });
      filesDone++;
      report({ phase: 'download', loaded, total, files: filesDone, filesTotal: shards.length });
      return part;
    }));
    report({ phase: 'index', loaded, total, files: filesDone, filesTotal: shards.length });
    if (!shards.length && !meta.stations) throw new Error('trade-data.json has no stations or shards');
    const data = buildDataset(meta, parts);
    data.tiled = false;
    return data;
  }

  /** v3: download only the station index; market tiles come later via ensureTiles(). */
  async function loadTiledIndex(meta, metaUrl, report) {
    const base = baseOf(metaUrl);
    const total = (meta.index && meta.index.bytes) || 0;
    let loaded = 0;
    report({ phase: 'download', loaded, total, files: 0, filesTotal: 1 });
    const idx = await fetchJson(base + meta.index.file, (n) => {
      loaded += n;
      report({ phase: 'download', loaded, total, files: 0, filesTotal: 1 });
    });
    report({ phase: 'index', loaded, total, files: 1, filesTotal: 1 });

    const data = {
      generated_at: meta.generated_at || null,
      generatedAt: Date.parse(meta.generated_at || '') / 1000 || 0,
      source: meta.source || '',
      commodities: (meta.commodities || []).slice(),
      systems: {},
      stations: {},
      hasAges: !!meta.has_ages,
      tiled: true,
      meta, base,
      tileLoaded: new Set(),
      tilePromises: new Map(),
      tileOf: new Map(),
      indexList: [],
    };
    for (const [name, v] of Object.entries(idx.systems || {})) {
      data.systems[name] = { x: v[0], y: v[1], z: v[2] };
      for (const e of v[3]) {
        const key = name + '/' + e[0];
        data.tileOf.set(key, e[4]);
        data.indexList.push([key, e[1], e[2], e[3] || 0]);
      }
    }
    data.indexList.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return data;
  }

  /** Indices of tiles whose bounding box comes within `radius` ly of `pos`. */
  function tilesNear(data, pos, radius) {
    const out = [];
    (data.meta.tiles || []).forEach((t, i) => {
      const b = t.bbox;
      const dx = Math.max(b[0] - pos.x, 0, pos.x - b[3]);
      const dy = Math.max(b[1] - pos.y, 0, pos.y - b[4]);
      const dz = Math.max(b[2] - pos.z, 0, pos.z - b[5]);
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius + 1e-6) out.push(i);
    });
    return out;
  }

  /** Make sure the given tiles are downloaded and merged into data.stations. */
  async function ensureTiles(data, idxs, onProgress) {
    if (!data.tiled) return;
    const need = idxs.filter((i) => !data.tileLoaded.has(i));
    if (!need.length) return;
    const tiles = data.meta.tiles;
    const total = need.reduce((n, i) => n + (tiles[i].bytes || 0), 0);
    let loaded = 0, done = 0;
    const report = () => { if (onProgress) onProgress({ phase: 'tiles', loaded, total, files: done, filesTotal: need.length }); };
    report();

    function fetchTile(i) {
      let p = data.tilePromises.get(i);
      if (!p) {
        p = fetchJson(data.base + tiles[i].file, (n) => { loaded += n; report(); }).then((part) => {
          for (const key of Object.keys(part.stations)) {
            const st = stationFromV2(key, part.stations[key]);
            data.stations[key] = st;
          }
          data.tileLoaded.add(i);
          done++; report();
        }).catch((e) => { data.tilePromises.delete(i); throw e; });
        data.tilePromises.set(i, p);
      } else {
        p.then(() => { done++; report(); }, () => {});
      }
      return p;
    }

    const queue = need.slice();
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) await fetchTile(queue.shift());
    });
    await Promise.all(workers);
  }

  /**
   * Load the dataset. The small meta file is always revalidated; index/tile/shard files have
   * content-hashed names so the browser cache can keep them indefinitely.
   * onProgress({ phase, loaded, total, files, filesTotal })
   */
  async function loadDataset(metaUrl, onProgress) {
    const report = (o) => { if (onProgress) onProgress(o); };
    report({ phase: 'meta', loaded: 0, total: 0, files: 0, filesTotal: 0 });
    const meta = await fetchJson(metaUrl, null, 'no-cache');
    if (Number(meta.version) >= 3) return loadTiledIndex(meta, metaUrl, report);
    return loadEager(meta, metaUrl, report);
  }

  const api = { loadDataset, ensureTiles, tilesNear, buildDataset, FLAG_PLANETARY, FLAG_CARRIER, CARRIER_NAME_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TDData = api;
})(typeof self !== 'undefined' ? self : this);

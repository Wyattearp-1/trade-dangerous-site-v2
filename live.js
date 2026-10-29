/**
 * Live market lookups (runs in the page, not the worker).
 *
 * The nightly snapshot can be a day old, so after a search the page asks public community APIs for the
 * CURRENT market of the stations on the routes it is showing. Both APIs are fed by players' game uploads
 * through EDDN, so their data is usually minutes old, not hours. If a service is down, blocks browser
 * requests (CORS), or changes its format, lookups simply fail and the page keeps using the snapshot.
 *
 *   1. EDSM    https://www.edsm.net/api-system-v1/stations/market?systemName=..&stationName=..
 *   2. Ardent  https://api.ardent-insight.com/v1/system/name/<system>/commodities
 *
 * Normalised result per station: { rows: [[name, buy, sell, supply, demand], ...], updated: unixSeconds, provider }
 *   buy  = price you PAY to buy from the station;  sell = price you GET when selling to it.
 */
(function (root) {
  'use strict';

  const TTL_MS = 3 * 60 * 1000;      // reuse a lookup for 3 minutes
  const MISS_TTL_MS = 45 * 1000;     // remember a failed lookup briefly so we don't hammer the service
  const TIMEOUT_MS = 9000;
  const CONCURRENCY = 3;

  const cache = new Map();           // key -> { t, data }
  let pausedUntil = 0;               // set after rate limiting / repeated failures
  let failStreak = 0;
  let lastError = '';

  const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const enc = encodeURIComponent;
  function splitKey(key) { const i = key.indexOf('/'); return { system: key.slice(0, i), name: key.slice(i + 1) }; }
  function titleCase(s) { return String(s).toLowerCase().replace(/(^|[\s\-(])([a-z])/g, (m, a, b) => a + b.toUpperCase()); }

  function parseTime(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/);
    if (!m) return 0;
    let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
    if (m[7] && m[7] !== 'Z') {
      const sign = m[7][0] === '+' ? 1 : -1, d = m[7].slice(1).replace(':', '');
      t -= sign * (parseInt(d.slice(0, 2), 10) * 3600 + parseInt(d.slice(2, 4) || '0', 10) * 60);
    }
    return Math.floor(t);
  }

  /** EDSM market JSON -> normalised. */
  function parseEdsm(j) {
    if (!j || !Array.isArray(j.commodities)) return null;
    const rows = j.commodities.map((c) => [c.name || c.id, Number(c.buyPrice) || 0, Number(c.sellPrice) || 0, Number(c.stock) || 0, Number(c.demand) || 0]);
    const stamp = (j.updateTime && (j.updateTime.market || j.updateTime)) || (j.lastUpdate && (j.lastUpdate.market || j.lastUpdate)) || j.updated;
    return { rows, updated: parseTime(typeof stamp === 'object' ? '' : stamp) };
  }

  /** Ardent "commodities in a system" JSON -> normalised rows for one station. */
  function parseArdent(j, stationName) {
    let list = Array.isArray(j) ? j : (j && (j.commodities || j.data || j.results)) || null;
    if (!Array.isArray(list)) return null;
    const want = normName(stationName);
    const mine = list.filter((r) => normName(r.stationName || r.station || '') === want);
    if (!mine.length) return null;
    let newest = 0;
    const rows = mine.map((r) => {
      newest = Math.max(newest, parseTime(r.updatedAt || r.updated || r.timestamp));
      return [r.commodityName || r.name || r.symbol, Number(r.buyPrice) || 0, Number(r.sellPrice) || 0, Number(r.stock) || 0, Number(r.demand) || 0];
    });
    return { rows, updated: newest };
  }

  async function getJson(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await root.fetch(url, { mode: 'cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return await res.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  const PROVIDERS = [
    {
      name: 'EDSM',
      async fetch(system, station) {
        for (const stn of [titleCase(station), station]) {
          const j = await getJson('https://www.edsm.net/api-system-v1/stations/market?systemName=' + enc(system) + '&stationName=' + enc(stn));
          const r = parseEdsm(j);
          if (r && r.rows.length) return r;
        }
        return null;
      },
    },
    {
      name: 'Ardent',
      async fetch(system, station) {
        const j = await getJson('https://api.ardent-insight.com/v1/system/name/' + enc(system) + '/commodities');
        return parseArdent(j, station);
      },
    },
  ];

  /** One station's current market, or null. Never throws. */
  async function fetchStation(key) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.t < (hit.data ? TTL_MS : MISS_TTL_MS)) return hit.data;
    if (now < pausedUntil) return null;
    const { system, name } = splitKey(key);
    let data = null;
    for (const prov of PROVIDERS) {
      try {
        const r = await prov.fetch(system, name);
        if (r && r.rows.length) { data = Object.assign({ provider: prov.name }, r); break; }
      } catch (e) {
        lastError = prov.name + ': ' + (e && e.message ? e.message : e);
        if (e && e.status === 429) { pausedUntil = Date.now() + 60 * 1000; break; }
      }
    }
    cache.set(key, { t: Date.now(), data });
    if (data) failStreak = 0;
    else if (++failStreak >= 6) { pausedUntil = Date.now() + 5 * 60 * 1000; failStreak = 0; } // looks like it's down or blocked
    return data;
  }

  /** Look up many stations (a few at a time). onProgress(done, total). Returns { key: data | null }. */
  async function fetchMany(keys, onProgress) {
    const uniq = Array.from(new Set(keys));
    const out = {};
    let done = 0;
    const queue = uniq.slice();
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const k = queue.shift();
        out[k] = await fetchStation(k);
        done++;
        if (onProgress) onProgress(done, uniq.length);
      }
    }));
    return out;
  }

  /** Diagnostics for the About tab: try each service once on a well-known station. */
  async function selfTest(system, station) {
    system = system || 'SOL';
    station = station || 'ABRAHAM LINCOLN';
    const results = [];
    for (const prov of PROVIDERS) {
      const t0 = Date.now();
      try {
        const r = await prov.fetch(system, station);
        results.push({ provider: prov.name, ok: !!(r && r.rows.length), ms: Date.now() - t0,
          detail: r && r.rows.length ? r.rows.length + ' commodities' + (r.updated ? ', updated ' + new Date(r.updated * 1000).toLocaleString() : ', no timestamp') : 'connected, but no market data came back (unexpected format or station not found)' });
      } catch (e) {
        results.push({ provider: prov.name, ok: false, ms: Date.now() - t0,
          detail: e && e.status ? 'HTTP ' + e.status : 'request failed (' + (e && e.name === 'AbortError' ? 'timed out' : 'blocked by the browser/CORS, offline, or the service is down') + ')' });
      }
    }
    return results;
  }

  function reset() { cache.clear(); pausedUntil = 0; failStreak = 0; lastError = ''; }
  const api = { fetchStation, fetchMany, selfTest, parseEdsm, parseArdent, parseTime, titleCase, reset, get lastError() { return lastError; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TDLive = api;
})(typeof self !== 'undefined' ? self : this);

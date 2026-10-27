/**
 * Engine: owns the loaded dataset and exposes load / run / quick.
 * Used by worker.js (normal path) and by app.js directly if Web Workers are unavailable.
 *
 * With a tiled (v3) dataset only the station index is loaded up front; run() / quick() download the
 * map tiles a search can reach (cached afterwards) before searching.
 */
(function (root) {
  'use strict';

  const AGE_TIERS = [1, 6, 24, 72, 168];

  function createEngine() {
    let DATA = null;

    return {
      async load(metaUrl, onProgress) {
        DATA = await root.TDData.loadDataset(metaUrl, onProgress);
        let index;
        if (DATA.tiled) {
          index = DATA.indexList;
        } else {
          index = Object.keys(DATA.stations).sort().map((k) => {
            const s = DATA.stations[k];
            return [k, s.pad, (s.planetary ? 1 : 0) | (s.carrier ? 2 : 0), s.updated || 0];
          });
        }
        return {
          generated_at: DATA.generated_at,
          source: DATA.source,
          hasAges: DATA.hasAges,
          tiled: !!DATA.tiled,
          stationCount: index.length,
          systemNames: Object.keys(DATA.systems).sort(),
          index,
        };
      },

      /**
       * "Best within the limits" search.
       *
       * A single beam search is a heuristic: with more stations in play it can prune a better route
       * early, so a looser limit (e.g. 7-day prices) could score LOWER than a stricter one (3-day).
       * To make "looser is never worse" a guarantee, every search runs the SAME fixed schedule of beam
       * widths over EVERY price-age window up to the one you chose (1h, 6h, 24h, 3d, 7d, any), and pools
       * the results. A stricter window's routes are always valid under a looser one, and a looser setting
       * runs every pass that the stricter setting runs, so its best result can only be equal or better.
       * (The schedule is fixed, not time-based, on purpose: a time budget would make results depend on
       * machine speed and break the guarantee. `timeBudgetMs` is only a safety cap.)
       */
      async run(opts, onProgress) {
        if (!DATA) throw new Error('Data not loaded yet');
        const t0 = Date.now();
        if (DATA.tiled) {
          const i = opts.startKey.indexOf('/');
          const sys = DATA.systems[i < 0 ? opts.startKey : opts.startKey.slice(0, i)];
          if (!sys || !DATA.tileOf.has(opts.startKey)) throw new Error('Unknown starting station (not in market data): ' + opts.startKey);
          const radius = root.TDOptimizer.reachRadius(opts);
          await root.TDData.ensureTiles(DATA, root.TDData.tilesNear(DATA, sys, radius), onProgress);
        }

        const t1 = Date.now();
        const cap = Math.max(1000, opts.timeBudgetMs || 120000);
        const widths = (opts.widths && opts.widths.length ? opts.widths : [6, 12, 24, 48]).slice().sort((a, b) => a - b);
        const want = Math.max(1, opts.maxResults || 8);
        const chosen = opts.maxAgeHours || 0;

        // Price-age windows, strictest first, ending with the one the user asked for.
        const windows = [];
        if (DATA.hasAges) for (const hrs of AGE_TIERS) { if (chosen !== 0 && hrs >= chosen) break; windows.push(hrs); }
        windows.push(chosen);

        const ctx = root.TDOptimizer.createContext();
        const runOpts = Object.assign({}, opts, { _ctx: ctx });
        // A stricter window that admits exactly the same stations as the next looser one gives identical
        // results, so skip it (this is lossless).
        const counts = windows.map((hrs) => root.TDOptimizer.countStations(DATA, Object.assign({}, opts, { maxAgeHours: hrs })));
        for (let i = windows.length - 2; i >= 0; i--) {
          if (counts[i] === counts[i + 1]) { windows.splice(i, 1); counts.splice(i, 1); }
        }

        const pool = new Map();
        const addRoutes = (routes) => {
          for (const r of routes) {
            const sig = r.hops.map((h) => (h.segments || [{ to: h.to }]).map((x) => x.to.key).join('+')).join('>');
            const have = pool.get(sig);
            if (!have || r.totalProfit > have.totalProfit) pool.set(sig, r);
          }
        };
        const say = (extra) => { if (onProgress) onProgress(Object.assign({ phase: 'search', elapsed: Date.now() - t1 }, extra)); };

        // In credits-per-hour mode a beam ranked by rate can discard routes that turn out best, so we also run
        // the max-credits ranking and pool both: the answer can never be slower than the max-profit route.
        const objectives = opts.objective === 'rate' ? ['rate', 'profit'] : ['profit'];

        let passes = 0, first = null, lastWidth = widths[0], capped = false;
        outer:
        for (const w of widths) {
          for (const hrs of windows) {
            for (const obj of objectives) {
              if (passes > 0 && Date.now() - t1 > cap) { capped = true; break outer; }
              passes++;
              say({ pass: passes, width: w, note: (hrs === chosen ? 'width ' + w : 'width ' + w + ', prices ≤ ' + hrs + 'h') + (objectives.length > 1 ? ', ' + obj : '') });
              const r = root.TDOptimizer.findRoutes(DATA, Object.assign({}, runOpts, { objective: obj, maxAgeHours: hrs, beamWidth: w, branch: Math.max(12, w * 2), maxResults: want }));
              if (hrs === chosen && !first) first = r;
              addRoutes(r.routes);
            }
          }
          lastWidth = w;
        }

        const rateMode = opts.objective === 'rate';
        let routes = Array.from(pool.values())
          .sort((a, b) => (rateMode ? b.profitPerHour - a.profitPerHour : b.totalProfit - a.totalProfit) || a.totalDist - b.totalDist)
          .slice(0, want);
        if (opts.minRouteProfit > 0) routes = routes.filter((r) => r.totalProfit >= opts.minRouteProfit);
        return {
          routes,
          warnings: (first || { warnings: [] }).warnings.concat(capped ? ['Search stopped early at the safety time limit; results may not be the best possible.'] : []),
          stats: (first || { stats: { stationsConsidered: 0 } }).stats,
          passes,
          width: lastWidth,
          ms: Date.now() - t0,
        };
      },

      async quick(args, onProgress) {
        if (!DATA) throw new Error('Data not loaded yet');
        if (DATA.tiled) {
          const need = [args.fromKey, args.toKey].map((k) => DATA.tileOf.get(k));
          if (need.some((t) => t === undefined)) throw new Error('Unknown station');
          await root.TDData.ensureTiles(DATA, need, onProgress);
        }
        return root.TDOptimizer.bestSingleTrade(DATA, args.fromKey, args.toKey, args.credits, args.capacity, args.opts);
      },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createEngine };
  root.TDEngine = { createEngine };
})(typeof self !== 'undefined' ? self : this);

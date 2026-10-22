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
       * "Best within the limits" search. A single beam search is a heuristic: with more stations in
       * play it can prune a better route early, so a looser setting (e.g. 7-day data) could score LOWER
       * than a stricter one (3-day data). To rule that out we
       *   1. also search every stricter price-age window (they are subsets of the chosen one, so any
       *      route they find is valid) and pool the results, and
       *   2. keep re-running the main search with a wider beam until the time budget is used up or the
       *      answer stops improving.
       * The best distinct routes from all passes are returned.
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
        const budget = Math.max(500, opts.timeBudgetMs || 8000);
        const maxWidth = Math.max(2, opts.maxBeamWidth || 48);
        const base = Math.min(maxWidth, Math.max(2, opts.beamWidth || 6));
        const want = Math.max(1, opts.maxResults || 8);
        const pool = new Map();
        const addRoutes = (routes) => {
          for (const r of routes) {
            const sig = r.hops.map((h) => h.to.key).join('>');
            const have = pool.get(sig);
            if (!have || r.totalProfit > have.totalProfit) pool.set(sig, r);
          }
        };
        const bestOf = () => { let m = 0; for (const r of pool.values()) if (r.totalProfit > m) m = r.totalProfit; return m; };
        const say = (extra) => { if (onProgress) onProgress(Object.assign({ phase: 'search', elapsed: Date.now() - t1 }, extra)); };
        let passes = 0;

        // 1) stricter price-age windows (all subsets of the chosen window)
        if (DATA.hasAges) {
          const chosen = opts.maxAgeHours || 0;
          for (const hrs of AGE_TIERS) {
            if (chosen !== 0 && hrs >= chosen) break;
            if (Date.now() - t1 > budget * 0.4) break;
            passes++;
            say({ pass: passes, width: base, note: 'prices ≤ ' + hrs + 'h' });
            const r = root.TDOptimizer.findRoutes(DATA, Object.assign({}, opts, { maxAgeHours: hrs, beamWidth: base, branch: Math.max(12, base * 2), maxResults: want }));
            addRoutes(r.routes);
          }
        }

        // 2) the requested window with a progressively wider beam
        let width = base, first = null, noGain = 0, lastWidth = base;
        for (;;) {
          const ts = Date.now();
          const before = bestOf();
          passes++;
          say({ pass: passes, width });
          const r = root.TDOptimizer.findRoutes(DATA, Object.assign({}, opts, { beamWidth: width, branch: Math.max(12, width * 2), maxResults: want }));
          if (!first) first = r;
          addRoutes(r.routes);
          lastWidth = width;
          noGain = bestOf() > before ? 0 : noGain + 1;
          const took = Date.now() - ts;
          const next = width * 2;
          if (next > maxWidth) break;
          if (noGain >= 2) break;
          if (Date.now() - t1 + took * 2.4 > budget) break;
          width = next;
        }

        let routes = Array.from(pool.values()).sort((a, b) => b.totalProfit - a.totalProfit || a.totalDist - b.totalDist).slice(0, want);
        if (opts.minRouteProfit > 0) routes = routes.filter((r) => r.totalProfit >= opts.minRouteProfit);
        return {
          routes,
          warnings: first.warnings,
          stats: first.stats,
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

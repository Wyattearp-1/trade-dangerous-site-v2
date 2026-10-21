/**
 * Engine: owns the loaded dataset and exposes load / run / quick.
 * Used by worker.js (normal path) and by app.js directly if Web Workers are unavailable.
 *
 * With a tiled (v3) dataset only the station index is loaded up front; run() / quick() download the
 * map tiles a search can reach (cached afterwards) before searching.
 */
(function (root) {
  'use strict';

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
        const res = root.TDOptimizer.findRoutes(DATA, opts);
        if (opts.minRouteProfit > 0) res.routes = res.routes.filter((r) => r.totalProfit >= opts.minRouteProfit);
        res.ms = Date.now() - t0;
        return res;
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

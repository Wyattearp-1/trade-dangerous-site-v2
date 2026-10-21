/**
 * Multi-hop trade route optimizer (TradeDangerous-style "run" search).
 *
 * Objective: MAXIMUM TOTAL CREDITS. Distance never influences ranking or pruning
 * (it is only a hard reach limit and is reported for information). Every
 * reachable destination is scored by the real cargo profit it would give, the
 * best ones are expanded, and a beam of the highest-earning partial routes is
 * carried into the next hop.
 *
 * Works on the normalised dataset produced by data.js (sparse typed-array markets).
 */
(function (root) {
  'use strict';

  const EPS = 1e-6;

  /** Non-standard market goods (salvage, etc.) - never planned into loads. */
  const SALVAGE_BLOCK = new Set([
    'ASSAULT PLANS', 'MILITARY PLANS', 'BLACK BOX', 'TRADE DATA', 'PROTOTYPE TECH',
    'RARE ARTWORK', 'ANCIENT ARTEFACT', 'AI RELICS', 'OCCUPIED ESCAPE POD',
    'DAMAGED ESCAPE POD', 'UNOCCUPIED ESCAPE POD', 'WRECKAGE COMPONENTS',
    'PERSONAL EFFECTS', 'HOSTAGES', 'POLITICAL PRISONER', 'SAP 8 CORE CONTAINER',
  ]);
  function isBlockedCommodity(name) {
    const u = String(name || '').toUpperCase();
    if (SALVAGE_BLOCK.has(u)) return true;
    return u.includes('THARGOID') || u.includes('GUARDIAN ') || u.includes('ESCAPE POD');
  }

  function dist3(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function upperList(list) {
    return (list || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  }

  /** Filter stations by the player's constraints and build a spatial grid. */
  function prepStations(data, opts) {
    const avoidSystems = new Set(upperList(opts.avoidSystems));
    const avoidStations = new Set(upperList(opts.avoidStations));
    const avoidCommodities = new Set(upperList(opts.avoidCommodities));
    const startKeyU = String(opts.startKey || '').toUpperCase();
    const maxAgeSec = data.hasAges && opts.maxAgeHours > 0 ? opts.maxAgeHours * 3600 : 0;
    const nowSec = Date.now() / 1000;
    const req = opts.requirePad || 'any';

    const blocked = new Uint8Array(data.commodities.length);
    data.commodities.forEach((name, i) => {
      if (isBlockedCommodity(name) || avoidCommodities.has(name.toUpperCase())) blocked[i] = 1;
    });

    const center = opts._center || null;   // route start; nothing farther than _reach can be visited
    const reach = opts._reach > 0 ? opts._reach + 1e-6 : 0;
    const stations = [];
    for (const key of Object.keys(data.stations)) {
      const st = data.stations[key];
      const isStart = key.toUpperCase() === startKeyU;
      if (!isStart) {
        if (center && reach) {
          const sp = data.systems[st.system];
          if (!sp || dist3(sp, center) > reach) continue;
        }
        if (st.ids.length === 0) continue;
        if (avoidSystems.has(st.system.toUpperCase())) continue;
        if (avoidStations.size && (avoidStations.has(key.toUpperCase()) || avoidStations.has(st.name.toUpperCase()))) continue;
        if (opts.noPlanetary && st.planetary) continue;
        if (!opts.includeCarriers && st.carrier) continue;
        if (opts.maxStationLs > 0 && st.distLs > opts.maxStationLs) continue;
        if (req === 'L' && st.pad !== 'L') continue;
        if (req === 'M' && st.pad === 'S') continue;
        if (maxAgeSec && (!st.updated || nowSec - st.updated > maxAgeSec)) continue;
      }
      const sys = data.systems[st.system];
      if (!sys) continue;
      stations.push(Object.assign({ pos: sys }, st));
    }

    const cellSize = 10;
    const grid = new Map();
    const cellKey = (x, y, z) => Math.floor(x / cellSize) + ',' + Math.floor(y / cellSize) + ',' + Math.floor(z / cellSize);
    for (const st of stations) {
      const k = cellKey(st.pos.x, st.pos.y, st.pos.z);
      let b = grid.get(k);
      if (!b) grid.set(k, (b = []));
      b.push(st);
    }

    function neighboursWithin(pos, radius) {
      const out = [];
      const r = Math.ceil(radius / cellSize);
      const cx = Math.floor(pos.x / cellSize), cy = Math.floor(pos.y / cellSize), cz = Math.floor(pos.z / cellSize);
      for (let ix = -r; ix <= r; ix++) for (let iy = -r; iy <= r; iy++) for (let iz = -r; iz <= r; iz++) {
        const bucket = grid.get((cx + ix) + ',' + (cy + iy) + ',' + (cz + iz));
        if (!bucket) continue;
        for (const st of bucket) {
          const d = dist3(pos, st.pos);
          if (d <= radius + EPS) out.push({ station: st, dist: d });
        }
      }
      return out;
    }

    return { stations, neighboursWithin, blocked };
  }

  /* ---------------- cargo loading ---------------- */

  /** Greedy fill in the given order; also reports whether credits ever limited the load. */
  function fill(cands, credits, capacity) {
    let cap = capacity, cash = credits, total = 0, cashLimited = false;
    const picks = [];
    for (const c of cands) {
      if (cap <= 0) break;
      const afford = Math.floor(cash / c.buy);
      const want = Math.min(cap, c.cap);
      if (afford < want) cashLimited = true;
      const units = Math.min(want, afford);
      if (units <= 0) continue;
      picks.push({ c, units });
      total += units * c.unitProfit;
      cap -= units;
      cash -= units * c.buy;
    }
    return { picks, total, cashLimited, cost: credits - cash };
  }

  // Shadow prices of a credit (profit units per credit) used to re-rank goods when cash is tight.
  const LAMBDAS = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8];

  /**
   * Best single-hop cargo load from origin to dest.
   * Cargo space AND credits are both limited. Ranking by margin alone is optimal only when
   * credits never bind, so when they do we also try cost-adjusted orderings
   * (margin - lambda*price, and return-on-credit) and keep the most profitable load.
   */
  function bestLoad(origin, dest, credits, capacity, blocked, minProfit) {
    const oi = origin.ids, di = dest.ids;
    const minP = minProfit > 0 ? minProfit : 1;
    const cands = [];
    let i = 0, j = 0;
    while (i < oi.length && j < di.length) {
      const a = oi[i], b = di[j];
      if (a < b) i++;
      else if (a > b) j++;
      else {
        if (!blocked[a]) {
          const bp = origin.buy[i], sp = dest.sell[j];
          if (bp > 0 && sp > 0) {
            const unitProfit = sp - bp;
            if (unitProfit >= minP) {
              cands.push({
                id: a, buy: bp, sell: sp, unitProfit,
                supply: origin.supply[i], demand: dest.demand[j],
                cap: Math.min(origin.supply[i], dest.demand[j]),
              });
            }
          }
        }
        i++; j++;
      }
    }
    if (!cands.length) return { picks: [], total: 0, cost: 0 };

    cands.sort((x, y) => y.unitProfit - x.unitProfit);
    let best = fill(cands, credits, capacity);
    if (best.cashLimited && cands.length > 1) {
      const tryOrder = (cmp) => {
        const r = fill(cands.slice().sort(cmp), credits, capacity);
        if (r.total > best.total) best = r;
      };
      tryOrder((x, y) => y.unitProfit / y.buy - x.unitProfit / x.buy);
      for (const l of LAMBDAS) tryOrder((x, y) => (y.unitProfit - l * y.buy) - (x.unitProfit - l * x.buy));
    }
    return { picks: best.picks, total: best.total, cost: best.cost };
  }

  function describeLoad(picks, commodities) {
    return picks.map(({ c, units }) => ({
      commodity: commodities[c.id], units, buy: c.buy, sell: c.sell,
      profit: units * c.unitProfit, supply: c.supply, demand: c.demand,
    }));
  }

  function slim(s) {
    return { key: s.key, name: s.name, system: s.system, pad: s.pad, distLs: s.distLs, planetary: s.planetary, carrier: s.carrier, updated: s.updated };
  }

  /* ---------------- route search ---------------- */

  /**
   * opts: startKey, credits, insurance, capacity, lyPer, jumpsPer, hops, noRevisit, loop,
   *       towardSystem, avoidSystems/avoidStations/avoidCommodities, minProfitPerUnit,
   *       beamWidth, branch, maxResults, noPlanetary, includeCarriers, maxAgeHours,
   *       requirePad ('any'|'M'|'L'), maxStationLs
   * returns { routes, warnings, stats }
   */
  function findRoutes(data, opts) {
    const warnings = [];
    const startStored = data.stations[opts.startKey];
    if (!startStored) throw new Error('Unknown starting station (not in market data): ' + opts.startKey);

    const lyPerEarly = Math.max(1, opts.lyPer || 20);
    const reach = lyPerEarly * (opts.jumpsPer === 0 ? 0 : (opts.jumpsPer || 2)) * Math.max(1, Math.floor(opts.hops || 2));
    const centerPos = data.systems[startStored.system];
    const { stations, neighboursWithin, blocked } = prepStations(data, Object.assign({}, opts, { _center: centerPos, _reach: reach }));
    const byKey = new Map(stations.map((s) => [s.key, s]));
    const start = byKey.get(opts.startKey);
    if (!start) throw new Error('Starting station has no known system coordinates: ' + opts.startKey);

    const lyPer = Math.max(1, opts.lyPer || 20);
    const hopRadius = Math.max(0, lyPer * (opts.jumpsPer === 0 ? 0 : (opts.jumpsPer || 2)));
    const capacity = Math.max(1, Math.floor(opts.capacity || 1));
    const hops = Math.max(1, Math.floor(opts.hops || 2));
    const beamWidth = Math.max(1, opts.beamWidth || 6);
    const branch = Math.max(1, opts.branch || 12);
    const maxResults = Math.max(1, opts.maxResults || 8);
    const insurance = opts.insurance || 0;

    if (insurance >= opts.credits) warnings.push('Insurance reserve is at least your credits, so nothing can be spent on cargo.');
    if (opts.maxAgeHours > 0 && !data.hasAges) warnings.push('This dataset has no price timestamps, so the data-age filter was ignored.');

    let towardPos = null;
    if (opts.towardSystem) {
      towardPos = data.systems[String(opts.towardSystem).trim().toUpperCase()] || null;
      if (!towardPos) warnings.push('"' + opts.towardSystem + '" is not in this dataset (it only covers systems with recently updated markets), so "head toward" was ignored.');
      else if (opts.loop) { warnings.push('"Head toward" is ignored when looping back to the start.'); towardPos = null; }
    }

    const neighbourCache = new Map();
    function neighboursOf(st) {
      let n = neighbourCache.get(st.key);
      if (!n) {
        n = neighboursWithin(st.pos, hopRadius).filter((x) => x.station.key !== st.key);
        neighbourCache.set(st.key, n);
      }
      return n;
    }

    let beam = [{
      path: [{ station: start, picks: null, profit: 0, jumpDist: 0 }],
      credits: opts.credits, visited: new Set([start.key]), totalProfit: 0, totalDist: 0,
    }];

    for (let hop = 0; hop < hops; hop++) {
      const isLastHop = hop === hops - 1;
      const nextBeam = [];

      for (const partial of beam) {
        const here = partial.path[partial.path.length - 1].station;
        const spendable = Math.max(0, partial.credits - insurance);
        const cands = [];

        if (isLastHop && opts.loop) {
          if (here.key === start.key) { nextBeam.push(partial); continue; }
          const d = dist3(here.pos, start.pos);
          if (d > hopRadius + EPS) continue;
          // The return leg is mandatory; an empty run home is acceptable if nothing profitable exists.
          const r = bestLoad(here, start, spendable, capacity, blocked, opts.minProfitPerUnit);
          cands.push({ dest: start, dist: d, picks: r.picks, profit: r.total });
        } else {
          const remainingAfter = hops - 1 - hop;
          const hereToTarget = towardPos ? dist3(here.pos, towardPos) : 0;
          for (const { station: dest, dist } of neighboursOf(here)) {
            if (opts.noRevisit && partial.visited.has(dest.key)) continue;
            if (opts.loop && dist3(dest.pos, start.pos) > hopRadius * remainingAfter + EPS) continue;
            if (towardPos) {
              const dt = dist3(dest.pos, towardPos);
              if (!(dt < hereToTarget - 0.01 || dt <= lyPer)) continue;
            }
            const r = bestLoad(here, dest, spendable, capacity, blocked, opts.minProfitPerUnit);
            if (r.total <= 0) continue;
            cands.push({ dest, dist, picks: r.picks, profit: r.total });
          }
          // Rank purely by credits earned on this leg.
          cands.sort((a, b) => b.profit - a.profit || a.dist - b.dist);
          cands.length = Math.min(cands.length, branch);
        }

        for (const c of cands) {
          const visited = new Set(partial.visited);
          visited.add(c.dest.key);
          nextBeam.push({
            path: partial.path.concat([{ station: c.dest, picks: c.picks, profit: c.profit, jumpDist: c.dist }]),
            credits: partial.credits + c.profit,
            visited,
            totalProfit: partial.totalProfit + c.profit,
            totalDist: partial.totalDist + c.dist,
          });
        }
      }

      if (nextBeam.length === 0) break; // dead end everywhere: keep the last beam
      // Highest total credits first. Distance only breaks exact ties.
      nextBeam.sort((a, b) => b.totalProfit - a.totalProfit || a.totalDist - b.totalDist);
      const keep = isLastHop ? Math.max(beamWidth, maxResults) : beamWidth;
      const perEnd = new Map();
      const picked = [];
      for (const r of nextBeam) {
        const endKey = r.path[r.path.length - 1].station.key;
        const n = perEnd.get(endKey) || 0;
        if (n >= 2) continue; // keep the beam diverse
        perEnd.set(endKey, n + 1);
        picked.push(r);
        if (picked.length >= keep) break;
      }
      beam = picked;
    }

    const routes = beam
      .filter((r) => r.path.length > 1)
      .sort((a, b) => b.totalProfit - a.totalProfit || a.totalDist - b.totalDist)
      .slice(0, maxResults)
      .map((r) => ({
        totalProfit: r.totalProfit,
        endCredits: r.credits,
        totalDist: r.totalDist,
        hops: r.path.slice(1).map((leg, i) => ({
          from: slim(r.path[i].station),
          to: slim(leg.station),
          distLy: leg.jumpDist,
          jumps: leg.jumpDist > 0 ? Math.ceil(leg.jumpDist / lyPer - EPS) : 0,
          load: describeLoad(leg.picks, data.commodities),
          profit: leg.profit,
        })),
      }));

    if (!routes.length) {
      warnings.push(stations.length + ' stations passed your filters, but none offered a profitable trade within reach.');
    }
    return { routes, warnings, stats: { stationsConsidered: stations.length } };
  }

  /** Single best A -> B load (quick-trade tab). Also checks the reverse direction. */
  function bestSingleTrade(data, fromKey, toKey, credits, capacity, opts) {
    opts = opts || {};
    const from = data.stations[fromKey], to = data.stations[toKey];
    if (!from || !to) throw new Error('Unknown station');
    const avoid = new Set(upperList(opts.avoidCommodities));
    const blocked = new Uint8Array(data.commodities.length);
    data.commodities.forEach((n, i) => { if (isBlockedCommodity(n) || avoid.has(n.toUpperCase())) blocked[i] = 1; });
    const fwd = bestLoad(from, to, credits, capacity, blocked, opts.minProfitPerUnit);
    const result = { load: describeLoad(fwd.picks, data.commodities), totalProfit: fwd.total, cost: fwd.cost };
    if (!result.load.length) {
      const rev = bestLoad(to, from, credits, capacity, blocked, opts.minProfitPerUnit);
      if (rev.total > 0) result.reverseProfit = rev.total;
    }
    return result;
  }

  function reachRadius(opts) {
    const ly = Math.max(1, opts.lyPer || 20);
    return ly * (opts.jumpsPer === 0 ? 0 : (opts.jumpsPer || 2)) * Math.max(1, Math.floor(opts.hops || 2));
  }

  const api = { reachRadius, findRoutes, bestSingleTrade, bestLoad, dist3, isBlockedCommodity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TDOptimizer = api;
})(typeof self !== 'undefined' ? self : this);

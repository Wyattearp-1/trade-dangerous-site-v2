/**
 * TradeDangerous-style multi-hop route optimizer.
 *
 * This is a from-scratch re-implementation of the *approach* TD's "run"
 * command takes (not a line-for-line port of the Python): at every hop it
 * looks at every reachable station, works out the single best cargo load
 * for that hop (a small knapsack over the commodities that station buys
 * and the next one sells), and then keeps a beam of the best partial
 * routes going into the next hop. That's what lets it reason about a
 * whole run rather than just the single best trade.
 *
 * Expects the compact dataset shape produced by scripts/build_data.py:
 *
 * {
 *   generated_at: "2026-09-26T00:00:00Z",
 *   systems:  { "SOL": { x, y, z } , ... },
 *   stations: {
 *     "SOL/ABRAHAM LINCOLN": {
 *       system: "SOL", pad: "L", distLs: 490, planetary: false,
 *       market: { "GOLD": { buy: 9000, sell: 9200, supply: 1200, demand: 0 }, ... }
 *     }, ...
 *   }
 * }
 */

const EPS = 1e-6;

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Build a flat, indexable station list once per optimizer run. */
function prepStations(data, opts) {
  const avoidSystems = new Set((opts.avoidSystems || []).map(s => s.toUpperCase()));
  const avoidStations = new Set((opts.avoidStations || []).map(s => s.toUpperCase()));
  const avoidCommodities = new Set((opts.avoidCommodities || []).map(s => s.toUpperCase()));

  const stations = [];
  for (const [key, st] of Object.entries(data.stations)) {
    const sysName = st.system.toUpperCase();
    if (avoidSystems.has(sysName)) continue;
    if (avoidStations.has(key.toUpperCase())) continue;
    if (opts.maxPadSize === 'M' && st.pad === 'L') continue; // can't dock
    if (opts.noPlanetary && st.planetary) continue;
    const sys = data.systems[st.system];
    if (!sys) continue;
    stations.push({
      key,
      name: st.name || key.split('/').slice(1).join('/'),
      system: st.system,
      pos: sys,
      pad: st.pad,
      distLs: st.distLs || 0,
      market: st.market || {},
    });
  }

  // Precompute a simple spatial grid (10ly cells) for fast neighbour lookups.
  const cellSize = 10;
  const grid = new Map();
  const cellKey = (x, y, z) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
  for (const st of stations) {
    const k = cellKey(st.pos.x, st.pos.y, st.pos.z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(st);
  }

  function neighboursWithin(pos, radius) {
    const out = [];
    const cellRadius = Math.ceil(radius / cellSize);
    const cx = Math.floor(pos.x / cellSize), cy = Math.floor(pos.y / cellSize), cz = Math.floor(pos.z / cellSize);
    for (let ix = -cellRadius; ix <= cellRadius; ix++) {
      for (let iy = -cellRadius; iy <= cellRadius; iy++) {
        for (let iz = -cellRadius; iz <= cellRadius; iz++) {
          const bucket = grid.get(`${cx + ix},${cy + iy},${cz + iz}`);
          if (!bucket) continue;
          for (const st of bucket) {
            const d = dist3(pos, st.pos);
            if (d <= radius) out.push({ station: st, dist: d });
          }
        }
      }
    }
    return out;
  }

  return { stations, neighboursWithin, avoidCommodities };
}

/**
 * Best single-hop cargo load between two stations, given cash & capacity.
 * Simple greedy-by-margin knapsack: legal because units are homogeneous
 * (buying more of the same good has constant marginal profit until
 * supply/capacity/credits run out), so sorting by per-unit profit and
 * filling greedily is optimal for this sub-problem.
 */
function bestLoad(origin, dest, credits, capacity, avoidCommodities, minProfitPerUnit) {
  const candidates = [];
  for (const [commodity, o] of Object.entries(origin.market)) {
    if (avoidCommodities.has(commodity.toUpperCase())) continue;
    if (!o.buy || o.buy <= 0) continue; // not sold here
    const d = dest.market[commodity];
    if (!d || !d.sell || d.sell <= 0) continue; // not bought there
    const unitProfit = d.sell - o.buy;
    if (unitProfit < (minProfitPerUnit || 1)) continue;
    const supplyCap = o.supply && o.supply > 0 ? o.supply : Infinity;
    const demandCap = d.demand && d.demand > 0 ? d.demand : Infinity;
    candidates.push({ commodity, buy: o.buy, sell: d.sell, unitProfit, cap: Math.min(supplyCap, demandCap) });
  }
  candidates.sort((a, b) => b.unitProfit - a.unitProfit);

  let remainingCap = capacity;
  let remainingCash = credits;
  let totalProfit = 0;
  const load = [];
  for (const c of candidates) {
    if (remainingCap <= 0 || remainingCash <= 0) break;
    const affordable = Math.floor(remainingCash / c.buy);
    const units = Math.max(0, Math.min(remainingCap, affordable, c.cap));
    if (units <= 0) continue;
    load.push({ commodity: c.commodity, units, buy: c.buy, sell: c.sell, profit: units * c.unitProfit });
    totalProfit += units * c.unitProfit;
    remainingCap -= units;
    remainingCash -= units * c.buy;
  }
  return { load, totalProfit, cost: credits - remainingCash };
}

/**
 * Run the multi-hop search.
 *
 * opts:
 *   startKey          station key to start from (required)
 *   credits           starting cash
 *   insurance         credits to keep in reserve, never spent
 *   capacity          cargo capacity in units
 *   lyPer             ship's max jump range (ly)
 *   jumpsPer          max system jumps allowed per hop (hop radius = lyPer*jumpsPer)
 *   hops              number of trade hops to plan
 *   noRevisit         don't land at the same station twice
 *   loop              try to end back at the start station
 *   towardSystem      optional system name to bias the route toward
 *   avoidSystems / avoidStations / avoidCommodities   arrays of names
 *   minProfitPerUnit  ignore trades worth less than this per unit
 *   distancePenalty   0..1, how much to penalise hops that are far away
 *   beamWidth         how many partial routes to keep between hops (perf/quality trade-off)
 *   candidatesPerHop  how many destination stations to evaluate per hop
 */
function findRoutes(data, opts) {
  const { stations, neighboursWithin, avoidCommodities } = prepStations(data, opts);
  const byKey = new Map(stations.map(s => [s.key, s]));
  const start = byKey.get(opts.startKey);
  if (!start) throw new Error('Unknown starting station: ' + opts.startKey);

  const hopRadius = Math.max(1, (opts.lyPer || 20) * (opts.jumpsPer || 2));
  const capacity = opts.capacity || 1;
  const hops = Math.max(1, opts.hops || 2);
  const beamWidth = opts.beamWidth || 6;
  const candidatesPerHop = opts.candidatesPerHop || 25;
  const towardPos = opts.towardSystem && data.systems[opts.towardSystem.toUpperCase()];

  let beam = [{
    path: [{ station: start, load: null, profit: 0, jumpDist: 0 }],
    credits: opts.credits,
    visited: new Set([start.key]),
    totalProfit: 0,
  }];

  for (let hop = 0; hop < hops; hop++) {
    const isLastHop = hop === hops - 1;
    const nextBeam = [];

    for (const partial of beam) {
      const here = partial.path[partial.path.length - 1].station;
      const spendable = Math.max(0, partial.credits - (opts.insurance || 0));

      let nearby = neighboursWithin(here.pos, hopRadius)
        .filter(n => n.station.key !== here.key)
        .filter(n => !opts.noRevisit || !partial.visited.has(n.station.key));

      // If this is the final hop and looping is requested, force-consider
      // the start station even if it'd otherwise be filtered by noRevisit.
      if (isLastHop && opts.loop && here.key !== start.key) {
        const d = dist3(here.pos, start.pos);
        if (d <= hopRadius) nearby.push({ station: start, dist: d });
      }

      // Rank neighbours cheaply before doing the (more expensive) load calc.
      nearby.sort((a, b) => {
        let sa = 0, sb = 0;
        if (towardPos) { sa -= dist3(a.station.pos, towardPos); sb -= dist3(b.station.pos, towardPos); }
        sa -= a.dist * (opts.distancePenalty || 0.05);
        sb -= b.dist * (opts.distancePenalty || 0.05);
        return sb - sa;
      });
      nearby = nearby.slice(0, candidatesPerHop);

      for (const { station: dest, dist } of nearby) {
        const { load, totalProfit } = bestLoad(
          here, dest, spendable, capacity, avoidCommodities, opts.minProfitPerUnit
        );
        if (totalProfit <= 0 || load.length === 0) continue;

        const distPenalty = dist * (opts.distancePenalty || 0.05) * 10;
        const score = partial.totalProfit + totalProfit - distPenalty;

        const visited = new Set(partial.visited);
        visited.add(dest.key);

        nextBeam.push({
          path: [...partial.path, { station: dest, load, profit: totalProfit, jumpDist: dist }],
          credits: partial.credits + totalProfit,
          visited,
          totalProfit: partial.totalProfit + totalProfit,
          score,
        });
      }
    }

    if (nextBeam.length === 0) break; // dead end everywhere; return what we have
    nextBeam.sort((a, b) => b.score - a.score);
    beam = nextBeam.slice(0, beamWidth);
  }

  beam.sort((a, b) => b.totalProfit - a.totalProfit);
  return beam.slice(0, 5).map(r => ({
    totalProfit: r.totalProfit,
    endCredits: r.credits,
    hops: r.path.slice(1).map((leg, i) => ({
      from: r.path[i].station,
      to: leg.station,
      distLy: leg.jumpDist,
      load: leg.load,
      profit: leg.profit,
    })),
  }));
}

/** Single best A -> B trade (used for the simple "quick trade" mode). */
function bestSingleTrade(data, fromKey, toKey, credits, capacity, opts = {}) {
  const from = data.stations[fromKey];
  const to = data.stations[toKey];
  if (!from || !to) throw new Error('Unknown station');
  const avoid = new Set((opts.avoidCommodities || []).map(s => s.toUpperCase()));
  return bestLoad(from, to, credits, capacity, avoid, opts.minProfitPerUnit);
}

if (typeof module !== 'undefined') {
  module.exports = { findRoutes, bestSingleTrade, dist3 };
}

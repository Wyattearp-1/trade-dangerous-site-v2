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
  const CAND_KEEP = 300;        // destinations remembered per (station, budget) in the per-run cache
  const CAND_CACHE_MAX = 1500;  // cached station lists per price window (bounds memory)

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

    const bySystem = new Map();
    for (const st of stations) {
      let list = bySystem.get(st.system);
      if (!list) bySystem.set(st.system, (list = []));
      list.push(st);
    }

    return { stations, neighboursWithin, blocked, bySystem };
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
    if (!cands.length) return { picks: [], total: 0, cost: 0, free: true };

    cands.sort((x, y) => y.unitProfit - x.unitProfit);
    let best = fill(cands, credits, capacity);
    const free = !best.cashLimited; // credits never bound: any larger budget gives the identical load
    if (best.cashLimited && cands.length > 1) {
      const tryOrder = (cmp) => {
        const r = fill(cands.slice().sort(cmp), credits, capacity);
        if (r.total > best.total) best = r;
      };
      tryOrder((x, y) => y.unitProfit / y.buy - x.unitProfit / x.buy);
      for (const l of LAMBDAS) tryOrder((x, y) => (y.unitProfit - l * y.buy) - (x.unitProfit - l * x.buy));
    }
    return { picks: best.picks, total: best.total, cost: best.cost, free };
  }


  /* Allocation-free fast path. Scratch arrays are reused across calls (single-threaded). */
  const SCRATCH = 1024;
  const S_BUY = new Int32Array(SCRATCH), S_PROF = new Int32Array(SCRATCH), S_CAP = new Int32Array(SCRATCH), S_IDX = new Int32Array(SCRATCH);
  let qCost = 0;

  /**
   * Profit of the best load origin -> dest, without building any objects.
   * Returns -1 when credits are tight enough that the cost-adjusted orderings in bestLoad() are needed
   * (the caller then falls back to it); otherwise the margin-ordered fill is already optimal.
   */
  function quickLoad(origin, dest, credits, capacity, blocked, minProfit) {
    const oi = origin.ids, di = dest.ids;
    const minP = minProfit > 0 ? minProfit : 1;
    let n = 0, i = 0, j = 0;
    while (i < oi.length && j < di.length) {
      const a = oi[i], b = di[j];
      if (a < b) i++;
      else if (a > b) j++;
      else {
        if (!blocked[a]) {
          const bp = origin.buy[i], sp = dest.sell[j];
          if (bp > 0 && sp > 0 && sp - bp >= minP) {
            if (n >= SCRATCH) return -1;
            S_BUY[n] = bp; S_PROF[n] = sp - bp;
            const sup = origin.supply[i], dem = dest.demand[j];
            S_CAP[n] = sup < dem ? sup : dem;
            n++;
          }
        }
        i++; j++;
      }
    }
    qCost = 0;
    if (n === 0) return 0;
    // insertion sort of indices by margin, best first (n is small)
    for (let k = 0; k < n; k++) {
      let m = k;
      const pk = S_PROF[k];
      while (m > 0 && S_PROF[S_IDX[m - 1]] < pk) { S_IDX[m] = S_IDX[m - 1]; m--; }
      S_IDX[m] = k;
    }
    let cap = capacity, cash = credits, total = 0;
    for (let k = 0; k < n && cap > 0; k++) {
      const x = S_IDX[k];
      const afford = Math.floor(cash / S_BUY[x]);
      const want = cap < S_CAP[x] ? cap : S_CAP[x];
      if (afford < want) return -1; // credits bind -> use the full algorithm
      if (want <= 0) continue;
      total += want * S_PROF[x];
      cap -= want;
      cash -= want * S_BUY[x];
      qCost += want * S_BUY[x];
    }
    return total;
  }

  /* ------------------------------------------------------------------------------------------
   * Market price impact.
   * Elite does not publish its pricing formula, so this is an ESTIMATE: buying raises the unit price
   * linearly with the share of the station's stock you take, and selling lowers it linearly with the
   * share of its demand you fill. With strength k the average price over x units is
   *   buy  = p * (1 + k * x / (2 * stock))        sell = s * (1 - k * x / (2 * demand))
   * (k = 0 reproduces the plain "listed price" model.) Cargo is allocated in ~24 chunks, always to
   * the commodity with the best marginal margin at that moment.
   * ---------------------------------------------------------------------------------------- */
  const IM_MAX = 512;
  const A_ID = new Int32Array(IM_MAX);
  const A_P = new Float64Array(IM_MAX), A_S = new Float64Array(IM_MAX), A_SUP = new Float64Array(IM_MAX);
  const A_DEM = new Float64Array(IM_MAX), A_CAP = new Float64Array(IM_MAX), A_X = new Float64Array(IM_MAX);
  let iCost = 0, iFree = true;

  function impactRun(n, capacity, credits, k, u, mode) {
    for (let i = 0; i < n; i++) A_X[i] = 0;
    let cap = capacity, cash = credits, limited = false;
    while (cap > 0) {
      let best = -1, bestScore = 0, bestUnits = 0, bestAvgBuy = 0;
      for (let i = 0; i < n; i++) {
        const room = A_CAP[i] - A_X[i];
        if (room <= 0) continue;
        let units = u < cap ? u : cap;
        if (units > room) units = room;
        let mid = A_X[i] + units / 2;
        let avgBuy = A_P[i] * (1 + k * mid / A_SUP[i]);
        const margin0 = A_S[i] * (1 - k * mid / A_DEM[i]) - avgBuy;
        if (margin0 <= 0) continue;
        if (units * avgBuy > cash) {
          limited = true;
          units = Math.floor(cash / avgBuy);
          if (units <= 0) continue;
          mid = A_X[i] + units / 2;
          avgBuy = A_P[i] * (1 + k * mid / A_SUP[i]);
        }
        const score = mode === 0 ? margin0 : margin0 / avgBuy;
        if (score > bestScore) { best = i; bestScore = score; bestUnits = units; bestAvgBuy = avgBuy; }
      }
      if (best < 0) break;
      A_X[best] += bestUnits;
      cap -= bestUnits;
      cash -= bestUnits * bestAvgBuy;
    }
    return limited;
  }

  /**
   * Best load origin -> dest under price impact k. Returns the profit (a number) and sets iCost / iFree,
   * or, with wantPicks, { total, cost, free, picks }.
   */
  function impactLoad(origin, dest, credits, capacity, blocked, minProfit, k, wantPicks) {
    const oi = origin.ids, di = dest.ids;
    const minP = minProfit > 0 ? minProfit : 1;
    let n = 0, i = 0, j = 0;
    while (i < oi.length && j < di.length) {
      const a = oi[i], b = di[j];
      if (a < b) i++;
      else if (a > b) j++;
      else {
        if (!blocked[a]) {
          const bp = origin.buy[i], sp = dest.sell[j];
          if (bp > 0 && sp > 0 && sp - bp >= minP && n < IM_MAX) {
            const sup = origin.supply[i], dem = dest.demand[j];
            A_ID[n] = a; A_P[n] = bp; A_S[n] = sp; A_SUP[n] = sup; A_DEM[n] = dem;
            A_CAP[n] = sup < dem ? sup : dem;
            n++;
          }
        }
        i++; j++;
      }
    }
    if (n === 0) {
      iCost = 0; iFree = true;
      return wantPicks ? { total: 0, cost: 0, free: true, picks: [] } : 0;
    }
    const u = Math.max(1, Math.ceil(capacity / 24));
    const totals = (() => {
      let total = 0, cost = 0;
      for (let q = 0; q < n; q++) {
        const x = A_X[q];
        if (x <= 0) continue;
        const ab = A_P[q] * (1 + k * x / (2 * A_SUP[q]));
        const as = A_S[q] * (1 - k * x / (2 * A_DEM[q]));
        total += x * (as - ab); cost += x * ab;
      }
      return { total, cost };
    });
    let limited = impactRun(n, capacity, credits, k, u, 0);
    let t = totals();
    let bestTotal = t.total, bestCost = t.cost, bestMode = 0, lastMode = 0;
    iFree = !limited;
    if (limited) {
      impactRun(n, capacity, credits, k, u, 1);
      lastMode = 1;
      const t1 = totals();
      if (t1.total > bestTotal) { bestTotal = t1.total; bestCost = t1.cost; bestMode = 1; }
    }
    iCost = bestCost;
    const total = Math.round(bestTotal);
    if (!wantPicks) return total;
    if (lastMode !== bestMode) impactRun(n, capacity, credits, k, u, bestMode);
    const picks = [];
    for (let q = 0; q < n; q++) {
      const x = A_X[q];
      if (x <= 0) continue;
      const ab = A_P[q] * (1 + k * x / (2 * A_SUP[q]));
      const as = A_S[q] * (1 - k * x / (2 * A_DEM[q]));
      picks.push({ id: A_ID[q], units: x, buy: A_P[q], sell: A_S[q], buyAvg: ab, sellAvg: as, profit: Math.round(x * (as - ab)), supply: A_SUP[q], demand: A_DEM[q], at: 0 });
    }
    return { total, cost: bestCost, free: iFree, picks };
  }

  /**
   * Best load that is split between TWO selling stops B and C (one hold, two destinations).
   * A commodity can be sold at either; its stock is shared. Returns { total, cost, picks } where each
   * pick has st = 0 (sold at B) or 1 (sold at C).
   */
  function splitLoad(origin, B, C, credits, capacity, blocked, minProfit, k) {
    const minP = minProfit > 0 ? minProfit : 1;
    const bIdx = new Map(), cIdx = new Map();
    for (let q = 0; q < B.ids.length; q++) bIdx.set(B.ids[q], q);
    for (let q = 0; q < C.ids.length; q++) cIdx.set(C.ids[q], q);
    const comms = [], lots = [];
    for (let q = 0; q < origin.ids.length; q++) {
      const id = origin.ids[q], bp = origin.buy[q];
      if (blocked[id] || bp <= 0) continue;
      const sup = origin.supply[q];
      const ci = comms.length;
      let any = false;
      for (let st = 0; st < 2; st++) {
        const D = st ? C : B, jj = (st ? cIdx : bIdx).get(id);
        if (jj === undefined) continue;
        const sp = D.sell[jj];
        if (sp <= 0 || sp - bp < minP) continue;
        const dem = D.demand[jj];
        lots.push({ ci, st, sp, dem, cap: Math.min(sup, dem) });
        any = true;
      }
      if (any) comms.push({ id, bp, sup });
    }
    if (!lots.length) return { total: 0, cost: 0, picks: [] };
    const u = Math.max(1, Math.ceil(capacity / 24));

    function run(mode) {
      const x = new Float64Array(lots.length), bought = new Float64Array(comms.length);
      let cap = capacity, cash = credits, limited = false;
      while (cap > 0) {
        let best = -1, bestScore = 0, bestUnits = 0, bestAvgBuy = 0;
        for (let li = 0; li < lots.length; li++) {
          const L = lots[li], cm = comms[L.ci];
          const room = Math.min(L.cap - x[li], cm.sup - bought[L.ci]);
          if (room <= 0) continue;
          let units = Math.min(u, cap, room);
          let avgBuy = cm.bp * (1 + k * (bought[L.ci] + units / 2) / cm.sup);
          const margin0 = L.sp * (1 - k * (x[li] + units / 2) / L.dem) - avgBuy;
          if (margin0 <= 0) continue;
          if (units * avgBuy > cash) {
            limited = true;
            units = Math.floor(cash / avgBuy);
            if (units <= 0) continue;
            avgBuy = cm.bp * (1 + k * (bought[L.ci] + units / 2) / cm.sup);
          }
          const score = mode === 0 ? margin0 : margin0 / avgBuy;
          if (score > bestScore) { best = li; bestScore = score; bestUnits = units; bestAvgBuy = avgBuy; }
        }
        if (best < 0) break;
        x[best] += bestUnits; bought[lots[best].ci] += bestUnits;
        cap -= bestUnits; cash -= bestUnits * bestAvgBuy;
      }
      let total = 0, cost = 0;
      for (let li = 0; li < lots.length; li++) {
        if (x[li] <= 0) continue;
        const L = lots[li], cm = comms[L.ci];
        const ab = cm.bp * (1 + k * bought[L.ci] / (2 * cm.sup));
        const as = L.sp * (1 - k * x[li] / (2 * L.dem));
        total += x[li] * (as - ab);
      }
      for (let ci = 0; ci < comms.length; ci++) cost += bought[ci] * comms[ci].bp * (1 + k * bought[ci] / (2 * comms[ci].sup));
      return { total, cost, x, bought, limited };
    }
    let best = run(0);
    if (best.limited) { const r1 = run(1); if (r1.total > best.total) best = r1; }
    const picks = [];
    for (let li = 0; li < lots.length; li++) {
      const x = best.x[li];
      if (x <= 0) continue;
      const L = lots[li], cm = comms[L.ci];
      const ab = cm.bp * (1 + k * best.bought[L.ci] / (2 * cm.sup));
      const as = L.sp * (1 - k * x / (2 * L.dem));
      picks.push({ id: cm.id, units: x, st: L.st, buy: cm.bp, sell: L.sp, buyAvg: ab, sellAvg: as, profit: Math.round(x * (as - ab)), supply: cm.sup, demand: L.dem });
    }
    return { total: Math.round(best.total), cost: best.cost, picks };
  }

  /** Turn picks (either bestLoad's {c, units} or the flat impact/split form) into output rows. */
  function describeLoad(picks, commodities, atOf) {
    return picks.map((p) => {
      if (p.c) {
        return { commodity: commodities[p.c.id], units: p.units, buy: p.c.buy, sell: p.c.sell, buyAvg: p.c.buy, sellAvg: p.c.sell,
          profit: p.units * p.c.unitProfit, supply: p.c.supply, demand: p.c.demand, at: 0 };
      }
      return { commodity: commodities[p.id], units: p.units, buy: p.buy, sell: p.sell, buyAvg: p.buyAvg, sellAvg: p.sellAvg,
        profit: p.profit, supply: p.supply, demand: p.demand, at: atOf ? atOf(p) : (p.at || 0) };
    });
  }

  function slim(s) {
    return { key: s.key, name: s.name, system: s.system, pad: s.pad, distLs: s.distLs, planetary: s.planetary, carrier: s.carrier, updated: s.updated, live: !!s.live };
  }

  /* ---------------- time model (estimates, all adjustable) ---------------- */

  /** Seconds to cross a system to a station `ls` light-seconds from the star (supercruise). */
  function scTime(ls) { return 25 + 1.25 * Math.sqrt(Math.max(0, ls || 0)); }

  /* ---------------- real jump paths ---------------- */

  function sysCell(p, cell) { return Math.floor(p.x / cell) + ',' + Math.floor(p.y / cell) + ',' + Math.floor(p.z / cell); }

  /** Grid of every known system near the route (not only ones with usable markets: any star is a waypoint). */
  function buildSysGrid(data, center, limit, cell) {
    const grid = new Map();
    for (const name of Object.keys(data.systems)) {
      const p = data.systems[name];
      if (center && dist3(p, center) > limit) continue;
      const k = sysCell(p, cell);
      let b = grid.get(k);
      if (!b) grid.set(k, (b = []));
      b.push({ name, x: p.x, y: p.y, z: p.z });
    }
    return { grid, cell };
  }

  /** Fewest-jumps tree from one system: Map(system -> { j: jumps, prev }) up to maxJumps, jumps <= range ly. */
  function bfsTree(sg, data, fromName, range, maxJumps) {
    const tree = new Map();
    tree.set(fromName, { j: 0, prev: null });
    if (maxJumps <= 0) return tree;
    const r2 = (range + EPS) * (range + EPS), cell = sg.cell;
    let frontier = [fromName];
    for (let depth = 1; depth <= maxJumps && frontier.length; depth++) {
      const next = [];
      for (const s of frontier) {
        const p = data.systems[s];
        const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const bucket = sg.grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
          if (!bucket) continue;
          for (const t of bucket) {
            if (tree.has(t.name)) continue;
            const ex = t.x - p.x, ey = t.y - p.y, ez = t.z - p.z;
            if (ex * ex + ey * ey + ez * ez <= r2) { tree.set(t.name, { j: depth, prev: s }); next.push(t.name); }
          }
        }
      }
      frontier = next;
    }
    return tree;
  }

  function pathFromTree(tree, toName) {
    const out = [];
    let cur = toName;
    while (cur) { out.push(cur); const n = tree.get(cur); cur = n ? n.prev : null; }
    return out.reverse();
  }

  /* ---------------- route search ---------------- */

  /**
   * opts: startKey, credits, insurance, capacity, lyPer, jumpsPer, hops, noRevisit, loop,
   *       towardSystem, avoidSystems/avoidStations/avoidCommodities, minProfitPerUnit,
   *       beamWidth, branch, maxResults, noPlanetary, includeCarriers, maxAgeHours,
   *       requirePad ('any'|'M'|'L'), maxStationLs,
   *       objective ('profit' | 'rate'), pathMode ('line' | 'graph'), impact (0..1), split (bool),
   *       secPerJump, secPerStop
   * returns { routes, warnings, stats }
   */
  function findRoutes(data, opts) {
    const warnings = [];
    const startStored = data.stations[opts.startKey];
    if (!startStored) throw new Error('Unknown starting station (not in market data): ' + opts.startKey);

    const lyPer = Math.max(1, opts.lyPer || 20);
    const jumpsPer = opts.jumpsPer === 0 ? 0 : Math.max(0, Math.floor(opts.jumpsPer || 2));
    const hopRadius = lyPer * jumpsPer;
    const capacity = Math.max(1, Math.floor(opts.capacity || 1));
    const hops = Math.max(1, Math.floor(opts.hops || 2));
    const beamWidth = Math.max(1, opts.beamWidth || 6);
    const branch = Math.max(1, opts.branch || 12);
    const maxResults = Math.max(1, opts.maxResults || 8);
    const insurance = opts.insurance || 0;
    const impact = Math.min(1, Math.max(0, opts.impact || 0));
    const objective = opts.objective === 'rate' ? 'rate' : 'profit';
    const graphMode = opts.pathMode === 'graph';
    const split = !!opts.split;
    const secJ = Number.isFinite(opts.secPerJump) ? Math.max(0, opts.secPerJump) : 50;
    const secStop = Number.isFinite(opts.secPerStop) ? Math.max(0, opts.secPerStop) : 150;
    const minP = opts.minProfitPerUnit;
    const reach = hopRadius * hops;
    const centerPos = data.systems[startStored.system];

    // Optional per-run context (opts._ctx): repeated passes reuse prepared station sets, neighbour lists,
    // jump trees and computed cargo loads instead of rebuilding them.
    const ctx = opts._ctx || null;
    const prepKey = 'age' + (opts.maxAgeHours || 0);
    let prep = ctx && ctx.preps.get(prepKey);
    if (!prep) {
      prep = prepStations(data, Object.assign({}, opts, { _center: centerPos, _reach: reach }));
      prep.byKey = new Map(prep.stations.map((s) => [s.key, s]));
      prep.neighbourCache = new Map();
      prep.candCache = new Map();
      if (ctx) ctx.preps.set(prepKey, prep);
    }
    const { stations, neighboursWithin, blocked, byKey, bySystem } = prep;
    const start = byKey.get(opts.startKey);
    if (!start) throw new Error('Starting station has no known system coordinates: ' + opts.startKey);

    if (insurance >= opts.credits) warnings.push('Insurance reserve is at least your credits, so nothing can be spent on cargo.');
    if (opts.maxAgeHours > 0 && !data.hasAges) warnings.push('This dataset has no price timestamps, so the data-age filter was ignored.');

    let towardPos = null;
    if (opts.towardSystem) {
      towardPos = data.systems[String(opts.towardSystem).trim().toUpperCase()] || null;
      if (!towardPos) warnings.push('"' + opts.towardSystem + '" is not in this dataset (it only covers systems with recently updated markets), so "head toward" was ignored.');
      else if (opts.loop) { warnings.push('"Head toward" is ignored when looping back to the start.'); towardPos = null; }
    }

    /* ----- jump graph ----- */
    let sysGrid = ctx ? ctx.sysGrid : null;
    const trees = ctx ? ctx.trees : new Map();
    function treeOf(sysName) {
      let t = trees.get(sysName);
      if (!t) {
        if (!sysGrid) { sysGrid = buildSysGrid(data, centerPos, reach + hopRadius + lyPer, lyPer); if (ctx) ctx.sysGrid = sysGrid; }
        t = bfsTree(sysGrid, data, sysName, lyPer, jumpsPer);
        if (trees.size >= 400) trees.clear();
        trees.set(sysName, t);
      }
      return t;
    }
    /** Jumps between two systems within the per-hop limit, or null if not reachable. */
    function jumpsBetween(a, b) {
      if (a === b) return 0;
      if (graphMode) { const n = treeOf(a).get(b); return n ? n.j : null; }
      const d = dist3(data.systems[a], data.systems[b]);
      return d <= hopRadius + EPS ? Math.ceil(d / lyPer - EPS) : null;
    }

    const neighbourCache = prep.neighbourCache;
    function neighboursOf(st) {
      let n = neighbourCache.get(st.key);
      if (!n) {
        n = [];
        if (graphMode) {
          for (const [sysName, info] of treeOf(st.system)) {
            const list = bySystem.get(sysName);
            if (!list) continue;
            for (const s of list) if (s.key !== st.key) n.push({ station: s, dist: dist3(st.pos, s.pos), jumps: info.j });
          }
        } else {
          for (const x of neighboursWithin(st.pos, hopRadius)) {
            if (x.station.key === st.key) continue;
            n.push({ station: x.station, dist: x.dist, jumps: x.dist > 0 ? Math.ceil(x.dist / lyPer - EPS) : 0 });
          }
        }
        neighbourCache.set(st.key, n);
      }
      return n;
    }

    /* ----- leg values (memoised across passes) ----- */
    function cached(memoMap, from, to, spendable, compute) {
      let row = null;
      if (ctx) {
        row = memoMap.get(from.key);
        if (!row) { row = new Map(); memoMap.set(from.key, row); }
        const hit = row.get(to.key);
        if (hit && (hit.free ? spendable >= hit.cost : spendable === hit.credits)) return hit;
      }
      const entry = compute(from, to, spendable);
      if (row) {
        row.set(to.key, entry);
        if (++ctx.memoSize > 400000) { ctx.memo.clear(); ctx.memoI.clear(); ctx.memoSize = 0; }
      }
      return entry;
    }
    const compute0 = (from, to, sp) => {
      const t = quickLoad(from, to, sp, capacity, blocked, minP);
      if (t >= 0) return { free: true, credits: sp, cost: qCost, total: t };
      const r = bestLoad(from, to, sp, capacity, blocked, minP);
      return { free: r.free, credits: sp, cost: r.cost, total: r.total };
    };
    const computeI = (from, to, sp) => {
      const t = impactLoad(from, to, sp, capacity, blocked, minP, impact, false);
      return { free: iFree, credits: sp, cost: iCost, total: t };
    };
    const ctxMemo = ctx ? ctx.memo : null, ctxMemoI = ctx ? ctx.memoI : null;
    const value0 = (from, to, sp) => cached(ctxMemo, from, to, sp, compute0);
    const valueI = (from, to, sp) => cached(ctxMemoI, from, to, sp, computeI);
    const loadFor = (from, to, sp) => (impact > 0 ? valueI(from, to, sp) : value0(from, to, sp));

    /** Cargo rows for a chosen single leg. */
    function picksFor(from, to, spendable) {
      if (impact > 0) return impactLoad(from, to, spendable, capacity, blocked, minP, impact, true).picks;
      return bestLoad(from, to, spendable, capacity, blocked, minP).picks;
    }

    const legSeconds = (jumps, destLs) => secStop + jumps * secJ + scTime(destLs);
    const legScore = (profit, time) => (objective === 'rate' ? profit / Math.max(time, 1) : profit);
    const partialScore = (p) => (objective === 'rate' ? p.totalProfit / Math.max(p.totalTime, 1) : p.totalProfit);

    /* ----- search ----- */
    let beam = [{
      path: [{ station: start, picks: null, profit: 0, jumpDist: 0 }],
      credits: opts.credits, visited: new Set([start.key]), totalProfit: 0, totalDist: 0, totalTime: 0,
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
          const j = jumpsBetween(here.system, start.system);
          if (j === null) continue;
          const d = dist3(here.pos, start.pos);
          // The return leg is mandatory; an empty run home is acceptable if nothing profitable exists.
          const r = loadFor(here, start, spendable);
          cands.push({ dest: start, dist: d, jumps: j, picks: null, profit: r.total, time: legSeconds(j, start.distLs) });
        } else {
          const remainingAfter = hops - 1 - hop;
          const visitedOk = (c) => !(opts.noRevisit && (partial.visited.has(c.dest.key) || (c.via && partial.visited.has(c.via.key))));

          /** Every profitable destination from `here`, best first (independent of the path taken, except visited). */
          const build = (keep) => {
            const hereToTarget = towardPos ? dist3(here.pos, towardPos) : 0;
            const base = [];
            for (const nb of neighboursOf(here)) {
              const dest = nb.station;
              if (opts.loop && dist3(dest.pos, start.pos) > hopRadius * remainingAfter + EPS) continue;
              if (towardPos) {
                const dt = dist3(dest.pos, towardPos);
                if (!(dt < hereToTarget - 0.01 || dt <= lyPer)) continue;
              }
              const r = value0(here, dest, spendable); // upper bound: price impact can only lower profit
              if (r.total <= 0) continue;
              base.push({ dest, dist: nb.dist, jumps: nb.jumps, ub: r.total, profit: r.total, time: legSeconds(nb.jumps, dest.distLs), picks: null });
            }
            const byScore = (a, b) => legScore(b.profit, b.time) - legScore(a.profit, a.time) || a.dist - b.dist;
            let out;
            if (impact > 0) {
              // Branch and bound: evaluate with impact in order of the no-impact upper bound and stop once
              // no remaining destination can beat the current top `keep`.
              base.sort((a, b) => legScore(b.ub, b.time) - legScore(a.ub, a.time) || a.dist - b.dist);
              out = [];
              const need = keep || Infinity;
              for (const c of base) {
                if (out.length >= need && legScore(c.ub, c.time) <= legScore(out[need - 1].profit, out[need - 1].time)) break;
                const r = valueI(here, c.dest, spendable);
                if (r.total <= 0) continue;
                c.profit = r.total;
                const sc = legScore(c.profit, c.time);
                let lo = 0, hi = out.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (legScore(out[mid].profit, out[mid].time) >= sc) lo = mid + 1; else hi = mid; }
                out.splice(lo, 0, c);
                if (out.length > need) out.length = need;
              }
            } else {
              out = base.sort(byScore);
            }
            const truncated = !!keep && (impact > 0 ? base.length > keep : out.length > keep);

            // Optional: split the hold between two nearby selling stops.
            if (split && out.length > 1) {
              const top = out.slice(0, Math.min(10, out.length));
              const extra = [];
              for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) {
                const B = top[a], C = top[b];
                const jbc = jumpsBetween(B.dest.system, C.dest.system);
                if (jbc === null) continue;
                const sp = splitLoad(here, B.dest, C.dest, spendable, capacity, blocked, minP, impact);
                if (sp.total <= Math.max(B.profit, C.profit) * 1.001) continue; // not better than one stop
                const d2 = dist3(B.dest.pos, C.dest.pos);
                for (const [first, second, firstIsB] of [[B, C, true], [C, B, false]]) {
                  const j2 = jbc;
                  extra.push({
                    dest: second.dest, via: first.dest, dist: first.dist + d2, jumps: first.jumps + j2,
                    parts: [{ dist: first.dist, jumps: first.jumps }, { dist: d2, jumps: j2 }],
                    profit: sp.total, picks: sp.picks, firstIsB,
                    time: legSeconds(first.jumps, first.dest.distLs) + legSeconds(j2, second.dest.distLs),
                  });
                }
              }
              if (extra.length) {
                out = out.concat(extra).sort(byScore);
              }
            }
            return { list: keep && out.length > keep ? out.slice(0, keep) : out, truncated };
          };

          let entry;
          if (ctx) {
            const ckey = objective + '|' + here.key + '|' + spendable + '|' + (opts.loop ? remainingAfter : '');
            entry = prep.candCache.get(ckey);
            if (!entry) {
              entry = build(CAND_KEEP);
              if (prep.candCache.size >= CAND_CACHE_MAX) prep.candCache.clear();
              prep.candCache.set(ckey, entry);
            }
          } else {
            entry = build(0);
          }
          let ranked = entry.list.filter(visitedOk);
          if (ranked.length < branch && entry.truncated) ranked = build(0).list.filter(visitedOk); // rare: cache too short
          for (let i = 0; i < ranked.length && cands.length < branch; i++) cands.push(ranked[i]);
        }

        for (const c of cands) {
          if (!c.picks) c.picks = picksFor(here, c.dest, spendable);
          const visited = new Set(partial.visited);
          visited.add(c.dest.key);
          if (c.via) visited.add(c.via.key);
          nextBeam.push({
            path: partial.path.concat([{ station: c.dest, via: c.via || null, parts: c.parts || null, firstIsB: c.firstIsB, picks: c.picks, profit: c.profit, jumpDist: c.dist, jumps: c.jumps }]),
            credits: partial.credits + c.profit,
            visited,
            totalProfit: partial.totalProfit + c.profit,
            totalDist: partial.totalDist + c.dist,
            totalTime: partial.totalTime + c.time,
          });
        }
      }

      if (nextBeam.length === 0) break; // dead end everywhere: keep the last beam
      // Best first (total credits, or credits per hour). Distance only breaks exact ties.
      nextBeam.sort((a, b) => partialScore(b) - partialScore(a) || a.totalDist - b.totalDist);
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

    const segPath = (a, b) => (graphMode ? pathFromTree(treeOf(a), b) : null);

    const routes = beam
      .filter((r) => r.path.length > 1)
      .sort((a, b) => partialScore(b) - partialScore(a) || a.totalDist - b.totalDist)
      .slice(0, maxResults)
      .map((r) => ({
        totalProfit: r.totalProfit,
        endCredits: r.credits,
        totalDist: r.totalDist,
        totalTime: r.totalTime,
        profitPerHour: r.totalTime > 0 ? (r.totalProfit / r.totalTime) * 3600 : 0,
        hops: r.path.slice(1).map((leg, i) => {
          const from = r.path[i].station;
          const stops = leg.via ? [leg.via, leg.station] : [leg.station];
          const segments = [];
          let prevSys = from.system;
          stops.forEach((st, si) => {
            const part = leg.parts ? leg.parts[si] : { dist: leg.jumpDist, jumps: leg.jumps };
            segments.push({ to: slim(st), distLy: part.dist, jumps: part.jumps, path: segPath(prevSys, st.system) });
            prevSys = st.system;
          });
          const atOf = leg.via ? (p) => (leg.firstIsB ? p.st : 1 - p.st) : null;
          return {
            from: slim(from),
            to: slim(leg.station),
            distLy: leg.jumpDist,
            jumps: leg.jumps,
            segments,
            load: describeLoad(leg.picks, data.commodities, atOf),
            profit: leg.profit,
            timeSec: legSeconds(leg.jumps, leg.station.distLs),
          };
        }),
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
    const k = Math.min(1, Math.max(0, opts.impact || 0));
    const one = (a, b) => {
      if (k > 0) return impactLoad(a, b, credits, capacity, blocked, opts.minProfitPerUnit, k, true);
      return bestLoad(a, b, credits, capacity, blocked, opts.minProfitPerUnit);
    };
    const fwd = one(from, to);
    const result = { load: describeLoad(fwd.picks, data.commodities), totalProfit: fwd.total, cost: fwd.cost };
    if (!result.load.length) {
      const rev = one(to, from);
      if (rev.total > 0) result.reverseProfit = rev.total;
    }
    return result;
  }


  /* ---------------- live re-pricing ---------------- */

  function normName(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /** A copy of a snapshot station whose market is replaced by live rows [[name, buy, sell, supply, demand], ...]. */
  function liveStationFrom(data, snap, live) {
    if (!data._commIndex) {
      data._commIndex = new Map();
      data.commodities.forEach((n, i) => data._commIndex.set(normName(n), i));
    }
    const list = [];
    for (const r of live.rows || []) {
      const id = data._commIndex.get(normName(r[0]));
      if (id === undefined) continue;
      let buy = r[1] | 0, sell = r[2] | 0;
      const sup = Math.min(Number(r[3]) || 0, 2147483647) | 0, dem = Math.min(Number(r[4]) || 0, 2147483647) | 0;
      if (buy > 0 && sup <= 0) buy = 0;
      if (sell > 0 && dem <= 0) sell = 0;
      if (buy <= 0 && sell <= 0) continue;
      list.push([id, buy, sell, sup, dem]);
    }
    list.sort((a, b) => a[0] - b[0]);
    const n = list.length;
    const ids = new Uint16Array(n), buy = new Int32Array(n), sell = new Int32Array(n), supply = new Int32Array(n), demand = new Int32Array(n);
    list.forEach((r, i) => { ids[i] = r[0]; buy[i] = r[1]; sell[i] = r[2]; supply[i] = r[3]; demand[i] = r[4]; });
    return Object.assign({}, snap, { ids, buy, sell, supply, demand, updated: live.updated || 0, live: true });
  }

  /**
   * Re-plan every leg of a route using live markets where we have them (snapshot otherwise).
   * liveMap: { stationKey: { rows, updated } }.  Loads are re-optimised, so the route shows what you
   * would actually do right now, not just the old plan with new prices.
   */
  function repriceRoute(data, route, liveMap, opts) {
    opts = opts || {};
    const impact = Math.min(1, Math.max(0, opts.impact || 0));
    const capacity = Math.max(1, Math.floor(opts.capacity || 1));
    const minP = opts.minProfitPerUnit;
    const insurance = opts.insurance || 0;
    const avoid = new Set(upperList(opts.avoidCommodities));
    const blocked = new Uint8Array(data.commodities.length);
    data.commodities.forEach((n, i) => { if (isBlockedCommodity(n) || avoid.has(n.toUpperCase())) blocked[i] = 1; });

    const cache = new Map();
    let liveCount = 0, total = 0;
    const stationFor = (key) => {
      if (cache.has(key)) return cache.get(key);
      const snap = data.stations[key];
      if (!snap) throw new Error('Station not in data: ' + key);
      const lv = liveMap && liveMap[key];
      const st = lv && lv.rows && lv.rows.length ? liveStationFrom(data, snap, lv) : snap;
      cache.set(key, st);
      total++;
      if (st.live) liveCount++;
      return st;
    };

    const startCredits = route.endCredits - route.totalProfit;
    let credits = startCredits, totalProfit = 0;
    const hops = route.hops.map((h) => {
      const origin = stationFor(h.from.key);
      const segs = h.segments && h.segments.length ? h.segments : [{ to: h.to, distLy: h.distLy, jumps: h.jumps, path: null }];
      const stops = segs.map((sg) => stationFor(sg.to.key));
      const spend = Math.max(0, credits - insurance);
      let picks, profit, atOf = null;
      if (stops.length > 1) {
        const r = splitLoad(origin, stops[0], stops[1], spend, capacity, blocked, minP, impact);
        picks = r.picks; profit = r.total; atOf = (p) => p.st;
      } else if (impact > 0) {
        const r = impactLoad(origin, stops[0], spend, capacity, blocked, minP, impact, true);
        picks = r.picks; profit = r.total;
      } else {
        const r = bestLoad(origin, stops[0], spend, capacity, blocked, minP);
        picks = r.picks; profit = r.total;
      }
      credits += profit;
      totalProfit += profit;
      return Object.assign({}, h, {
        from: slim(origin),
        to: slim(stops[stops.length - 1]),
        segments: segs.map((sg, i) => Object.assign({}, sg, { to: slim(stops[i]) })),
        load: describeLoad(picks, data.commodities, atOf),
        profit,
      });
    });

    return Object.assign({}, route, {
      totalProfit,
      endCredits: startCredits + totalProfit,
      profitPerHour: route.totalTime > 0 ? (totalProfit / route.totalTime) * 3600 : 0,
      hops,
      snapshotProfit: route.snapshotProfit != null ? route.snapshotProfit : route.totalProfit,
      live: { checked: liveCount, total, at: Date.now() },
    });
  }

  function reachRadius(opts) {
    const ly = Math.max(1, opts.lyPer || 20);
    return ly * (opts.jumpsPer === 0 ? 0 : (opts.jumpsPer || 2)) * Math.max(1, Math.floor(opts.hops || 2));
  }

  function createContext() {
    return { preps: new Map(), memo: new Map(), memoI: new Map(), memoSize: 0, trees: new Map(), sysGrid: null };
  }

  /** Number of stations a search with these limits could use (cheap; used to skip duplicate windows). */
  function countStations(data, opts) {
    const st = data.stations[opts.startKey];
    if (!st) return 0;
    const prep = prepStations(data, Object.assign({}, opts, { _center: data.systems[st.system], _reach: reachRadius(opts) }));
    return prep.stations.length;
  }

  const api = { createContext, countStations, reachRadius, repriceRoute, findRoutes, bestSingleTrade, bestLoad, impactLoad, splitLoad, dist3, isBlockedCommodity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TDOptimizer = api;
})(typeof self !== 'undefined' ? self : this);

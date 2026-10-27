// Run with: node tests/optimizer.test.js   (no dependencies)
global.self = global; // modules attach to `self` (as in a browser/worker) so engine.js can find them
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { buildDataset } = require('../data.js');
const { findRoutes, bestLoad, bestSingleTrade } = require('../optimizer.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

const COMMS = ['ALPHA', 'BETA', 'GAMMA', 'DELTA'];
/** station spec: { key, system, pad?, flags?, updated?, rows: [[commodityIdx, buy, sell, supply, demand], ...] } */
function makeData(systems, stations) {
  const meta = { version: 2, commodities: COMMS, systems, generated_at: '2026-01-01T00:00:00Z' };
  const st = {};
  for (const s of stations) st[s.key] = [s.pad || 'L', s.ls || 0, s.flags || 0, s.updated || 0, [].concat(...s.rows)];
  return buildDataset(meta, [{ stations: st }]);
}
const base = {
  credits: 100000, insurance: 0, capacity: 10, lyPer: 20, jumpsPer: 1, hops: 1, noRevisit: true,
  minProfitPerUnit: 1, beamWidth: 8, maxResults: 8, requirePad: 'any',
};
const blockedNone = (d) => new Uint8Array(d.commodities.length);

console.log('optimizer');

test('cash-limited loads use return-on-credit, not just margin', () => {
  // A: buy 1000 / sell 1500 (+500). B: buy 100 / sell 400 (+300). 10,000 credits, 100 t.
  const d = makeData({ X: [0, 0, 0], Y: [1, 0, 0] }, [
    { key: 'X/ONE', system: 'X', rows: [[0, 1000, 0, 1e6, 0], [1, 100, 0, 1e6, 0]] },
    { key: 'Y/TWO', system: 'Y', rows: [[0, 0, 1500, 0, 1e6], [1, 0, 400, 0, 1e6]] },
  ]);
  const r = bestLoad(d.stations['X/ONE'], d.stations['Y/TWO'], 10000, 100, blockedNone(d), 1);
  assert.strictEqual(r.total, 30000); // 100 x B beats 10 x A (5,000)
});

test('zero-supply "buy" and zero-demand "sell" are not tradable', () => {
  const d = makeData({ X: [0, 0, 0], Y: [1, 0, 0] }, [
    { key: 'X/ONE', system: 'X', rows: [[0, 100, 0, 0, 0]] },            // price but no stock
    { key: 'Y/TWO', system: 'Y', rows: [[0, 0, 500, 0, 0]] },            // price but no demand
  ]);
  assert.strictEqual(d.stations['X/ONE'].ids.length, 0);
  assert.strictEqual(d.stations['Y/TWO'].ids.length, 0);
});

test('supply and demand cap the units', () => {
  const d = makeData({ X: [0, 0, 0], Y: [1, 0, 0] }, [
    { key: 'X/ONE', system: 'X', rows: [[0, 100, 0, 7, 0]] },
    { key: 'Y/TWO', system: 'Y', rows: [[0, 0, 200, 0, 5]] },
  ]);
  const r = bestLoad(d.stations['X/ONE'], d.stations['Y/TWO'], 1e6, 100, blockedNone(d), 1);
  assert.strictEqual(r.picks[0].units, 5);
});

test('search maximises total credits, ignoring distance', () => {
  // From S: NEAR is 1 ly away (profit 100/t), FAR is 19 ly away (profit 900/t). Pure CR must pick FAR.
  const d = makeData({ S: [0, 0, 0], N: [1, 0, 0], F: [19, 0, 0] }, [
    { key: 'S/HOME', system: 'S', rows: [[0, 100, 0, 1e6, 0]] },
    { key: 'N/NEAR', system: 'N', rows: [[0, 0, 200, 0, 1e6]] },
    { key: 'F/FAR', system: 'F', rows: [[0, 0, 1000, 0, 1e6]] },
  ]);
  const { routes } = findRoutes(d, Object.assign({}, base, { startKey: 'S/HOME' }));
  assert.strictEqual(routes[0].hops[0].to.key, 'F/FAR');
  assert.strictEqual(routes[0].totalProfit, 9000);
  assert.strictEqual(routes[1].hops[0].to.key, 'N/NEAR');
});

test('beam search matches exhaustive search on a small graph', () => {
  const sysNames = ['A', 'B', 'C', 'D', 'E', 'F'];
  const systems = {}; sysNames.forEach((n, i) => { systems[n] = [i * 5, (i * 7) % 11, 0]; });
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const stations = sysNames.map((n) => ({
    key: n + '/ST', system: n,
    rows: COMMS.map((_, c) => { const p = 100 + Math.floor(rnd() * 400); return [c, p, p + Math.floor(rnd() * 300) - 80, 1e6, 1e6]; }),
  }));
  const d = makeData(systems, stations);
  const o = Object.assign({}, base, { startKey: 'A/ST', hops: 3, jumpsPer: 5, capacity: 20, credits: 1e6, beamWidth: 16, branch: 50 });
  const got = findRoutes(d, o).routes[0].totalProfit;

  const keys = sysNames.map((n) => n + '/ST'); const blocked = blockedNone(d);
  let best = 0;
  (function walk(at, credits, visited, profit, left) {
    if (!left) { best = Math.max(best, profit); return; }
    for (const k of keys) {
      if (visited.has(k)) continue;
      const r = bestLoad(d.stations[at], d.stations[k], credits, 20, blocked, 1);
      if (r.total <= 0) continue;
      walk(k, credits + r.total, new Set(visited).add(k), profit + r.total, left - 1);
    }
  })('A/ST', 1e6, new Set(['A/ST']), 0, 3);
  assert.strictEqual(got, best);
});

test('loop ends back at the start station', () => {
  const d = makeData({ S: [0, 0, 0], T: [5, 0, 0], U: [10, 0, 0] }, [
    { key: 'S/HOME', system: 'S', rows: [[0, 100, 150, 1e6, 1e6], [1, 0, 0, 0, 0]] },
    { key: 'T/MID', system: 'T', rows: [[0, 300, 400, 1e6, 1e6]] },
    { key: 'U/END', system: 'U', rows: [[0, 100, 600, 1e6, 1e6]] },
  ]);
  const { routes } = findRoutes(d, Object.assign({}, base, { startKey: 'S/HOME', hops: 3, jumpsPer: 2, loop: true }));
  assert.ok(routes.length > 0);
  for (const r of routes) assert.strictEqual(r.hops[r.hops.length - 1].to.key, 'S/HOME');
});

test('fleet carriers are excluded unless requested', () => {
  const d = makeData({ S: [0, 0, 0], C: [3, 0, 0] }, [
    { key: 'S/HOME', system: 'S', rows: [[0, 100, 0, 1e6, 0]] },
    { key: 'C/ABC-123', system: 'C', flags: 2, rows: [[0, 0, 900, 0, 1e6]] },
  ]);
  assert.strictEqual(findRoutes(d, Object.assign({}, base, { startKey: 'S/HOME' })).routes.length, 0);
  assert.strictEqual(findRoutes(d, Object.assign({}, base, { startKey: 'S/HOME', includeCarriers: true })).routes.length, 1);
});

test('max price age filter drops stale stations and warns when there are no timestamps', () => {
  const now = Math.floor(Date.now() / 1000);
  const d = makeData({ S: [0, 0, 0], O: [3, 0, 0], F: [4, 0, 0] }, [
    { key: 'S/HOME', system: 'S', updated: now, rows: [[0, 100, 0, 1e6, 0]] },
    { key: 'O/OLD', system: 'O', updated: now - 5 * 86400, rows: [[0, 0, 900, 0, 1e6]] },
    { key: 'F/FRESH', system: 'F', updated: now - 600, rows: [[0, 0, 300, 0, 1e6]] },
  ]);
  const r = findRoutes(d, Object.assign({}, base, { startKey: 'S/HOME', maxAgeHours: 24 }));
  assert.strictEqual(r.routes.length, 1);
  assert.strictEqual(r.routes[0].hops[0].to.key, 'F/FRESH');
  const d2 = makeData({ S: [0, 0, 0], O: [3, 0, 0] }, [
    { key: 'S/HOME', system: 'S', rows: [[0, 100, 0, 1e6, 0]] },
    { key: 'O/OLD', system: 'O', rows: [[0, 0, 900, 0, 1e6]] },
  ]);
  const r2 = findRoutes(d2, Object.assign({}, base, { startKey: 'S/HOME', maxAgeHours: 24 }));
  assert.strictEqual(r2.routes.length, 1);
  assert.ok(r2.warnings.some((w) => /timestamps/.test(w)));
});

test('unknown "head toward" system produces a warning instead of silently doing nothing', () => {
  const d = makeData({ S: [0, 0, 0], T: [5, 0, 0] }, [
    { key: 'S/HOME', system: 'S', rows: [[0, 100, 0, 1e6, 0]] },
    { key: 'T/AWAY', system: 'T', rows: [[0, 0, 300, 0, 1e6]] },
  ]);
  const r = findRoutes(d, Object.assign({}, base, { startKey: 'S/HOME', towardSystem: 'Nowhere' }));
  assert.ok(r.warnings.some((w) => /Nowhere/.test(w)));
  assert.strictEqual(r.routes.length, 1);
});

test('returns up to maxResults routes (not capped at 5)', () => {
  const systems = { S: [0, 0, 0] }; const stations = [{ key: 'S/HOME', system: 'S', rows: [[0, 100, 0, 1e6, 0]] }];
  for (let i = 0; i < 12; i++) { systems['D' + i] = [i + 1, 0, 0]; stations.push({ key: 'D' + i + '/X', system: 'D' + i, rows: [[0, 0, 200 + i * 10, 0, 1e6]] }); }
  const d = makeData(systems, stations);
  const r = findRoutes(d, Object.assign({}, base, { startKey: 'S/HOME', jumpsPer: 3, maxResults: 10, beamWidth: 4 }));
  assert.strictEqual(r.routes.length, 10);
});

test('quick trade reports the reverse direction when A->B loses money', () => {
  const d = makeData({ X: [0, 0, 0], Y: [1, 0, 0] }, [
    { key: 'X/ONE', system: 'X', rows: [[0, 0, 100, 0, 1e6]] },
    { key: 'Y/TWO', system: 'Y', rows: [[0, 50, 0, 1e6, 0]] },
  ]);
  const r = bestSingleTrade(d, 'X/ONE', 'Y/TWO', 1e5, 10);
  assert.strictEqual(r.load.length, 0);
  assert.ok(r.reverseProfit > 0);
});


test('price impact lowers profit on a big load, and k = 0 matches listed prices', () => {
  const d = makeData({ X: [0, 0, 0], Y: [1, 0, 0] }, [
    { key: 'X/ONE', system: 'X', rows: [[0, 100, 0, 100, 0]] },
    { key: 'Y/TWO', system: 'Y', rows: [[0, 0, 200, 0, 100]] },
  ]);
  const o = Object.assign({}, base, { startKey: 'X/ONE', capacity: 100, credits: 1e6 });
  assert.strictEqual(findRoutes(d, o).routes[0].totalProfit, 10000);
  // k=0.5: marginal profit = 100 - 1.5 x, so the best load stops at ~67 units (profit ~3,333), not all 100 (2,500).
  const imp = findRoutes(d, Object.assign({}, o, { impact: 0.5 })).routes[0];
  assert.ok(imp.totalProfit >= 3300 && imp.totalProfit <= 3334, 'got ' + imp.totalProfit);
  assert.ok(imp.hops[0].load[0].units >= 64 && imp.hops[0].load[0].units <= 70, 'stops buying once the margin is gone');
  assert.ok(imp.hops[0].load[0].buyAvg > imp.hops[0].load[0].buy, 'average buy price is above the listed price');
  assert.ok(imp.hops[0].load[0].sellAvg < imp.hops[0].load[0].sell, 'average sell price is below the listed price');
  // small loads barely move the price
  const small = findRoutes(d, Object.assign({}, o, { capacity: 2, impact: 0.5 })).routes[0].totalProfit;
  assert.ok(small >= 190 && small <= 200, 'got ' + small);
});

test('real jump paths: a gap with no intermediate system is not reachable, a stepping stone is', () => {
  const stations = [
    { key: 'S/HOME', system: 'S', rows: [[0, 100, 0, 1e6, 0]] },
    { key: 'T/FAR', system: 'T', rows: [[0, 0, 400, 0, 1e6]] },
  ];
  const o = Object.assign({}, base, { startKey: 'S/HOME', lyPer: 20, jumpsPer: 2 });
  const gap = makeData({ S: [0, 0, 0], T: [30, 0, 0] }, stations);
  assert.strictEqual(findRoutes(gap, Object.assign({}, o, { pathMode: 'line' })).routes.length, 1, 'straight-line says reachable');
  assert.strictEqual(findRoutes(gap, Object.assign({}, o, { pathMode: 'graph' })).routes.length, 0, 'no star within 20 ly of both ends');
  const bridged = makeData({ S: [0, 0, 0], M: [15, 0, 0], T: [30, 0, 0] }, stations);
  const r = findRoutes(bridged, Object.assign({}, o, { pathMode: 'graph' })).routes[0];
  assert.deepStrictEqual(r.hops[0].segments[0].path, ['S', 'M', 'T']);
  assert.strictEqual(r.hops[0].jumps, 2);
});

test('credits-per-hour objective prefers a quick trade over a bigger but slower one', () => {
  const d = makeData({ S: [0, 0, 0], N: [1, 0, 0], F: [2, 0, 0] }, [
    { key: 'S/HOME', system: 'S', rows: [[0, 100, 0, 1e6, 0]] },
    { key: 'N/NEAR', system: 'N', ls: 100, rows: [[0, 0, 400, 0, 1e6]] },       // +3000
    { key: 'F/FAR', system: 'F', ls: 400000, rows: [[0, 0, 600, 0, 1e6]] },     // +5000, ~14 min supercruise
  ]);
  const o = Object.assign({}, base, { startKey: 'S/HOME', jumpsPer: 2 });
  assert.strictEqual(findRoutes(d, o).routes[0].hops[0].to.key, 'F/FAR');
  const r = findRoutes(d, Object.assign({}, o, { objective: 'rate' })).routes[0];
  assert.strictEqual(r.hops[0].to.key, 'N/NEAR');
  assert.ok(r.totalTime > 0 && r.profitPerHour > 0);
});

test('split cargo across two stops beats the best single stop when demand is small', () => {
  const d = makeData({ S: [0, 0, 0], X: [3, 0, 0], Y: [6, 0, 0] }, [
    { key: 'S/HOME', system: 'S', rows: [[0, 100, 0, 1e6, 0]] },
    { key: 'X/HIGH', system: 'X', rows: [[0, 0, 300, 0, 4]] },      // pays 300 but only wants 4
    { key: 'Y/LOW', system: 'Y', rows: [[0, 0, 200, 0, 100]] },     // pays 200, wants plenty
  ]);
  const o = Object.assign({}, base, { startKey: 'S/HOME', capacity: 10, jumpsPer: 2, credits: 1e6 });
  assert.strictEqual(findRoutes(d, o).routes[0].totalProfit, 1000);
  const r = findRoutes(d, Object.assign({}, o, { split: true })).routes[0];
  assert.strictEqual(r.totalProfit, 1400); // 4 x 200 at X + 6 x 100 at Y
  assert.strictEqual(r.hops[0].segments.length, 2);
  const at0 = r.hops[0].load.filter((l) => l.at === 0).reduce((n, l) => n + l.units, 0);
  const at1 = r.hops[0].load.filter((l) => l.at === 1).reduce((n, l) => n + l.units, 0);
  assert.strictEqual(at0 + at1, 10);
  assert.ok(at0 === 4 || at1 === 4, 'the 4 high-paying units are sold at the HIGH station');
});

async function asyncTests() {
  const dir = path.join(__dirname, '..');
  const fetched = [];
  global.fetch = async (u) => { fetched.push(u); return new Response(fs.readFileSync(path.join(dir, u)), { status: 200 }); };
  const { createEngine } = require('../engine.js');

  const engine = createEngine();
  const info = await engine.load('trade-data.json', () => {});
  try {
    assert.ok(info.tiled, 'sample is a tiled dataset');
    assert.ok(info.stationCount > 100);
    assert.strictEqual(fetched.length, 2, 'only meta + index are downloaded up front');
    passed++; console.log('  ok   tiled dataset: only the station index loads at start');
  } catch (e) { console.error('  FAIL tiled load\n       ' + e.stack); process.exitCode = 1; }

  try {
    const start = info.index[0][0];
    const before = fetched.length;
    const res = await engine.run(Object.assign({}, base, { startKey: start, hops: 3, jumpsPer: 2, credits: 200000, capacity: 64, maxAgeHours: 0 }), () => {});
    assert.ok(fetched.length > before, 'tiles were fetched on demand');
    assert.ok(res.routes.length > 0 && res.routes[0].totalProfit > 0);
    const again = fetched.length;
    await engine.run(Object.assign({}, base, { startKey: start, hops: 3, jumpsPer: 2, credits: 200000, capacity: 64, maxAgeHours: 0 }), () => {});
    assert.strictEqual(fetched.length, again, 'tiles are cached after the first run');
    passed++; console.log('  ok   tiled dataset: tiles load on demand, then are cached');
  } catch (e) { console.error('  FAIL tiled run\n       ' + e.stack); process.exitCode = 1; }

  try {
    await assert.rejects(() => engine.run(Object.assign({}, base, { startKey: 'NOPE/NOPE' })), /Unknown starting station/);
    passed++; console.log('  ok   unknown start station is rejected');
  } catch (e) { console.error('  FAIL unknown start\n       ' + e.stack); process.exitCode = 1; }

  // Regression: a looser price-age limit must never score lower than a stricter one.
  try {
    const now = Math.floor(Date.now() / 1000);
    const st = {}; const systems = { S: [0, 0, 0], G: [5, 0, 0], H: [10, 0, 0] };
    const row = (c, b, se, sup, dem) => [c, b, se, sup, dem];
    st['S/HOME'] = ['L', 0, 0, now, [].concat(row(0, 100, 0, 1e6, 0), row(1, 100, 0, 1e6, 0))];
    // four STALE decoys: great first hop (+1000) but a dead end
    for (let i = 0; i < 4; i++) { systems['D' + i] = [1 + i, 0, 0]; st['D' + i + '/X'] = ['L', 0, 0, now - 3 * 86400, [].concat(row(0, 0, 200, 0, 1e6))]; }
    // fresh route: small first hop (+500) then a big second hop (+5000)
    st['G/MID'] = ['L', 0, 0, now - 600, [].concat(row(1, 0, 150, 0, 1e6), row(2, 100, 0, 1e6, 0))];
    st['H/END'] = ['L', 0, 0, now - 600, [].concat(row(2, 0, 600, 0, 1e6))];
    const meta = { version: 2, commodities: ['A', 'B', 'C'], systems, shards: [{ file: 'x.json' }], generated_at: '2026-01-01T00:00:00Z' };
    const realFetch = global.fetch;
    global.fetch = async (u) => new Response(JSON.stringify(u === 'meta.json' ? meta : { stations: st }), { status: 200 });
    const e2 = createEngine();
    await e2.load('meta.json', () => {});
    global.fetch = realFetch;
    const opts = Object.assign({}, base, { startKey: 'S/HOME', hops: 2, jumpsPer: 1, lyPer: 20, jumpsPer: 2, capacity: 10, widths: [2], maxResults: 3 });
    const strict = await e2.run(Object.assign({}, opts, { maxAgeHours: 24 }));
    const loose = await e2.run(Object.assign({}, opts, { maxAgeHours: 168 }));
    assert.strictEqual(strict.routes[0].totalProfit, 5500, 'strict window finds the good route');
    assert.ok(loose.routes[0].totalProfit >= strict.routes[0].totalProfit, 'looser window is never worse (got ' + loose.routes[0].totalProfit + ')');
    passed++; console.log('  ok   looser price-age limit never scores lower than a stricter one');
  } catch (e) { console.error('  FAIL age monotonic\n       ' + e.stack); process.exitCode = 1; }

  try {
    const { tilesNear } = require('../data.js');
    const data = { meta: { tiles: [{ bbox: [0, 0, 0, 10, 10, 10] }, { bbox: [100, 0, 0, 110, 10, 10] }] } };
    assert.deepStrictEqual(tilesNear(data, { x: 5, y: 5, z: 5 }, 1), [0]);
    assert.deepStrictEqual(tilesNear(data, { x: 50, y: 5, z: 5 }, 50), [0, 1]);
    assert.deepStrictEqual(tilesNear(data, { x: 50, y: 5, z: 5 }, 30), []);
    passed++; console.log('  ok   tile selection by bounding box');
  } catch (e) { console.error('  FAIL tilesNear\n       ' + e.stack); process.exitCode = 1; }
}

asyncTests().then(() => console.log(passed + ' passed' + (process.exitCode ? ', with failures' : '')));

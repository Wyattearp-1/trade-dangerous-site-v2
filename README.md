# Trade Dangerous — Web

A browser port of the core idea behind [Trade Dangerous](https://github.com/eyeonus/Trade-Dangerous):
a multi-hop trade route planner for Elite: Dangerous that **finds the routes that earn the most
credits**.

This is **not** the original TD codebase (a Python CLI/GUI with its own SQLite database). It re-implements the
*routing idea* as a self-contained static site, and uses GitHub Actions to keep the market data as fresh as a
static site can be.

## Setup (GitHub Pages)

1. Create a repository and push this folder as its **root** (not nested in a subfolder).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write** (the data job pushes the `data` branch).
4. **Actions → "Build and deploy" → Run workflow** with *Rebuild the market data* ticked.
   The first run downloads and parses the whole Spansh dump (expect up to an hour or two). Until then the site serves the bundled sample.

After that the schedule rebuilds the data twice a day (skipping the build if Spansh hasn't published a new dump)
and every push to `main` redeploys the site.

### Why a `data` branch?

The dataset is tens of MB and changes with every refresh. Committing it to `main` would add that much to the git
history each time. Instead the workflow force-pushes it as a single orphan commit to a branch called `data`, and
the deploy job merges the latest data into the site artifact. `main` only ever contains source code and a small
sample dataset.

## What the planner does

* **Two ways to search ("Optimize for"):**
  * **Maximum total credits** (default): every hop is scored by the cargo profit it makes and the search keeps the
    richest partial routes. Distance is a reach limit only; it is displayed but never traded off against profit.
  * **Credits per hour:** profit divided by an estimated trip time. Time per leg = seconds per jump x jumps +
    supercruise to the station (estimated from its distance from the star: 25 s + 1.25 x sqrt(Ls)) + a station stop
    (docking, trading, launching). Fixed assumptions: 50 s per jump and 150 s per stop (constants `secJ` / `secStop` in
    `optimizer.js` if you want to change them). These are rough estimates, not measurements, and are not Inara's formula
    (Inara doesn't publish how it computes per-hour figures). Rate mode also runs the max-credits search and pools the two, so it can never come back
    slower (per hour) than the max-credits route.
* **Price movement (Light / Medium / Heavy / Off):** buying raises a station's price and selling lowers it as you use up
  its stock or demand. The average price over x units is `p * (1 + k*x/(2*stock))` when buying and
  `s * (1 - k*x/(2*demand))` when selling, with k = 0.15 / 0.3 / 0.6. Elite does not publish its real formula, so
  this is an estimate; it matters most for big holds, where it stops the planner from assuming you can buy 700 t at the
  listed price. The planner also stops buying once the extra units no longer make money. Results show the average price
  you would actually pay/get, with the listed price underneath.
* **Real jump paths:** a hop only counts if you can really get there, one jump at a time (each jump no longer than
  your jump range, at most "max jumps between hops" jumps). Each leg shows the systems to jump through and the true
  jump count. Only systems in the data are used as waypoints (every system that has a station market), so a path can
  be longer than the real best one, and a destination reachable only through empty, unlisted stars can be missed. Switch
  to **Straight line** for the old, faster, optimistic behaviour.
* **Split cargo across two stops (optional):** sell part of the hold at one station and the rest at a second nearby
  one when that earns more (for example when the best buyer only wants a few tons). Considers pairs among the best
  destinations; the two stops must be within your jump limit of each other.
* Start station, credits, insurance reserve, cargo capacity, jump range, jumps per hop, number of hops, optional
  loop back to start, optional "head toward" system, avoid-lists (systems / stations / commodities), minimum profit,
  pad size, max distance from star, **max price age**, fleet carriers (off by default) and Odyssey/planetary toggles.
* **Cargo loads respect both cargo space and credits.** When credits are tight, loads are re-ranked by return on
  credit so an expensive high-margin good doesn't crowd out a cheaper, better-value one.
* Supply and demand cap the units; a price with no stock/demand behind it is never traded.
* Results read as steps (BUY here, fly, SELL there) with stock, pad size, distance from star, price age, trip time and
  credits per hour.
* Copy a route as text, or copy a link that restores all your settings. Settings are also remembered per browser.
* The search runs in a Web Worker, so the page stays responsive (it falls back to the main thread if workers are
  unavailable).

### Known limits

* In **Straight line** mode, reach per hop is `jump range × max jumps` measured in a straight line. In **Real jump paths** mode it is a true jump path through known systems (see above).
* It is a beam search, so it is a very good heuristic but not a proof of optimality. To make it dependable, each run uses a fixed schedule of beam widths (set by **Search effort**) and runs it over **every price-age window up to the one you chose** (1h, 6h, 24h, 3 days, 7 days, any), pooling the results. A looser setting therefore runs every pass a stricter one runs, so loosening a limit (e.g. 3 days → 7 days → any) can never return a worse best route. The schedule is fixed rather than time-based on purpose, so results are repeatable. Shared caches make the repeated passes cheap.
* "Head toward" requires each hop to end closer to the target system (or within one jump range of it); it is ignored in loop mode.
* Prices are a snapshot. Always verify against live prices (every station links to Inara) before you buy.

## Live prices

The nightly snapshot can be hours old, so after every search the page automatically checks **current** prices:

1. It takes the routes it is about to show (plus a few extra candidates) and asks public community services for the
   live market of each station on them: [EDSM](https://www.edsm.net/) first, then [Ardent](https://ardent-insight.com/)
   as a fallback. Both are fed by players' game uploads through EDDN, so their data is usually minutes old.
2. Each route is **re-planned** with the live prices (cargo is re-optimised, not just re-priced), and the list is
   re-ranked, so a route that only looked good on stale prices drops out. Routes show a badge such as
   `LIVE 4/5 · -12% vs snapshot`, and stations show a LIVE tag with the age of their prices.
3. It re-checks every 5 minutes while results stay on screen, and when you return to the tab. Lookups are cached for 3
   minutes and made a few at a time to be polite to the services.
4. If a service is down, rate-limits, or blocks browser requests (CORS), the page keeps using the snapshot and says so.
   The About tab has a **Test live price connection** button that shows which service works from your browser.

Limits: this is as live as a website can be without a server listening to the game's data feed (EDDN is not reachable
from a browser). Only stations on the routes being shown are checked; the search itself still runs on the snapshot.
The live services' response formats were written from their public documentation and are parsed defensively, but have
not been verified against the live APIs from this project's build environment, so use the test button after deploying.
Station names are matched by name (the snapshot does not store market IDs).

## Data: every station is searchable

The builder (`build_data.py`) streams the [Spansh](https://spansh.co.uk/dumps) `galaxy_stations` dump and keeps
**every station that has a market**, so any station can be picked as a start point. Shipping the whole galaxy to every
visitor would be far too large, so it is split in two:

* **Index** (`trade-index-<hash>.json`): every system's coordinates and every station's name, pad size, flags and price
  timestamp. This is all that downloads when the page opens, and it powers the search box.
* **Tiles** (`trade-tile-<n>-<hash>.json`, ~2,500 stations each): market prices, split spatially with a k-d tree so tiles
  are small where space is dense and large where it is empty. When you plot a route, the site downloads only the tiles
  within *jump range × jumps per hop × hops* of your start station (nothing farther can be visited), then caches them.
  Plotting from the same area again downloads nothing.

Other data rules:

* Each station keeps its price **timestamp**; fleet carriers and planetary stations are flagged. Routes skip prices older
  than the **Max price age** setting (default 7 days), so a stale price can't fake a huge profit. Your start station is
  always allowed, however old its data is.
* Fleet carriers not updated for 14 days (`TD_CARRIER_MAX_AGE_DAYS`) are dropped entirely: they move or vanish.
* Stock/demand that doesn't exist, salvage goods, and goods a station prohibits are removed.
* **Outlier prices are dropped** (more than 3× above or 4× below a commodity's median). A search that maximises
  credits would otherwise plan entire runs around a typo'd or stale price. Tune with `TD_OUTLIER_HIGH` / `TD_OUTLIER_LOW` (0 disables).
* All data files except the small `trade-data.json` meta file have content-hashed names, so browsers cache them indefinitely.

| Setting | Default | Meaning |
|---|---|---|
| `TD_SOURCE_URL` | Spansh `galaxy_stations.json.gz` | dump URL or local path |
| `TD_MAX_AGE_DAYS` | 0 | drop markets older than this (0 = keep all, so every station stays findable) |
| `TD_CARRIER_MAX_AGE_DAYS` | 14 | drop fleet carriers not updated for this long (0 = keep all) |
| `TD_MAX_STATIONS` | 0 | optional cap, freshest first (0 = no cap) |
| `TD_MAX_LY` | 0 | optional radius around Sol (0 = whole galaxy) |
| `TD_TILE_STATIONS` | 2500 | stations per tile |
| `TD_OUTLIER_HIGH` / `TD_OUTLIER_LOW` | 3 / 4 | outlier price factors |

> EDDBlink/Tromador is **not** supported (earlier versions of this README claimed it was; the script never implemented it).
> Inara has no bulk market dump, so it is only used for station links.

### Data format (v3)

`trade-data.json` (meta):

```json
{
  "version": 3, "generated_at": "2026-10-20T06:30:00Z", "source": "Spansh galaxy_stations dump", "has_ages": true,
  "commodities": ["ADVANCED CATALYSERS", "…"],
  "index": { "file": "trade-index-1a2b3c4d.json", "bytes": 9000000 },
  "tiles": [{ "file": "trade-tile-1-5e6f7a8b.json", "bytes": 2600000, "count": 2500, "bbox": [minx, miny, minz, maxx, maxy, maxz] }]
}
```

The index is `{"systems": {"SOL": [x, y, z, [[stationName, pad, flags, updatedUnix, tileIndex], …]]}}`. Each tile is
`{"stations": {"SOL/ABRAHAM LINCOLN": [pad, distLs, flags, updatedUnix, [ci, buy, sell, supply, demand, …]]}}` where `flags`
bit 0 = planetary/Odyssey surface, bit 1 = fleet carrier. The older v2 (shard) and v1 formats still load.

## Local development

```bash
# serve the site with the bundled sample data
python -m http.server 8000          # http://localhost:8000

# build real data and serve it
pip install -r requirements.txt
python build_data.py --out out/trade-data.json            # downloads the Spansh dump
cp index.html style.css *.js out/ && (cd out && python -m http.server 8000)

# tests
node tests/optimizer.test.js
python -m unittest discover -s tests -v
```

Open the site over `http://` (not `file://`): browsers block `fetch` and Web Workers on `file://` pages.

## Repository layout

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | UI |
| `data.js` | dataset download (index + on-demand tiles) and normalisation |
| `live.js` | live market lookups (EDSM / Ardent) for the automatic price check |
| `optimizer.js` | route search and cargo loading |
| `engine.js`, `worker.js` | runs the above off the UI thread |
| `build_data.py` | builds the dataset from Spansh |
| `trade-data.json`, `trade-index-*.json`, `trade-tile-*.json` | small bundled sample dataset (replaced by real data at deploy) |
| `tests/` | JS and Python tests |
| `.github/workflows/deploy.yml` | test → refresh data → deploy |

## License

MIT for this code. Not affiliated with Frontier Developments, Elite Dangerous, Trade Dangerous, Spansh, Inara, or Tromador —
inspired by Trade Dangerous only.

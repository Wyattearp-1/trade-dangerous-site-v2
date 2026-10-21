#!/usr/bin/env python3
"""Build the tiled trade dataset (format v3) from the Spansh galaxy_stations dump.

EVERY station with a market is included, so any station can be found. To keep downloads small the
data is split into:

  trade-data.json            small meta file: commodity list, tile list (with bounding boxes)
  trade-index-<hash>.json    every system (coordinates) and every station name, pad, flags, update time
  trade-tile-<n>-<hash>.json market data for ~2,500 stations each, split spatially (k-d tree) so the
                             browser only downloads the regions a route search can actually reach

Station record in a tile:  [pad, distLs, flags, updatedUnixSeconds, [ci,buy,sell,supply,demand, ...]]
  flags: bit0 = planetary / Odyssey surface, bit1 = fleet carrier

Environment / CLI
  TD_SOURCE_URL          dump URL or local path (.json / .json.gz)
  TD_MAX_AGE_DAYS        drop markets older than this (default 0 = keep everything)
  TD_CARRIER_MAX_AGE_DAYS  fleet carriers move and vanish; drop ones not updated for this long (default 14, 0 = off)
  TD_MAX_STATIONS        optional cap, freshest first (default 0 = no cap)
  TD_MAX_LY              optional radius around Sol (default 0 = whole galaxy)
  TD_TILE_STATIONS       target stations per tile (default 2500)
  TD_OUTLIER_HIGH/LOW    price sanity: drop prices above median*HIGH (default 3) or below median/LOW (default 4); 0 = off
"""
from __future__ import annotations

import argparse
from array import array
import contextlib
import gzip
import hashlib
import heapq
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import ijson
except ImportError:  # pragma: no cover
    ijson = None

DEFAULT_SOURCE_URL = os.environ.get(
    "TD_SOURCE_URL", "https://downloads.spansh.co.uk/galaxy_stations.json.gz"
)
FORMAT_VERSION = 3
FLAG_PLANETARY = 1
FLAG_CARRIER = 2
INT32_MAX = 2_147_483_647
MAX_FILE_BYTES = 95_000_000  # GitHub hard-limits files at 100 MB


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- source handling

def is_url(s: str) -> bool:
    return s.startswith(("http://", "https://"))


@contextlib.contextmanager
def open_source(src: str):
    """Open a URL or local file, transparently un-gzipping; closes everything on exit."""
    if is_url(src):
        log(f"Downloading {src} ...")
        req = urllib.request.Request(src, headers={"User-Agent": "trade-dangerous-web/3.0"})
        raw = urllib.request.urlopen(req, timeout=300)
    else:
        log(f"Reading {src} ...")
        raw = open(src, "rb")
    stream = gzip.GzipFile(fileobj=raw) if src.endswith(".gz") else raw
    try:
        yield stream
    finally:
        if stream is not raw:
            stream.close()
        raw.close()


def head_info(url: str) -> dict:
    """ETag / Last-Modified of the dump, used to skip rebuilds when upstream did not change."""
    if not is_url(url):
        try:
            st = os.stat(url)
            return {"etag": None, "last_modified": str(int(st.st_mtime))}
        except OSError:
            return {}
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "trade-dangerous-web/3.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return {"etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified")}
    except Exception as exc:  # network trouble: just build
        log(f"HEAD request failed ({exc}); will build regardless.")
        return {}


def unchanged_since(previous_meta: Path, info: dict) -> bool:
    if not previous_meta or not previous_meta.exists() or not info:
        return False
    if not (info.get("etag") or info.get("last_modified")):
        return False
    try:
        prev = json.loads(previous_meta.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (
        prev.get("version") == FORMAT_VERSION
        and prev.get("source_etag") == info.get("etag")
        and prev.get("source_last_modified") == info.get("last_modified")
    )


# --------------------------------------------------------------------------- parsing helpers

_TIME_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$"
)


def parse_time(value) -> int:
    """Spansh/EDDN timestamps -> unix seconds (0 if unknown)."""
    if not value:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    m = _TIME_RE.match(str(value).strip())
    if not m:
        return 0
    y, mo, d, h, mi, s, tz = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), tzinfo=timezone.utc)
    except ValueError:
        return 0
    if tz and tz != "Z":
        sign = 1 if tz[0] == "+" else -1
        digits = tz[1:].replace(":", "")
        off = timedelta(hours=int(digits[:2]), minutes=int(digits[2:4] or 0))
        dt -= sign * off
    return int(dt.timestamp())


def pad_size_from_station(raw: dict) -> str:
    """Largest pad the station offers: L / M / S."""
    lp = raw.get("landingPads") or raw.get("landing_pads")
    if isinstance(lp, dict):
        if (lp.get("large") or 0) > 0:
            return "L"
        if (lp.get("medium") or 0) > 0:
            return "M"
        if (lp.get("small") or 0) > 0:
            return "S"
    size = raw.get("maxLandingPadSize") or raw.get("max_landing_pad_size")
    if size:
        s = str(size).upper()[:1]
        if s in ("L", "M", "S"):
            return s
    return "M"


def station_flags(raw: dict, name: str) -> int:
    st_type = str(raw.get("type") or "").lower()
    flags = 0
    if (
        "planetary" in st_type
        or "surface" in st_type
        or "settlement" in st_type
        or "odyssey" in st_type
        or raw.get("isPlanetary")
    ):
        flags |= FLAG_PLANETARY
    if "carrier" in st_type or re.fullmatch(r"[A-Z0-9]{3}-[A-Z0-9]{3}", name.strip().upper()):
        flags |= FLAG_CARRIER
    return flags


SALVAGE = {
    "ASSAULT PLANS", "MILITARY PLANS", "BLACK BOX", "TRADE DATA", "PROTOTYPE TECH",
    "RARE ARTWORK", "ANCIENT ARTEFACT", "AI RELICS", "OCCUPIED ESCAPE POD",
    "DAMAGED ESCAPE POD", "UNOCCUPIED ESCAPE POD", "WRECKAGE COMPONENTS",
    "PERSONAL EFFECTS", "HOSTAGES", "POLITICAL PRISONER", "SAP 8 CORE CONTAINER",
}


def is_salvage(upper_name: str) -> bool:
    return (
        upper_name in SALVAGE
        or "THARGOID" in upper_name
        or "GUARDIAN " in upper_name
        or "ESCAPE POD" in upper_name
    )


def extract_market(raw: dict, commodity_ids: dict):
    """Return (flat_rows, updated_ts) or None. Prices without stock/demand are zeroed."""
    market = raw.get("market")
    commodities = None
    updated = 0
    prohibited = set()
    if isinstance(market, dict):
        commodities = market.get("commodities")
        updated = parse_time(market.get("updateTime") or market.get("updated"))
        prohibited = {str(p).strip().upper() for p in (market.get("prohibitedCommodities") or [])}
    elif isinstance(raw.get("commodities"), list):
        commodities = raw.get("commodities")
    if not commodities:
        return None
    if not updated:
        updated = parse_time(raw.get("updateTime") or raw.get("updated"))

    flat = array("i")
    for c in commodities:
        name = c.get("name") or c.get("symbol")
        if not name:
            continue
        upper = str(name).strip().upper()
        if is_salvage(upper):
            continue
        buy = int(c.get("buyPrice") or c.get("buy_price") or 0)
        sell = int(c.get("sellPrice") or c.get("sell_price") or 0)
        supply = min(int(c.get("supply") or 0), INT32_MAX)
        demand = min(int(c.get("demand") or 0), INT32_MAX)
        buy, sell = min(buy, INT32_MAX), min(sell, INT32_MAX)
        if buy > 0 and supply <= 0:
            buy = 0
        if sell > 0 and demand <= 0:
            sell = 0
        if upper in prohibited:
            sell = 0  # illegal here: cannot be sold at this station
        if buy <= 0 and sell <= 0:
            continue
        cid = commodity_ids.get(upper)
        if cid is None:
            cid = len(commodity_ids)
            commodity_ids[upper] = cid
        flat.extend((cid, buy, sell, supply, demand))
    if not flat:
        return None
    return flat, updated


def iter_station_records(obj):
    """Yield (system_name, coords, raw_station) from one top-level item of the dump."""
    if "stations" in obj or "bodies" in obj:
        sys_name = obj.get("name")
        coords = obj.get("coords") or {}
        raw_stations = list(obj.get("stations") or [])
        for body in obj.get("bodies") or []:
            raw_stations.extend(body.get("stations") or [])
    else:
        system = obj.get("system")
        sys_name = system.get("name") if isinstance(system, dict) else obj.get("systemName")
        coords = (system.get("coords") if isinstance(system, dict) else None) or obj.get("systemCoords") or {}
        raw_stations = [obj]
    for st in raw_stations:
        yield sys_name, coords, st


# --------------------------------------------------------------------------- price sanity

SENTINEL = 2_000_000_000   # supply/demand at (or near) INT32_MAX is a placeholder, not real stock
MIN_SAMPLES = 8            # need this many markets before a "typical" price means anything
HIGH_FACTOR = env_float("TD_OUTLIER_HIGH", 3.0)  # prices above median * 3 are treated as bad data (0 = off)
LOW_FACTOR = env_float("TD_OUTLIER_LOW", 4.0)    # ... and below median / 4 (0 = off)


def sanitize_prices(stations: dict, factor_hi: float = HIGH_FACTOR, factor_lo: float = LOW_FACTOR) -> dict:
    """Zero out prices that are wildly off the commodity's typical price.

    A route search that maximises total credits will find any typo'd or stale outlier price
    and plan its whole run around it, so we drop those prices (and placeholder stock values)
    before publishing. Stations left with no usable commodity are removed.
    """
    buys: dict = {}
    sells: dict = {}
    for rec in stations.values():
        flat = rec[4]
        for i in range(0, len(flat), 5):
            cid, b, s = flat[i], flat[i + 1], flat[i + 2]
            if b > 0:
                buys.setdefault(cid, []).append(b)
            if s > 0:
                sells.setdefault(cid, []).append(s)
    med_buy = {c: statistics.median(v) for c, v in buys.items() if len(v) >= MIN_SAMPLES}
    med_sell = {c: statistics.median(v) for c, v in sells.items() if len(v) >= MIN_SAMPLES}

    def bad(value: int, median) -> bool:
        if median is None:
            return False
        return bool((factor_hi and value > median * factor_hi) or (factor_lo and value < median / factor_lo))

    dropped = 0
    for key in list(stations):
        rec = stations[key]
        flat = rec[4]
        out = []
        for i in range(0, len(flat), 5):
            cid, b, s, sup, dem = flat[i:i + 5]
            if b > 0 and (sup >= SENTINEL or bad(b, med_buy.get(cid))):
                b = 0
                dropped += 1
            if s > 0 and (dem >= SENTINEL or bad(s, med_sell.get(cid))):
                s = 0
                dropped += 1
            if b > 0 or s > 0:
                out.extend((cid, b, s, sup, dem))
        if out:
            rec[4] = array("i", out)
        else:
            del stations[key]
    return {"prices_dropped": dropped, "stations_left": len(stations)}


# --------------------------------------------------------------------------- build

def build(source: str, out_path: str, max_stations: int, max_age_days: float, carrier_max_age_days: float,
          max_ly: float, tile_stations: int, source_info: dict | None = None):
    if ijson is None:
        raise SystemExit("ijson is required: pip install ijson")

    now = int(time.time())
    min_updated = now - int(max_age_days * 86400) if max_age_days and max_age_days > 0 else 0
    carrier_min = now - int(carrier_max_age_days * 86400) if carrier_max_age_days and carrier_max_age_days > 0 else 0
    commodity_ids: dict = {}
    kept: list = []   # (updated, seq, key, sys_key, coords, record); a min-heap when max_stations > 0
    seq = 0
    scanned = skipped_old = skipped_empty = 0
    t0 = time.time()
    log(f"Scanning dump (max_stations={max_stations or 'all'}, max_age_days={max_age_days or 'any'}, "
        f"carrier_max_age_days={carrier_max_age_days or 'any'}, max_ly={max_ly or 'any'})...")

    with open_source(source) as fh:
        for obj in ijson.items(fh, "item", use_float=True):
            for sys_name, coords, st in iter_station_records(obj):
                if not sys_name or not isinstance(coords, dict) or "x" not in coords:
                    continue
                st_name = st.get("name")
                if not st_name:
                    continue
                try:
                    x, y, z = float(coords["x"]), float(coords["y"]), float(coords["z"])
                except (TypeError, ValueError, KeyError):
                    continue
                if max_ly > 0 and math.sqrt(x * x + y * y + z * z) > max_ly:
                    continue
                scanned += 1
                if scanned % 50000 == 0:
                    log(f"  ...{scanned} stations scanned, {len(kept)} kept ({time.time() - t0:.0f}s)")

                res = extract_market(st, commodity_ids)
                if not res:
                    skipped_empty += 1
                    continue
                flat, updated = res
                name = str(st_name).strip()
                flags = station_flags(st, name)
                if min_updated and (not updated or updated < min_updated):
                    skipped_old += 1
                    continue
                if (flags & FLAG_CARRIER) and carrier_min and (not updated or updated < carrier_min):
                    skipped_old += 1
                    continue

                key = f"{str(sys_name).strip().upper()}/{name.upper()}"
                record = [
                    pad_size_from_station(st),
                    int(st.get("distanceToArrival") or st.get("distance_to_arrival") or 0),
                    flags,
                    updated,
                    flat,
                ]
                coords_out = [round(x, 2), round(y, 2), round(z, 2)]
                seq += 1
                item = (updated, seq, key, str(sys_name).strip().upper(), coords_out, record)
                if max_stations:
                    if len(kept) >= max_stations:
                        if updated <= kept[0][0]:
                            continue
                        heapq.heapreplace(kept, item)
                    else:
                        heapq.heappush(kept, item)
                else:
                    kept.append(item)

    log(f"Scanned {scanned} stations: kept {len(kept)}, no market {skipped_empty}, too old {skipped_old} "
        f"({time.time() - t0:.0f}s)")
    if not kept:
        raise SystemExit("No stations passed the filters - refusing to write an empty dataset.")

    stations: dict = {}
    systems: dict = {}
    sys_of: dict = {}
    for updated, _seq, key, sys_key, coords, record in sorted(kept, key=lambda i: (i[2], i[0])):
        stations[key] = record  # later (fresher) duplicate keys win
        systems[sys_key] = coords
        sys_of[key] = sys_key
    del kept

    report = sanitize_prices(stations)
    log(f"Price sanity: dropped {report['prices_dropped']} outlier prices; {report['stations_left']} stations left")
    used = {sys_of[k] for k in stations}
    systems = {name: c for name, c in systems.items() if name in used}
    commodities = [name for name, _ in sorted(commodity_ids.items(), key=lambda kv: kv[1])]

    write_tiled(systems, stations, sys_of, commodities, out_path, tile_stations, source_info or {},
                {"max_stations": max_stations, "max_age_days": max_age_days,
                 "carrier_max_age_days": carrier_max_age_days, "max_ly": max_ly})


def kd_split(items: list, max_count: int) -> list:
    """Split [(system, coords, n_stations)] into spatially compact groups of ~max_count stations."""
    out, stack = [], [items]
    while stack:
        grp = stack.pop()
        total = sum(i[2] for i in grp)
        if total <= max_count or len(grp) <= 1:
            out.append(grp)
            continue
        extents = [(max(i[1][a] for i in grp) - min(i[1][a] for i in grp), a) for a in range(3)]
        axis = max(extents)[1]
        grp.sort(key=lambda i: i[1][axis])
        half, acc, cut = total / 2, 0, 1
        for n, i in enumerate(grp):
            acc += i[2]
            if acc >= half:
                cut = n + 1
                break
        cut = min(max(cut, 1), len(grp) - 1)
        stack.append(grp[cut:])
        stack.append(grp[:cut])
    return out


def write_tiled(systems: dict, stations: dict, sys_of: dict, commodities: list, out_path: str,
                tile_stations: int, source_info: dict, filters: dict | None = None,
                source_label: str = "Spansh galaxy_stations dump"):
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    by_sys: dict = {}
    for key in stations:
        by_sys.setdefault(sys_of[key], []).append(key)
    groups = kd_split([(n, systems[n], len(ks)) for n, ks in by_sys.items()], max(1, tile_stations))

    old = set()
    for pattern in ("trade-tile-*.json", "trade-index-*.json", "trade-data-*.json"):
        old.update(out.parent.glob(pattern))

    tiles_meta = []
    index_systems: dict = {}
    for idx, group in enumerate(groups):
        pieces = []
        for name, coords, _n in group:
            entries = []
            for key in sorted(by_sys[name]):
                rec = stations[key]
                body = [rec[0], rec[1], rec[2], rec[3], rec[4].tolist() if isinstance(rec[4], array) else rec[4]]
                pieces.append(json.dumps(key, ensure_ascii=False) + ":" + json.dumps(body, separators=(",", ":"), ensure_ascii=False))
                entries.append([key[len(name) + 1:], rec[0], rec[2], rec[3], idx])
            index_systems[name] = [coords[0], coords[1], coords[2], entries]
        data = ('{"stations":{' + ",".join(pieces) + "}}").encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            raise SystemExit(f"tile {idx + 1} is {len(data) / 1e6:.0f} MB; lower TD_TILE_STATIONS")
        fname = f"trade-tile-{idx + 1}-{hashlib.sha1(data).hexdigest()[:8]}.json"
        (out.parent / fname).write_bytes(data)
        old.discard(out.parent / fname)
        xs = [g[1][0] for g in group]; ys = [g[1][1] for g in group]; zs = [g[1][2] for g in group]
        tiles_meta.append({"file": fname, "bytes": len(data), "count": len(pieces),
                           "bbox": [min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)]})

    index_data = json.dumps({"systems": dict(sorted(index_systems.items()))},
                            separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(index_data) > MAX_FILE_BYTES:
        raise SystemExit("station index too large")
    index_name = f"trade-index-{hashlib.sha1(index_data).hexdigest()[:8]}.json"
    (out.parent / index_name).write_bytes(index_data)
    old.discard(out.parent / index_name)

    meta = {
        "version": FORMAT_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source_label,
        "source_etag": source_info.get("etag"),
        "source_last_modified": source_info.get("last_modified"),
        "filters": filters or {},
        "has_ages": any(rec[3] for rec in stations.values()),
        "station_count": len(stations),
        "system_count": len(systems),
        "commodities": commodities,
        "index": {"file": index_name, "bytes": len(index_data)},
        "tiles": tiles_meta,
    }
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, out)
    for stale in old:
        stale.unlink(missing_ok=True)
    total = sum(t["bytes"] for t in tiles_meta) + len(index_data)
    log(f"Wrote {out}: {len(stations)} stations, {len(systems)} systems, {len(tiles_meta)} tiles, "
        f"index {len(index_data) / 1e6:.1f} MB, total {total / 1e6:.0f} MB")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="trade-data.json", help="meta file to write; index and tiles go next to it")
    ap.add_argument("--source", default=DEFAULT_SOURCE_URL, help="dump URL or local path")
    ap.add_argument("--max-stations", type=int, default=env_int("TD_MAX_STATIONS", 0))
    ap.add_argument("--max-age-days", type=float, default=env_float("TD_MAX_AGE_DAYS", 0))
    ap.add_argument("--carrier-max-age-days", type=float, default=env_float("TD_CARRIER_MAX_AGE_DAYS", 14))
    ap.add_argument("--max-ly", type=float, default=env_float("TD_MAX_LY", 0))
    ap.add_argument("--tile-stations", type=int, default=env_int("TD_TILE_STATIONS", 2500))
    ap.add_argument("--previous", default=None, help="previously published trade-data.json; skip the build if upstream is unchanged")
    ap.add_argument("--force", action="store_true", help="build even if upstream looks unchanged")
    args = ap.parse_args(argv)

    info = head_info(args.source)
    if args.previous and not args.force and unchanged_since(Path(args.previous), info):
        log("Upstream dump unchanged since the last build - nothing to do.")
        return 0

    build(args.source, args.out, args.max_stations, args.max_age_days, args.carrier_max_age_days,
          args.max_ly, args.tile_stations, info)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Rebuild data/trade-data.json from public Elite: Dangerous data sources.

Supported sources (pick with --source or TD_SOURCE env):
  spansh     – Spansh galaxy_stations dump (default; comprehensive)
  eddblink   – Tromador / EDDBlink CSV dumps (Trade Dangerous preferred path;
               smaller and usually fresher live prices)
  sample     – leave the checked-in demo data alone (no download)

Inara does not publish a bulk market dump or open bulk API suitable for
this use case (only a rate-limited CMDR-profile API). The web UI links
individual stations to Inara for live checks instead.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/build_data.py --out data/trade-data.json
    python scripts/build_data.py --source eddblink --out data/trade-data.json
    python scripts/build_data.py --source spansh --max-stations 15000

Env vars:
    TD_SOURCE           spansh | eddblink | sample
    TD_SOURCE_URL       override dump URL (spansh only)
    TD_MAX_STATIONS     cap station count (0 = no cap)
    TD_EDDBLINK_BASE    override Tromador base URL
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import ijson
except ImportError:
    ijson = None

try:
    import requests
except ImportError:
    requests = None

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_SPANSH_URL = os.environ.get(
    "TD_SOURCE_URL",
    "https://downloads.spansh.co.uk/galaxy_stations.json.gz",
)

EDDBLINK_BASE = os.environ.get(
    "TD_EDDBLINK_BASE",
    "https://elite.tromador.com/files/",
).rstrip("/") + "/"

MAX_STATIONS = int(os.environ.get("TD_MAX_STATIONS", "0")) or None
MAX_LY = float(os.environ.get("TD_MAX_LY", "800"))  # only keep systems within this of Sol

# Salvage / non-market cargo (found in space or mission rewards — not station market trade)
SALVAGE_NAMES = {
    "AI RELICS", "ANCIENT ARTEFACT", "ANCIENT KEY", "ANOMALY PARTICLES",
    "ANTIMATTER CONTAINMENT UNIT", "ANTIQUE JEWELLERY", "ANTIQUITIES",
    "ASSAULT PLANS", "BLACK BOX", "BONE FRAGMENTS", "CAUSTIC TISSUE SAMPLE",
    "COMMERCIAL SAMPLES", "CORAL SAP", "CYST SPECIMEN", "DAMAGED ESCAPE POD",
    "ENCRYPTED DATA STORAGE", "EXPERIMENTAL CHEMICALS", "FOSSIL REMNANTS",
    "GENE SEQUENCE", "GEOLOGICAL SAMPLES", "GUARDIAN CASKET", "GUARDIAN ORB",
    "GUARDIAN RELIC", "GUARDIAN TABLET", "GUARDIAN TOTEM", "GUARDIAN URN",
    "HOSTAGE", "HOSTAGES", "IMPERIAL SLAVES", "MILITARY PLANS",
    "MYSTERIOUS IDOL", "OCCUPIED ESCAPE POD", "PERSONAL EFFECTS",
    "POLITICAL PRISONER", "POLITICAL PRISONERS", "PROHIBITED RESEARCH MATERIALS",
    "PROTOTYPE TECH", "RARE ARTWORK", "REBEL TRANSMISSIONS",
    "SAP 8 CORE CONTAINER", "SCIENTIFIC SAMPLES", "SPACE PIONEER RELICS",
    "TACTICAL PLANS", "THARGOID BASILISK TISSUE SAMPLE",
    "THARGOID BIOLOGICAL MATTER", "THARGOID CYCLOPS TISSUE SAMPLE",
    "THARGOID HEART", "THARGOID HYDRA TISSUE SAMPLE", "THARGOID LINK",
    "THARGOID MEDUSA TISSUE SAMPLE", "THARGOID PROBE", "THARGOID RESIN",
    "THARGOID SENSOR", "THARGOID TISSUE SAMPLE DATA",
    "TIME CAPSULE", "TRADE DATA", "UNOCCUPIED ESCAPE POD",
    "UNSTABLE DATA CORE", "WRECKAGE COMPONENTS",
}

def is_station_market_commodity(name: str, buy: int, sell: int, supply: int, demand: int) -> bool:
    """Keep only normal station-market trade goods."""
    u = (name or "").strip().upper()
    if not u:
        return False
    if u in SALVAGE_NAMES:
        return False
    if any(x in u for x in ("THARGOID", "GUARDIAN ", "ESCAPE POD", "TISSUE SAMPLE")):
        return False
    # Must have a real market side: buy+supply or sell+demand
    can_buy = buy > 0 and supply > 0
    can_sell = sell > 0 and demand > 0
    return can_buy or can_sell



def log(*a):
    print(*a, file=sys.stderr, flush=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Spansh path
# ---------------------------------------------------------------------------

def open_spansh(url: str):
    log(f"Downloading Spansh dump: {url}")
    req = urllib.request.Request(
        url, headers={"User-Agent": "trade-dangerous-web/2.0"}
    )
    resp = urllib.request.urlopen(req, timeout=300)
    if url.endswith(".gz"):
        return gzip.GzipFile(fileobj=resp)
    return resp


def pad_size_from_station(raw: dict) -> str:
    lp = raw.get("landingPads") or raw.get("landing_pads")
    if isinstance(lp, dict):
        if (lp.get("large") or 0) > 0:
            return "L"
        if (lp.get("medium") or 0) > 0:
            return "M"
    size = raw.get("maxLandingPadSize") or raw.get("max_landing_pad_size")
    if size:
        return "L" if str(size).upper().startswith("L") else "M"
    return "M"


def extract_market_spansh(raw: dict):
    market = raw.get("market")
    commodities = None
    if isinstance(market, dict):
        commodities = market.get("commodities")
    elif isinstance(raw.get("commodities"), list):
        commodities = raw.get("commodities")
    if not commodities:
        return None
    out = {}
    for c in commodities:
        name = c.get("name") or c.get("symbol")
        if not name:
            continue
        buy = int(c.get("buyPrice") or c.get("buy_price") or 0)
        sell = int(c.get("sellPrice") or c.get("sell_price") or 0)
        supply = int(c.get("supply") or 0)
        demand = int(c.get("demand") or 0)
        if not is_station_market_commodity(name, buy, sell, supply, demand):
            continue
        out[name.strip().upper()] = {
            "buy": buy,
            "sell": sell,
            "supply": supply,
            "demand": demand,
        }
    return out or None


def build_from_spansh_api(max_stations):
    """Fast path: Spansh stations/search API by distance rings from Sol (no multi-GB dump)."""
    max_ly = float(os.environ.get("TD_MAX_LY", "800"))
    api = "https://spansh.co.uk/api/stations/search"
    systems: dict = {}
    stations: dict = {}
    t0 = time.time()
    log(f"Spansh API: fetching market stations within {max_ly} ly of Sol…")

    def post(filters, page=0, size=100):
        body = json.dumps({
            "filters": filters,
            "sort": [{"distance": {"direction": "asc"}}],
            "size": size,
            "page": page,
        }).encode()
        req = urllib.request.Request(
            api,
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "trade-dangerous-web/2.3",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode())

    def ingest(results):
        n = 0
        for r in results:
            name = (r.get("name") or "").strip()
            sys_name = (r.get("system_name") or "").strip()
            if not name or not sys_name:
                continue
            market_raw = r.get("market") or []
            if not market_raw:
                continue
            mkt = {}
            for c in market_raw:
                cname = (c.get("commodity") or c.get("name") or "").strip()
                if not cname:
                    continue
                buy = int(c.get("buy_price") or c.get("buyPrice") or 0)
                sell = int(c.get("sell_price") or c.get("sellPrice") or 0)
                supply = int(c.get("supply") or 0)
                demand = int(c.get("demand") or 0)
                if not is_station_market_commodity(cname, buy, sell, supply, demand):
                    continue
                mkt[cname.upper()] = {
                    "buy": buy, "sell": sell, "supply": supply, "demand": demand,
                }
            if not mkt:
                continue
            x, y, z = r.get("system_x"), r.get("system_y"), r.get("system_z")
            if x is None:
                continue
            sys_key = sys_name.upper()
            st_key = f"{sys_key}/{name.upper()}"
            systems[sys_key] = {
                "x": round(float(x), 2),
                "y": round(float(y), 2),
                "z": round(float(z), 2),
            }
            pad = "L" if r.get("has_large_pad") or (r.get("large_pads") or 0) > 0 else "M"
            stations[st_key] = {
                "system": sys_key,
                "pad": pad,
                "distLs": int(r.get("distance_to_arrival") or 0),
                "planetary": bool(r.get("is_planetary")),
                "market": mkt,
            }
            n += 1
        return n

    # Named anchors so Herbert Dock / popular hubs always appear
    for q in ("Herbert Dock", "Jameson Memorial", "Abraham Lincoln", "Lave Station"):
        try:
            data = post({"name": {"value": q}, "has_market": {"value": True}}, size=20)
            ingest(data.get("results") or [])
        except Exception as e:
            log(f"  anchor {q}: {e}")
        time.sleep(0.15)

    # Distance rings from Sol (API sorts by distance)
    rings = []
    step = 100
    lo = 0.0
    while lo < max_ly:
        hi = min(lo + step, max_ly)
        rings.append((lo, hi))
        lo = hi

    for lo, hi in rings:
        if max_stations and len(stations) >= max_stations:
            break
        for page in range(40):
            if max_stations and len(stations) >= max_stations:
                break
            try:
                data = post({
                    "has_market": {"value": True},
                    "distance": {"min": str(int(lo)), "max": str(int(hi))},
                }, page=page, size=100)
            except Exception as e:
                log(f"  ring {lo}-{hi} p{page}: {e}")
                time.sleep(2)
                continue
            results = data.get("results") or []
            if not results:
                break
            ingest(results)
            if page % 5 == 0:
                log(f"  ring {lo:.0f}-{hi:.0f} ly p{page}: {len(stations)} stations ({time.time() - t0:.0f}s)")
            time.sleep(0.12)

    if max_stations and len(stations) > max_stations:
        # Keep closest to Sol
        ranked = sorted(
            stations.items(),
            key=lambda kv: (
                systems[kv[1]["system"]]["x"] ** 2
                + systems[kv[1]["system"]]["y"] ** 2
                + systems[kv[1]["system"]]["z"] ** 2
            ),
        )[:max_stations]
        stations = dict(ranked)
        used = {v["system"] for v in stations.values()}
        systems = {k: v for k, v in systems.items() if k in used}

    log(
        f"Spansh API: kept {len(stations)} stations in {len(systems)} systems "
        f"({time.time() - t0:.0f}s, max_ly={max_ly})."
    )
    return systems, stations, "spansh-api"


def build_from_spansh_dump(url: str, max_stations):
    """Slow path: full galaxy_stations.json.gz dump (multi-GB download)."""
    if ijson is None:
        raise SystemExit("ijson is required for Spansh dump mode: pip install ijson")

    max_ly = float(os.environ.get("TD_MAX_LY", "800"))
    candidates = []
    skipped = 0
    seen = 0
    t0 = time.time()
    log(f"Spansh dump: downloading/scanning (within {max_ly} ly of Sol)…")

    with open_spansh(url) as fh:
        for obj in ijson.items(fh, "item"):
            if "stations" in obj or "bodies" in obj:
                sys_name = obj.get("name")
                coords = obj.get("coords") or {}
                raw_stations = list(obj.get("stations") or [])
                for body in obj.get("bodies") or []:
                    raw_stations.extend(body.get("stations") or [])
            else:
                sys_name = (
                    (obj.get("system") or {}).get("name")
                    if isinstance(obj.get("system"), dict)
                    else obj.get("systemName")
                )
                coords = (
                    (obj.get("system") or {}).get("coords")
                    or obj.get("systemCoords")
                    or {}
                )
                raw_stations = [obj]

            if not sys_name or "x" not in (coords or {}):
                continue
            try:
                x, y, z = float(coords["x"]), float(coords["y"]), float(coords["z"])
            except (TypeError, ValueError, KeyError):
                continue
            dist_sol = math.sqrt(x * x + y * y + z * z)
            if max_ly > 0 and dist_sol > max_ly:
                continue

            sys_key = sys_name.strip().upper()
            sys_coords = {"x": round(x, 2), "y": round(y, 2), "z": round(z, 2)}

            for st in raw_stations:
                st_name = st.get("name")
                if not st_name:
                    continue
                mkt = extract_market_spansh(st)
                if not mkt:
                    skipped += 1
                    continue
                st_type = (st.get("type") or "").lower()
                key = f"{sys_key}/{st_name.strip().upper()}"
                entry = {
                    "system": sys_key,
                    "pad": pad_size_from_station(st),
                    "distLs": int(
                        st.get("distanceToArrival")
                        or st.get("distance_to_arrival")
                        or 0
                    ),
                    "planetary": bool(
                        "surface" in st_type
                        or "planetary" in st_type
                        or st.get("isPlanetary")
                    ),
                    "market": mkt,
                }
                candidates.append((dist_sol, key, sys_key, sys_coords, entry))
                seen += 1
                if seen % 10000 == 0:
                    log(f"  …scanned {seen} ({time.time() - t0:.0f}s)")

    candidates.sort(key=lambda c: (c[0], c[1]))
    if max_stations and len(candidates) > max_stations:
        candidates = candidates[:max_stations]

    systems: dict = {}
    stations: dict = {}
    for dist_sol, key, sys_key, sys_coords, entry in candidates:
        systems[sys_key] = sys_coords
        stations[key] = entry

    log(
        f"Spansh dump: kept {len(stations)} stations in {len(systems)} systems "
        f"(scanned {seen}, skipped {skipped}, {time.time() - t0:.0f}s)."
    )
    return systems, stations, url


def build_from_spansh(url: str, max_stations):
    """Default: fast API. Set TD_SPANSH_MODE=dump for the full multi-GB dump."""
    mode = (os.environ.get("TD_SPANSH_MODE") or "api").strip().lower()
    if mode in ("dump", "full", "gz"):
        return build_from_spansh_dump(url, max_stations)
    return build_from_spansh_api(max_stations)




def download_text(url: str, timeout: int = 300) -> str:
    """Download a text file (CSV/JSONL) from a URL."""
    log(f"  downloading {url}")
    headers = {"User-Agent": "trade-dangerous-web/2.2"}
    if requests is not None:
        r = requests.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        r.encoding = r.apparent_encoding or "utf-8"
        return r.text
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return raw.decode("utf-8", errors="replace")


def download_bytes(url: str, timeout: int = 300) -> bytes:
    headers = {"User-Agent": "trade-dangerous-web/2.2"}
    if requests is not None:
        r = requests.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.content
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def build_from_eddblink(max_stations):
    """
    Build from Tromador EDDBlink files:
      System.csv, Station.csv, listings.csv / listings-live.csv, Item.csv
    https://elite.tromador.com/files/
    """
    base = EDDBLINK_BASE
    max_ly = float(os.environ.get("TD_MAX_LY", "800"))

    # --- systems: id -> name/coords ---
    systems: dict = {}
    system_by_id: dict = {}
    text = download_text(base + "System.csv")
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        n = (row.get("name") or "").strip().strip("'")
        if not n or n.startswith("$"):
            continue
        try:
            x = float(row.get("pos_x") or row.get("x") or 0)
            y = float(row.get("pos_y") or row.get("y") or 0)
            z = float(row.get("pos_z") or row.get("z") or 0)
        except ValueError:
            continue
        dist = (x * x + y * y + z * z) ** 0.5
        if max_ly > 0 and dist > max_ly:
            continue
        sid = (row.get("unq:system_id") or row.get("system_id") or row.get("id") or "").strip()
        key = n.upper()
        systems[key] = {"x": round(x, 2), "y": round(y, 2), "z": round(z, 2)}
        if sid:
            system_by_id[sid] = key
    log(f"  systems within {max_ly} ly: {len(systems)}")

    if not systems:
        raise SystemExit("Could not load systems from EDDBlink System.csv")

    # --- commodities: id -> name ---
    item_by_id: dict = {}
    try:
        text = download_text(base + "Item.csv")
        for row in csv.DictReader(io.StringIO(text)):
            iid = (row.get("unq:item_id") or row.get("item_id") or row.get("id") or "").strip()
            name = (row.get("name") or "").strip().strip("'")
            if iid and name:
                item_by_id[iid] = name.upper()
        log(f"  commodities: {len(item_by_id)}")
    except Exception as e:
        log(f"  warn Item.csv: {e}")

    # --- stations ---
    stations: dict = {}
    id_to_key: dict = {}
    text = download_text(base + "Station.csv")
    # Station.csv is large (~100MB); stream by lines after header
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        st_name = (row.get("name") or "").strip().strip("'")
        if not st_name or st_name.startswith("$"):
            continue
        # market flag: Y/N
        has_market = str(row.get("market") or "").strip().strip("'").upper()
        if has_market and has_market not in ("Y", "1", "TRUE", "T"):
            continue
        sys_id = (
            row.get("system_id@System.system_id")
            or row.get("system_id")
            or ""
        ).strip()
        sys_key = system_by_id.get(sys_id)
        if not sys_key:
            continue
        key = f"{sys_key}/{st_name.upper()}"
        pad_raw = (row.get("max_pad_size") or row.get("max_landing_pad_size") or "M").strip().strip("'")
        pad = "L" if str(pad_raw).upper().startswith("L") else "M"
        try:
            dist_ls = int(float(row.get("ls_from_star") or row.get("distance_to_star") or 0))
        except ValueError:
            dist_ls = 0
        planetary = str(row.get("planetary") or "").strip().strip("'").upper() in ("Y", "1", "TRUE")
        stations[key] = {
            "system": sys_key,
            "pad": pad,
            "distLs": dist_ls,
            "planetary": planetary,
            "market": {},
        }
        sid = (row.get("unq:station_id") or row.get("station_id") or row.get("id") or "").strip()
        if sid:
            id_to_key[sid] = key
    log(f"  stations with market flag: {len(stations)}")

    # --- listings (prefer live, then full) ---
    listings_loaded = False
    for name in ("listings-live.csv", "listings.csv"):
        try:
            text = download_text(base + name)
        except Exception as e:
            log(f"  skip {name}: {e}")
            continue
        reader = csv.DictReader(io.StringIO(text))
        n_rows = 0
        for row in reader:
            sid = (
                row.get("station_id")
                or row.get("market_id")
                or row.get("Station_id")
                or ""
            ).strip()
            key = id_to_key.get(str(sid))
            if not key or key not in stations:
                continue
            commodity = (
                row.get("commodity_name")
                or row.get("commodity")
                or row.get("name")
                or ""
            ).strip()
            if not commodity:
                iid = (row.get("commodity_id") or row.get("item_id") or "").strip()
                commodity = item_by_id.get(iid, "")
            if not commodity:
                continue
            try:
                buy = int(float(row.get("buy_price") or row.get("buy") or 0))
                sell = int(float(row.get("sell_price") or row.get("sell") or 0))
                supply = int(float(row.get("supply") or 0))
                demand = int(float(row.get("demand") or 0))
            except (ValueError, TypeError):
                continue
            if not is_station_market_commodity(commodity, buy, sell, supply, demand):
                continue
            stations[key]["market"][commodity.upper()] = {
                "buy": buy,
                "sell": sell,
                "supply": supply,
                "demand": demand,
            }
            n_rows += 1
        log(f"  listings from {name}: {n_rows} price rows")
        listings_loaded = n_rows > 0
        if listings_loaded:
            break

    if not listings_loaded:
        log("WARNING: no listings loaded – markets will be empty")

    before = len(stations)
    stations = {k: v for k, v in stations.items() if v.get("market")}
    log(f"  stations with prices: {len(stations)} (dropped {before - len(stations)} empty)")

    used = {v["system"] for v in stations.values()}
    systems = {k: v for k, v in systems.items() if k in used}

    if max_stations and len(stations) > max_stations:
        ranked = sorted(
            stations.items(),
            key=lambda kv: (
                systems[kv[1]["system"]]["x"] ** 2
                + systems[kv[1]["system"]]["y"] ** 2
                + systems[kv[1]["system"]]["z"] ** 2
            ),
        )[:max_stations]
        stations = dict(ranked)
        used = {v["system"] for v in stations.values()}
        systems = {k: v for k, v in systems.items() if k in used}

    log(f"EDDBlink: kept {len(stations)} stations in {len(systems)} systems")
    return systems, stations, base




def merge_anchor_stations(systems: dict, stations: dict) -> None:
    """Ensure key bubble stations (e.g. Herbert Dock) are present via Spansh API."""
    anchors = ["Herbert Dock", "Jameson Memorial", "Abraham Lincoln", "Hutton Orbital"]
    url = "https://spansh.co.uk/api/stations/search"
    for q in anchors:
        try:
            body = json.dumps({
                "filters": {"name": {"value": q}},
                "size": 10,
                "page": 0,
            }).encode()
            req = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json", "User-Agent": "trade-dangerous-web/2.2"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                results = json.loads(resp.read().decode()).get("results") or []
        except Exception as e:
            log(f"  anchor {q}: {e}")
            continue
        for r in results:
            name = (r.get("name") or "").strip()
            sys_name = (r.get("system_name") or "").strip()
            if not name or not sys_name:
                continue
            if name.upper() != q.upper() and q.upper() not in name.upper():
                continue
            mkt = {}
            for c in r.get("market") or []:
                cname = (c.get("commodity") or "").strip()
                if not cname:
                    continue
                buy = int(c.get("buy_price") or 0)
                sell = int(c.get("sell_price") or 0)
                supply = int(c.get("supply") or 0)
                demand = int(c.get("demand") or 0)
                if not is_station_market_commodity(cname, buy, sell, supply, demand):
                    continue
                mkt[cname.upper()] = {
                    "buy": buy, "sell": sell, "supply": supply, "demand": demand,
                }
            if not mkt:
                continue
            x, y, z = r.get("system_x"), r.get("system_y"), r.get("system_z")
            if x is None:
                continue
            sys_key = sys_name.upper()
            key = f"{sys_key}/{name.upper()}"
            systems[sys_key] = {
                "x": round(float(x), 2),
                "y": round(float(y), 2),
                "z": round(float(z), 2),
            }
            stations[key] = {
                "system": sys_key,
                "pad": "L" if r.get("has_large_pad") or (r.get("large_pads") or 0) > 0 else "M",
                "distLs": int(r.get("distance_to_arrival") or 0),
                "planetary": bool(r.get("is_planetary")),
                "market": mkt,
            }
            log(f"  anchor added {key} ({len(mkt)} commodities)")


def write_data(systems, stations, source_label, out_path: str, max_shard_bytes: int | None = None):
    if max_shard_bytes is None:
        max_shard_bytes = int(os.environ.get("TD_MAX_SHARD_BYTES", "40000000"))
    """Write trade data. If payload is large, emit sharded files under GitHub's 100MB limit."""
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    # Remove previous shards next to the meta file
    for old in out.parent.glob("trade-data-*.json"):
        old.unlink(missing_ok=True)

    # Estimate single-file size
    probe = json.dumps(
        {"generated_at": utc_now(), "source": source_label, "systems": systems, "stations": stations},
        separators=(",", ":"),
    )
    if len(probe) <= max_shard_bytes:
        out.write_text(probe, encoding="utf-8")
        log(f"Wrote {out} ({len(probe)/1e6:.1f} MB, {len(stations)} stations, {len(systems)} systems).")
        return

    # Shard stations
    items = list(stations.items())
    shards = []
    i = 0
    idx = 0
    while i < len(items):
        shard = {}
        size_est = 20
        while i < len(items):
            k, v = items[i]
            entry = json.dumps({k: v}, separators=(",", ":"))
            add = len(entry) + (1 if shard else 0)
            if size_est + add > max_shard_bytes and shard:
                break
            shard[k] = v
            size_est += add
            i += 1
        idx += 1
        fname = f"trade-data-{idx}.json"
        path = out.parent / fname
        path.write_text(json.dumps({"stations": shard}, separators=(",", ":")), encoding="utf-8")
        shards.append(fname)
        log(f"  shard {fname}: {len(shard)} stations, {path.stat().st_size/1e6:.1f} MB")

    meta = {
        "generated_at": utc_now(),
        "source": source_label,
        "systems": systems,
        "shards": shards,
        "station_count": len(stations),
        "system_count": len(systems),
    }
    out.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    log(f"Wrote meta {out} ({out.stat().st_size/1e6:.2f} MB) + {len(shards)} shards, {len(stations)} stations.")


def main():
    ap = argparse.ArgumentParser(description="Build trade-data.json for Trade Dangerous Web")
    ap.add_argument("--out", default="data/trade-data.json")
    ap.add_argument(
        "--source",
        choices=("spansh", "eddblink", "sample"),
        default=os.environ.get("TD_SOURCE", "spansh"),
    )
    ap.add_argument("--spansh-url", default=DEFAULT_SPANSH_URL)
    ap.add_argument("--max-stations", type=int, default=MAX_STATIONS)
    args = ap.parse_args()

    if args.source == "sample":
        log("Source=sample – leaving existing data file untouched.")
        if not Path(args.out).exists():
            raise SystemExit(f"No sample file at {args.out}")
        return

    if args.source == "spansh":
        systems, stations, label = build_from_spansh(args.spansh_url, args.max_stations)
    else:
        systems, stations, label = build_from_eddblink(args.max_stations)

    log("Merging anchor stations (Herbert Dock, etc.)…")
    merge_anchor_stations(systems, stations)
    write_data(systems, stations, label, args.out)


if __name__ == "__main__":
    main()

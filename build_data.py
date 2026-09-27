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


def build_from_spansh(url: str, max_stations):
    if ijson is None:
        raise SystemExit("ijson is required for Spansh source: pip install ijson")

    systems: dict = {}
    stations: dict = {}
    count = 0
    skipped = 0
    t0 = time.time()

    with open_spansh(url) as fh:
        for obj in ijson.items(fh, "item"):
            if max_stations and count >= max_stations:
                break

            if "stations" in obj or "bodies" in obj:
                sys_name = obj.get("name")
                coords = obj.get("coords") or {}
                raw_stations = list(obj.get("stations") or [])
                # also surface stations on bodies
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
            sys_key = sys_name.strip().upper()

            for st in raw_stations:
                if max_stations and count >= max_stations:
                    break
                st_name = st.get("name")
                if not st_name:
                    continue
                mkt = extract_market_spansh(st)
                if not mkt:
                    skipped += 1
                    continue

                systems[sys_key] = {
                    "x": round(float(coords["x"]), 2),
                    "y": round(float(coords["y"]), 2),
                    "z": round(float(coords["z"]), 2),
                }
                key = f"{sys_key}/{st_name.strip().upper()}"
                st_type = (st.get("type") or "").lower()
                stations[key] = {
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
                count += 1
                if count % 5000 == 0:
                    log(f"  …{count} stations ({time.time() - t0:.0f}s)")

    log(f"Spansh: kept {count} stations ({skipped} skipped, no market).")
    return systems, stations, url


# ---------------------------------------------------------------------------
# EDDBlink / Tromador path (CSV)
# ---------------------------------------------------------------------------

def download_text(url: str) -> str:
    log(f"Downloading {url}")
    if requests:
        r = requests.get(url, timeout=180, headers={"User-Agent": "trade-dangerous-web/2.0"})
        r.raise_for_status()
        return r.text
    req = urllib.request.Request(url, headers={"User-Agent": "trade-dangerous-web/2.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read().decode("utf-8", errors="replace")


def build_from_eddblink(max_stations):
    """
    Build from Tromador's EDDB-style dumps:
      systems_populated.jsonl  (or systems.csv)
      stations.jsonl           (or stations.csv)
      listings.csv             (commodity prices)
    Falls back across common filenames.
    """
    base = EDDBLINK_BASE
    systems: dict = {}
    stations: dict = {}
    # station_id -> key for joining listings
    id_to_key: dict = {}

    # --- systems ---
    sys_loaded = False
    for name in (
        "systems_populated.jsonl",
        "systems.jsonl",
        "System.csv",
        "systems.csv",
    ):
        try:
            text = download_text(base + name)
        except Exception as e:
            log(f"  skip {name}: {e}")
            continue
        if name.endswith(".jsonl"):
            for line in text.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                n = (obj.get("name") or "").strip()
                if not n:
                    continue
                coords = obj.get("coords") or {}
                x = obj.get("x", coords.get("x"))
                y = obj.get("y", coords.get("y"))
                z = obj.get("z", coords.get("z"))
                if x is None:
                    continue
                systems[n.upper()] = {
                    "x": round(float(x), 2),
                    "y": round(float(y), 2),
                    "z": round(float(z), 2),
                }
            sys_loaded = True
            log(f"  systems from {name}: {len(systems)}")
            break
        else:
            # CSV
            reader = csv.DictReader(io.StringIO(text))
            for row in reader:
                n = (row.get("name") or row.get("Name") or "").strip()
                if not n:
                    continue
                try:
                    systems[n.upper()] = {
                        "x": round(float(row.get("x") or row.get("X") or 0), 2),
                        "y": round(float(row.get("y") or row.get("Y") or 0), 2),
                        "z": round(float(row.get("z") or row.get("Z") or 0), 2),
                    }
                except ValueError:
                    continue
            sys_loaded = True
            log(f"  systems from {name}: {len(systems)}")
            break

    if not sys_loaded:
        raise SystemExit("Could not load any systems file from EDDBlink base")

    # --- stations ---
    st_loaded = False
    for name in ("stations.jsonl", "Station.csv", "stations.csv"):
        try:
            text = download_text(base + name)
        except Exception as e:
            log(f"  skip {name}: {e}")
            continue
        if name.endswith(".jsonl"):
            for line in text.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                st_name = (obj.get("name") or "").strip()
                sys_name = (
                    (obj.get("systemName") or obj.get("system") or "")
                    if not isinstance(obj.get("system"), dict)
                    else (obj.get("system") or {}).get("name", "")
                )
                sys_name = (sys_name or "").strip()
                if not st_name or not sys_name:
                    continue
                sys_key = sys_name.upper()
                if sys_key not in systems:
                    continue
                key = f"{sys_key}/{st_name.upper()}"
                pad = "L"
                if obj.get("max_landing_pad_size") or obj.get("maxLandingPadSize"):
                    s = str(
                        obj.get("max_landing_pad_size")
                        or obj.get("maxLandingPadSize")
                    ).upper()
                    pad = "L" if s.startswith("L") else "M"
                elif obj.get("landingPads"):
                    pad = pad_size_from_station(obj)
                stations[key] = {
                    "system": sys_key,
                    "pad": pad,
                    "distLs": int(
                        obj.get("distance_to_star")
                        or obj.get("distanceToArrival")
                        or obj.get("distance")
                        or 0
                    ),
                    "planetary": bool(
                        obj.get("is_planetary")
                        or obj.get("isPlanetary")
                        or "planetary" in str(obj.get("type", "")).lower()
                    ),
                    "market": {},
                }
                sid = obj.get("id") or obj.get("market_id") or obj.get("marketId")
                if sid is not None:
                    id_to_key[str(sid)] = key
            st_loaded = True
            log(f"  stations from {name}: {len(stations)}")
            break
        else:
            reader = csv.DictReader(io.StringIO(text))
            for row in reader:
                st_name = (row.get("name") or row.get("Name") or "").strip()
                sys_name = (
                    row.get("system_name")
                    or row.get("systemName")
                    or row.get("System")
                    or ""
                ).strip()
                if not st_name or not sys_name:
                    continue
                sys_key = sys_name.upper()
                if sys_key not in systems:
                    continue
                key = f"{sys_key}/{st_name.upper()}"
                pad_raw = (
                    row.get("max_landing_pad_size")
                    or row.get("maxLandingPadSize")
                    or "L"
                )
                pad = "L" if str(pad_raw).upper().startswith("L") else "M"
                stations[key] = {
                    "system": sys_key,
                    "pad": pad,
                    "distLs": int(
                        float(
                            row.get("distance_to_star")
                            or row.get("distanceToStar")
                            or 0
                        )
                    ),
                    "planetary": str(
                        row.get("is_planetary") or row.get("isPlanetary") or ""
                    ).lower()
                    in ("1", "true", "t", "yes"),
                    "market": {},
                }
                sid = row.get("id") or row.get("station_id") or row.get("market_id")
                if sid:
                    id_to_key[str(sid)] = key
            st_loaded = True
            log(f"  stations from {name}: {len(stations)}")
            break

    if not st_loaded:
        raise SystemExit("Could not load any stations file from EDDBlink base")

    # --- listings (prices) ---
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
                or row.get("id")
            )
            if sid is None:
                continue
            key = id_to_key.get(str(sid))
            if not key or key not in stations:
                continue
            commodity = (
                row.get("commodity_name")
                or row.get("commodity")
                or row.get("name")
                or row.get("Commodity")
                or ""
            ).strip()
            if not commodity:
                # sometimes only commodity_id – skip without a name map
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
            if max_stations and len([s for s in stations.values() if s["market"]]) >= max_stations:
                break
        log(f"  listings from {name}: {n_rows} price rows")
        listings_loaded = True
        if n_rows > 0:
            break

    if not listings_loaded:
        log("WARNING: no listings loaded – markets will be empty")

    # drop stations with empty markets
    before = len(stations)
    stations = {k: v for k, v in stations.items() if v.get("market")}
    log(f"EDDBlink: kept {len(stations)} stations with markets (dropped {before - len(stations)})")

    # keep only systems that still have stations
    used = {v["system"] for v in stations.values()}
    systems = {k: v for k, v in systems.items() if k in used}

    return systems, stations, base


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def write_data(systems, stations, source_label, out_path: str):
    data = {
        "generated_at": utc_now(),
        "source": source_label,
        "systems": systems,
        "stations": stations,
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    size_mb = Path(out_path).stat().st_size / 1e6
    log(f"Wrote {out_path} ({size_mb:.1f} MB, {len(stations)} stations, {len(systems)} systems).")


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

    write_data(systems, stations, label, args.out)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Rebuild data/trade-data.json (sharded if large) from Spansh galaxy dump."""
from __future__ import annotations

import argparse
import gzip
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

DEFAULT_SOURCE_URL = os.environ.get(
    "TD_SOURCE_URL",
    "https://downloads.spansh.co.uk/galaxy_stations.json.gz",
)
MAX_STATIONS = int(os.environ.get("TD_MAX_STATIONS", "15000")) or None
MAX_LY = float(os.environ.get("TD_MAX_LY", "800"))
MAX_SHARD_BYTES = int(os.environ.get("TD_MAX_SHARD_BYTES", "40000000"))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def open_source(url: str):
    log(f"Downloading {url} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "trade-dangerous-web/2.3"})
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


def extract_market(raw: dict):
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
        if not ((buy > 0 and supply > 0) or (sell > 0 and demand > 0)):
            continue
        # skip obvious salvage
        u = name.strip().upper()
        if u in ("ASSAULT PLANS", "RARE ARTWORK", "BLACK BOX", "MILITARY PLANS", "TRADE DATA"):
            continue
        out[u] = {"buy": buy, "sell": sell, "supply": supply, "demand": demand}
    return out or None


def build(source_url: str, out_path: str, max_stations):
    if ijson is None:
        raise SystemExit("pip install ijson")

    candidates = []
    skipped = 0
    seen = 0
    t0 = time.time()
    max_ly = MAX_LY
    log(f"Scanning dump (within {max_ly} ly of Sol, cap={max_stations})…")

    with open_source(source_url) as fh:
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
                mkt = extract_market(st)
                if not mkt:
                    skipped += 1
                    continue
                st_type = str(st.get("type") or "").lower()
                key = f"{sys_key}/{st_name.strip().upper()}"
                entry = {
                    "system": sys_key,
                    "pad": pad_size_from_station(st),
                    "distLs": int(
                        st.get("distanceToArrival") or st.get("distance_to_arrival") or 0
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
                    log(f"  …{seen} market stations ({time.time() - t0:.0f}s)")

    candidates.sort(key=lambda c: (c[0], c[1]))
    if max_stations and len(candidates) > max_stations:
        candidates = candidates[:max_stations]

    systems = {}
    stations = {}
    for dist_sol, key, sys_key, sys_coords, entry in candidates:
        systems[sys_key] = sys_coords
        stations[key] = entry

    log(f"Kept {len(stations)} stations in {len(systems)} systems (scanned {seen}, skipped {skipped})")
    write_sharded(systems, stations, source_url, out_path)


def write_sharded(systems, stations, source_label, out_path: str):
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    for old in out.parent.glob("trade-data-*.json"):
        old.unlink(missing_ok=True)

    probe = json.dumps(
        {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": source_label,
            "systems": systems,
            "stations": stations,
        },
        separators=(",", ":"),
    )
    if len(probe) <= MAX_SHARD_BYTES:
        out.write_text(probe, encoding="utf-8")
        log(f"Wrote {out} ({len(probe)/1e6:.1f} MB)")
        return

    items = list(stations.items())
    shards = []
    i = 0
    idx = 0
    while i < len(items):
        shard = {}
        size_est = 20
        while i < len(items):
            k, v = items[i]
            add = len(json.dumps({k: v}, separators=(",", ":"))) + 1
            if size_est + add > MAX_SHARD_BYTES and shard:
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
        if path.stat().st_size > 95_000_000:
            raise SystemExit(f"{fname} still over 95MB — lower TD_MAX_STATIONS")

    meta = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source_label,
        "systems": systems,
        "shards": shards,
        "station_count": len(stations),
        "system_count": len(systems),
    }
    out.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    log(f"Wrote meta {out} + {len(shards)} shards")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/trade-data.json")
    ap.add_argument("--source", default=DEFAULT_SOURCE_URL)
    ap.add_argument("--max-stations", type=int, default=MAX_STATIONS)
    args = ap.parse_args()
    build(args.source, args.out, args.max_stations)


if __name__ == "__main__":
    main()

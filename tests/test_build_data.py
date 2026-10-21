"""Run with: python3 -m unittest discover -s tests -v

ijson is not required to run these tests: if it is missing, a tiny stand-in that reads
the whole (small) fixture is used. CI installs the real ijson via requirements.txt.
"""
import gzip
import json
import sys
import tempfile
import time
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import ijson  # noqa: F401
except ImportError:
    stub = types.ModuleType("ijson")
    stub.items = lambda fh, prefix, **kw: iter(json.load(fh))
    sys.modules["ijson"] = stub

import build_data as bd  # noqa: E402


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00")


NOW = int(time.time())


def commodity(name, buy=0, sell=0, supply=0, demand=0):
    return {"name": name, "buyPrice": buy, "sellPrice": sell, "supply": supply, "demand": demand}


def station(name, comms, age_s=3600, typ="Orbis Starport", pads=None, prohibited=None):
    return {
        "name": name,
        "type": typ,
        "distanceToArrival": 500,
        "landingPads": pads or {"large": 2, "medium": 2, "small": 2},
        "market": {
            "updateTime": iso(NOW - age_s),
            "commodities": comms,
            "prohibitedCommodities": prohibited or [],
        },
    }


def fixture():
    systems = [
        {"name": "Sol", "coords": {"x": 0, "y": 0, "z": 0}, "stations": [
            station("Abraham Lincoln", [commodity("Gold", buy=9000, supply=100), commodity("Grain", sell=300, demand=500)]),
            station("Stale Port", [commodity("Gold", buy=9000, supply=100)], age_s=30 * 86400),
            station("X9Z-123", [commodity("Gold", sell=9500, demand=50)], typ="Drake-Class Carrier"),
            station("Tiny Outpost", [commodity("Grain", buy=100, supply=5)], pads={"small": 1}),
            station("Surface Camp", [commodity("Grain", buy=100, supply=5)], typ="Odyssey Settlement"),
            station("Empty", [commodity("Gold")]),
        ]},
        {"name": "Alpha Centauri", "coords": {"x": 3, "y": 0, "z": 0}, "stations": [
            station("Hutton Orbital", [
                commodity("Gold", sell=9800, demand=10),
                commodity("Grain", buy=100, supply=0),          # no stock -> buy price must be dropped
                commodity("Black Box", buy=5, supply=5),         # salvage -> excluded
                commodity("Painite", sell=1, demand=10),         # illegal here
            ], prohibited=["Painite"]),
        ]},
    ]
    return systems


class BuildTests(unittest.TestCase):
    def build(self, systems, **kw):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        src = Path(tmp.name) / "dump.json.gz"
        with gzip.open(src, "wt") as f:
            json.dump(systems, f)
        out = Path(tmp.name) / "out" / "trade-data.json"
        args = ["--source", str(src), "--out", str(out), "--max-age-days", str(kw.get("age", 7)),
                "--carrier-max-age-days", str(kw.get("carrier_age", 14)),
                "--max-stations", str(kw.get("cap", 0)), "--tile-stations", str(kw.get("tile", 2500))]
        if kw.get("previous"):
            args += ["--previous", str(kw["previous"])]
        self.assertEqual(bd.main(args), 0)
        meta = json.loads(out.read_text())
        stations = {}
        for t in meta["tiles"]:
            stations.update(json.loads((out.parent / t["file"]).read_text())["stations"])
        self.index = json.loads((out.parent / meta["index"]["file"]).read_text())["systems"]
        return out, meta, stations

    def test_basic_format(self):
        out, meta, st = self.build(fixture())
        self.assertEqual(meta["version"], 3)
        self.assertIn("SOL/ABRAHAM LINCOLN", st)
        self.assertEqual(self.index["SOL"][:3], [0, 0, 0])
        self.assertTrue(meta["has_ages"])
        rec = st["SOL/ABRAHAM LINCOLN"]
        self.assertEqual(rec[0], "L")                       # pad
        self.assertEqual(len(rec[4]) % 5, 0)                # flat 5-tuples
        self.assertGreater(rec[3], NOW - 2 * 3600)          # update timestamp kept
        self.assertEqual(meta["tiles"][0]["bytes"], len((out.parent / meta["tiles"][0]["file"]).read_bytes()))
        self.assertEqual(meta["index"]["bytes"], len((out.parent / meta["index"]["file"]).read_bytes()))

    def test_stale_and_empty_stations_dropped(self):
        _, _, st = self.build(fixture())
        self.assertNotIn("SOL/STALE PORT", st)
        self.assertNotIn("SOL/EMPTY", st)

    def test_flags_and_pads(self):
        _, _, st = self.build(fixture())
        self.assertEqual(st["SOL/X9Z-123"][2] & bd.FLAG_CARRIER, bd.FLAG_CARRIER)
        self.assertEqual(st["SOL/SURFACE CAMP"][2] & bd.FLAG_PLANETARY, bd.FLAG_PLANETARY)
        self.assertEqual(st["SOL/TINY OUTPOST"][0], "S")
        self.assertEqual(st["SOL/ABRAHAM LINCOLN"][2], 0)

    def test_bad_stock_salvage_and_prohibited_removed(self):
        _out, meta, st = self.build(fixture())
        names = meta["commodities"]
        rows = st["ALPHA CENTAURI/HUTTON ORBITAL"][4]
        decoded = {names[rows[i]]: rows[i + 1:i + 5] for i in range(0, len(rows), 5)}
        self.assertIn("GOLD", decoded)
        self.assertNotIn("GRAIN", decoded)       # buy price with supply 0 and nothing else
        self.assertNotIn("BLACK BOX", decoded)
        self.assertNotIn("PAINITE", decoded)

    def test_freshest_stations_win_when_capped(self):
        systems = [{"name": "Sol", "coords": {"x": 0, "y": 0, "z": 0}, "stations": [
            station("Old", [commodity("Gold", buy=100, supply=5)], age_s=5 * 86400),
            station("Mid", [commodity("Gold", buy=100, supply=5)], age_s=3600),
            station("New", [commodity("Gold", buy=100, supply=5)], age_s=60),
        ]}]
        _, meta, st = self.build(systems, cap=2)
        self.assertEqual(sorted(st), ["SOL/MID", "SOL/NEW"])
        self.assertEqual(list(self.index), ["SOL"])

    def test_not_distance_limited(self):
        systems = fixture() + [{"name": "Far Away", "coords": {"x": 20000, "y": 0, "z": 0}, "stations": [
            station("Remote", [commodity("Gold", buy=100, supply=5)])]}]
        _, _, st = self.build(systems)
        self.assertIn("FAR AWAY/REMOTE", st)

    def test_price_outliers_dropped(self):
        stations = [station(f"S{i}", [commodity("Grain", buy=100 + i, sell=0, supply=10)]) for i in range(10)]
        stations.append(station("Typo", [commodity("Grain", buy=100, sell=0, supply=10)] ))
        buyers = [station(f"B{i}", [commodity("Grain", sell=300 + i, demand=10)]) for i in range(10)]
        buyers.append(station("Bogus", [commodity("Grain", sell=30000, demand=10)]))
        systems = [{"name": "Sol", "coords": {"x": 0, "y": 0, "z": 0}, "stations": stations + buyers}]
        _, meta, st = self.build(systems)
        self.assertIn("SOL/B0", st)
        self.assertNotIn("SOL/BOGUS", st)          # its only price was an outlier -> station removed

    def test_tiles_index_and_cleanup(self):
        systems = []
        for i in range(10):
            systems.append({"name": f"Sys{i}", "coords": {"x": i * 100, "y": 0, "z": 0}, "stations": [
                station(f"S{i}-{j}", [commodity("Gold", buy=100, supply=5)]) for j in range(5)]})
        out, meta, st = self.build(systems, tile=12)
        self.assertGreater(len(meta["tiles"]), 2)
        self.assertEqual(len(st), 50)
        # every station is in the index and points at the tile that holds it
        total = 0
        for name, (x, y, z, entries) in self.index.items():
            for ent in entries:
                total += 1
                tile = meta["tiles"][ent[4]]
                bb = tile["bbox"]
                self.assertTrue(bb[0] <= x <= bb[3] and bb[1] <= y <= bb[4] and bb[2] <= z <= bb[5])
                tile_stations = json.loads((out.parent / tile["file"]).read_text())["stations"]
                self.assertIn(f"{name}/{ent[0]}", tile_stations)
        self.assertEqual(total, 50)
        # a rebuild into the same folder removes files from the previous build
        self.build_again(systems, out)
        names = sorted(p.name for p in out.parent.glob("trade-*.json") if p.name != "trade-data.json")
        meta2 = json.loads(out.read_text())
        expect = sorted([t["file"] for t in meta2["tiles"]] + [meta2["index"]["file"]])
        self.assertEqual(names, expect)

    def build_again(self, systems, out):
        src = out.parent.parent / "dump2.json.gz"
        with gzip.open(src, "wt") as f:
            json.dump(systems[:6], f)
        self.assertEqual(bd.main(["--source", str(src), "--out", str(out), "--tile-stations", "12"]), 0)

    def test_every_station_findable_by_default(self):
        old = [{"name": "Sol", "coords": {"x": 0, "y": 0, "z": 0}, "stations": [
            station("Ancient", [commodity("Gold", buy=100, supply=5)], age_s=400 * 86400)]}]
        _, _, st = self.build(old, age=0)           # 0 = no age limit (the default)
        self.assertIn("SOL/ANCIENT", st)
        self.assertIn("ANCIENT", [e[0] for e in self.index["SOL"][3]])

    def test_stale_fleet_carriers_dropped_but_stations_kept(self):
        systems = [{"name": "Sol", "coords": {"x": 0, "y": 0, "z": 0}, "stations": [
            station("Old Port", [commodity("Gold", buy=100, supply=5)], age_s=60 * 86400),
            station("K1X-9ZZ", [commodity("Gold", buy=100, supply=5)], age_s=60 * 86400, typ="Drake-Class Carrier"),
            station("L2X-9ZZ", [commodity("Gold", buy=100, supply=5)], age_s=3600, typ="Drake-Class Carrier"),
        ]}]
        _, _, st = self.build(systems, age=0)
        self.assertIn("SOL/OLD PORT", st)
        self.assertNotIn("SOL/K1X-9ZZ", st)
        self.assertIn("SOL/L2X-9ZZ", st)

    def test_unchanged_upstream_skips_build(self):
        out, meta, _ = self.build(fixture())
        src = Path(out.parent.parent / "dump.json.gz")
        info = bd.head_info(str(src))
        meta["source_etag"], meta["source_last_modified"] = info.get("etag"), info.get("last_modified")
        out.write_text(json.dumps(meta))
        before = out.stat().st_mtime_ns
        self.assertEqual(bd.main(["--source", str(src), "--out", str(out), "--previous", str(out)]), 0)
        self.assertEqual(out.stat().st_mtime_ns, before)

    def test_parse_time_formats(self):
        self.assertEqual(bd.parse_time("2024-05-01 12:00:00+00"), 1714564800)
        self.assertEqual(bd.parse_time("2024-05-01T12:00:00Z"), 1714564800)
        self.assertEqual(bd.parse_time("2024-05-01T14:00:00+02:00"), 1714564800)
        self.assertEqual(bd.parse_time("nonsense"), 0)
        self.assertEqual(bd.parse_time(None), 0)

    def test_empty_result_refuses_to_publish(self):
        systems = [{"name": "Sol", "coords": {"x": 0, "y": 0, "z": 0}, "stations": [
            station("Stale", [commodity("Gold", buy=100, supply=5)], age_s=99 * 86400)]}]
        with self.assertRaises(SystemExit):
            self.build(systems)


if __name__ == "__main__":
    unittest.main()

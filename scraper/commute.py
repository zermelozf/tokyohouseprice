"""Precomputed transit time from every station to the Lycée Français (LFIT).

The school run is a hard constraint on where you can live, and it is not the
same shape as "distance to the school": what matters is the train, not the
crow flight. This module fetches a real timetable-based journey once per
station and caches it forever — timetables move rarely, and a cached table
turns an expensive routing question into a join.

Three stations put you within walking distance of the school, so the commute
is the *best* of them rather than any single one:

    total = walk to your station + transit + walk from the arrival station

Queries are pinned to a weekday morning arrival, so the answer is the school
run rather than whatever the timetable happens to look like at request time.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import date, datetime, timedelta
from urllib.parse import quote

from .db import connect, init_db
from .fetch import Fetcher

log = logging.getLogger("suumo.commute")

# Walking minutes from each station to the school gate, at the Japanese
# convention of 80 m/min — the same rate SUUMO quotes, so the two legs of a
# journey are measured the same way.
#
# These are PEDESTRIAN ROUTE distances, not straight lines. Straight-line
# understates a real walk by 20-60% here (下板橋 is 992 m as the crow flies and
# 1,493 m on foot), which made every commute look 2-7 minutes shorter than it
# is and disagreed with Google by about that much.
LFIT = "Lycée Français International de Tokyo"
DESTINATIONS = {
    "新板橋": 10,   #   746 m on foot
    "板橋": 12,     #   881 m
    "西巣鴨": 13,   #   975 m
    "下板橋": 19,   # 1,493 m
}

# Arrive by 08:30 on a weekday: the school run, not an off-peak average.
ARRIVE_HOUR, ARRIVE_MIN = 8, 30

# Typical wait for a suburban bus at commuter frequency.
BUS_WAIT_MIN = 5


def _next_weekday() -> date:
    """A near-future Monday, so the query is reproducible and not a holiday
    edge case at the current date."""
    d = date.today() + timedelta(days=1)
    while d.weekday() != 0:
        d += timedelta(days=1)
    return d


def _url(origin: str, dest: str, when: date) -> str:
    return (
        "https://transit.yahoo.co.jp/search/result"
        f"?from={quote(origin)}&to={quote(dest)}"
        f"&y={when.year}&m={when.month:02d}&d={when.day:02d}"
        f"&hh={ARRIVE_HOUR:02d}&m1={ARRIVE_MIN // 10}&m2={ARRIVE_MIN % 10}"
        "&type=4&ticket=ic&expkind=1&ws=3"   # type=4: arrive by
    )


_TOTAL = re.compile(r"着\s*(?:(\d+)\s*時間)?\s*(\d+)\s*分")
_TRANSFERS = re.compile(r"乗換：\s*(\d+)\s*回")
_FARE = re.compile(r"IC優先：\s*([\d,]+)\s*円")


def parse_route(html: str) -> dict | None:
    """Fastest route from a Yahoo!路線情報 result page.

    Routes are listed fastest-first under the 'ルート 1' summary, so the first
    block is the one to read.
    """
    m = re.search(r'<div class="routeSummary">(.*?)</div>\s*</div>', html, re.S)
    if not m:
        return None
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", m.group(1)))
    total = _TOTAL.search(text)
    if not total:
        return None
    minutes = int(total.group(2)) + 60 * int(total.group(1) or 0)
    transfers = _TRANSFERS.search(text)
    fare = _FARE.search(text)
    return {
        "transit_min": minutes,
        "transfers": int(transfers.group(1)) if transfers else None,
        "fare_yen": int(fare.group(1).replace(",", "")) if fare else None,
    }


def fetch_station(origin: str, fetcher: Fetcher, when: date | None = None) -> dict | None:
    """Best journey from `origin` to the school, over all walkable stations.

    A station that *is* one of the destinations short-circuits to its own walk:
    asking a routing engine to travel from a place to itself returns nothing
    useful.
    """
    when = when or _next_weekday()
    if origin in DESTINATIONS:
        return {"station": origin, "via": origin, "transit_min": 0, "transfers": 0,
                "fare_yen": 0, "walk_from_dest_min": DESTINATIONS[origin],
                "total_min": DESTINATIONS[origin]}

    best = None
    for dest, walk in DESTINATIONS.items():
        try:
            route = parse_route(fetcher.get(_url(normalize_name(origin), dest, when)))
        except Exception as exc:  # one unreachable pair must not lose the rest
            log.warning("commute %s -> %s failed: %s", origin, dest, exc)
            continue
        if not route:
            continue
        total = route["transit_min"] + walk
        if best is None or total < best["total_min"]:
            best = {"station": origin, "via": dest, **route,
                    "walk_from_dest_min": walk, "total_min": total}
    return best


def save(row: dict) -> None:
    conn = init_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO station_commute (station, via, transit_min, "
            "transfers, fare_yen, walk_from_dest_min, total_min, fetched_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (row["station"], row["via"], row["transit_min"], row.get("transfers"),
             row.get("fare_yen"), row["walk_from_dest_min"], row["total_min"],
             datetime.now().isoformat()))
        conn.commit()
    finally:
        conn.close()


def table() -> dict[str, dict]:
    """The whole cached table, keyed by station name."""
    conn = connect()
    try:
        return {r["station"]: dict(r)
                for r in conn.execute("SELECT * FROM station_commute")}
    finally:
        conn.close()


# --- station names seen in the crawl ---------------------------------------

# SUUMO writes the transit line two different ways, and they are not
# interchangeable:
#   rent  東京メトロ南北線/志茂駅 歩8分 , ＪＲ京浜東北線/赤羽駅 歩17分
#   sale  都営三田線「板橋本町」徒歩9分        (no 駅 suffix, 徒歩 not 歩)
# New-build cards also quote a range ("徒歩10分～12分"); the first figure is the
# nearest unit, matching how nearest_walk_min is derived.
_RENT_STATION = re.compile(r"[/／]\s*([^/／,、\s]+?)駅\s*歩\s*(\d+)\s*分")
_SALE_STATION = re.compile(r"「([^」]+)」\s*徒歩\s*(\d+)\s*分")
# Outer suburbs are sold on bus access: 「立川」バス18分停歩2分 — ride 18 minutes
# from the station, then walk 2 from the stop. Without this the listing looks
# stationless, when in fact its station is known and only the last leg differs.
_BUS_STATION = re.compile(r"「([^」]+)」\s*バス\s*(\d+)\s*分\s*停?歩\s*(\d+)\s*分")


def _station_walks(station_raw: str | None) -> list[tuple[str, int]]:
    """[(station, minutes to reach it)] from any of the card formats.

    Bus legs are counted at face value plus a flat wait, since a timetabled
    bus is not the same as a walk you can start at any moment.
    """
    if not station_raw:
        return []
    out = [(n, int(w)) for n, w in _RENT_STATION.findall(station_raw)]
    out += [(n, int(w)) for n, w in _SALE_STATION.findall(station_raw)]
    out += [(n, int(ride) + int(walk) + BUS_WAIT_MIN)
            for n, ride, walk in _BUS_STATION.findall(station_raw)]
    return out


def stations_in_listing(station_raw: str | None) -> list[str]:
    """Station names out of a SUUMO card's transit line, without the 駅 suffix —
    the routing site and the catalogue both name them without it."""
    return [n for n, _ in _station_walks(station_raw)]


def listing_commute(station_raw: str | None, cache: dict[str, dict]) -> dict | None:
    """Door-to-school time for one listing.

    A card lists several stations; the fastest is not necessarily the nearest,
    since a station one minute further away can be on a much better line. So
    every station on the card is costed and the best total wins.
    """
    best = None
    for station, walk in _station_walks(station_raw):
        row = cache.get(station)
        if not row or row.get("total_min") is None:
            continue
        total = walk + row["total_min"]
        if best is None or total < best["commute_min"]:
            best = {"commute_min": total,
                    "commute_from": station,
                    "commute_walk_min": walk,
                    "commute_transit_min": row["transit_min"],
                    "commute_via": row["via"],
                    "commute_transfers": row["transfers"]}
    return best


def annotate(rows: list[dict]) -> list[dict]:
    """Attach the school commute to each listing, in place."""
    cache = table()
    blank = {"commute_min": None, "commute_from": None, "commute_walk_min": None,
             "commute_transit_min": None, "commute_via": None,
             "commute_transfers": None}
    for r in rows:
        r.update(listing_commute(r.get("station_raw"), cache) or blank)
    return rows


def known_stations() -> list[str]:
    conn = connect()
    try:
        rows = [r[0] for r in conn.execute(
            "SELECT DISTINCT station_raw FROM listings_snapshot "
            "WHERE station_raw IS NOT NULL")]
    finally:
        conn.close()
    seen = {}
    for raw in rows:
        for s in stations_in_listing(raw):
            seen[s] = True
    return sorted(seen)


# --- full isochrone: every station within reach, computed once ------------
#
# 1,140 stations x 4 walkable destinations is ~4,500 requests. The four
# destinations are within 1.5km of each other, so their times differ by only a
# few minutes — which lets the work be halved:
#
#   phase 1  every station -> 板橋 only. Usable on its own, and anything much
#            over the cutoff here cannot be under it via a sibling station.
#   phase 2  only the survivors are measured against the other three.
#
# Every station is written as it completes, so the job is resumable: an
# interrupted run loses one request, and re-running skips what is already done.
OSM_RADIUS_M = 40_000
COARSE_DEST = "板橋"          # biggest interchange of the four
COARSE_CUTOFF_MIN = 70        # phase-1 total above this is never <60 refined


def build_catalog(radius_m: int = OSM_RADIUS_M, lat: float = 35.7501,
                  lng: float = 139.7247) -> int:
    """Every railway station within `radius_m` of the school, from OSM.

    OSM carries one node per operator at an interchange, so names are deduped
    to the closest node — 1,331 nodes collapse to ~1,140 stations.
    """
    import json as _json
    import math
    import urllib.parse
    import urllib.request

    query = (f"[out:json][timeout:180];"
             f'node["railway"="station"](around:{radius_m},{lat},{lng});out body;')
    # Overpass instances rate-limit and 504 under load; try the mirrors.
    mirrors = ["https://overpass-api.de/api/interpreter",
               "https://overpass.kumi.systems/api/interpreter",
               "https://overpass.osm.jp/api/interpreter"]
    elements, last = None, None
    for attempt in range(3):
        for host in mirrors:
            try:
                req = urllib.request.Request(
                    host, data=urllib.parse.urlencode({"data": query}).encode(),
                    headers={"User-Agent": "tokyohouseprice/1.0"})
                with urllib.request.urlopen(req, timeout=300) as resp:
                    elements = _json.load(resp)["elements"]
                break
            except Exception as exc:
                last = exc
                log.warning("overpass %s failed: %s", host, exc)
        if elements is not None:
            break
        time.sleep(5 * (attempt + 1))
    if elements is None:
        raise RuntimeError(f"overpass unavailable: {last}")

    def km(la, ln):
        R = 6371.0
        p1, p2 = math.radians(lat), math.radians(la)
        dp, dl = math.radians(la - lat), math.radians(ln - lng)
        x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * R * math.asin(math.sqrt(x))

    best: dict[str, tuple] = {}
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name:ja") or tags.get("name")
        if not name:
            continue
        d = km(el["lat"], el["lon"])
        if name not in best or d < best[name][0]:
            best[name] = (d, el["lat"], el["lon"])

    conn = init_db()
    try:
        now = datetime.now().isoformat()
        conn.executemany(
            "INSERT OR REPLACE INTO station_catalog "
            "(station, lat, lng, distance_km, fetched_at) VALUES (?,?,?,?,?)",
            [(n, la, ln, d, now) for n, (d, la, ln) in best.items()])
        conn.commit()
    finally:
        conn.close()
    return len(best)


def catalog() -> list[dict]:
    conn = connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM station_catalog ORDER BY distance_km")]
    finally:
        conn.close()


def _coarse(origin: str, fetcher: Fetcher, when: date) -> dict | None:
    """Phase 1: one destination only."""
    if origin in DESTINATIONS:
        return {"station": origin, "via": origin, "transit_min": 0, "transfers": 0,
                "fare_yen": 0, "walk_from_dest_min": DESTINATIONS[origin],
                "total_min": DESTINATIONS[origin]}
    try:
        route = parse_route(fetcher.get(_url(normalize_name(origin), COARSE_DEST, when)))
    except Exception as exc:
        log.warning("coarse %s failed: %s", origin, exc)
        return None
    if not route:
        return None
    walk = DESTINATIONS[COARSE_DEST]
    return {"station": origin, "via": COARSE_DEST, **route,
            "walk_from_dest_min": walk, "total_min": route["transit_min"] + walk}


def _save(row: dict, refined: int) -> None:
    conn = init_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO station_commute (station, via, transit_min, "
            "transfers, fare_yen, walk_from_dest_min, total_min, refined, fetched_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (row["station"], row["via"], row["transit_min"], row.get("transfers"),
             row.get("fare_yen"), row["walk_from_dest_min"], row["total_min"],
             refined, datetime.now().isoformat()))
        conn.commit()
    finally:
        conn.close()


# A bare station name is ambiguous across prefectures — 京橋 resolves to Osaka's,
# 高野 to Wakayama's — and the router happily returns an 800-minute journey
# rather than an error. OSM also decorates some names ("二重橋前〈丸の内〉"),
# which the router cannot match at all. Both are silent: the number looks like
# a number. So every result is bounds-checked against the straight-line
# distance, and failures are retried with a disambiguating prefix.
PREFECTURES = ("東京都", "埼玉県", "千葉県", "神奈川県")


def normalize_name(station: str) -> str:
    """Drop OSM's bracketed qualifiers, which no timetable search understands."""
    return re.sub(r"[〈（(\[].*?[〉）)\]]", "", station).strip()


def plausible(total_min: int | None, distance_km: float | None) -> bool:
    """Nothing here averages worse than roughly 15 km/h door to door, so a
    time far above that means the router picked a same-named station in
    another prefecture."""
    if total_min is None:
        return False
    if distance_km is None:
        return total_min <= 180
    return total_min <= 40 + 3 * distance_km


def repair(min_delay: float = 2.0, max_delay: float = 3.0) -> list[dict]:
    """Re-query every implausible row, disambiguating the station name."""
    when = _next_weekday()
    conn = connect()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT sc.station, sc.total_min, cat.distance_km "
            "FROM station_commute sc "
            "LEFT JOIN station_catalog cat ON cat.station = sc.station")]
    finally:
        conn.close()
    broken = [r for r in rows if not plausible(r["total_min"], r["distance_km"])]
    fixed = []
    if not broken:
        return fixed
    with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
        for r in broken:
            plain = normalize_name(r["station"])
            best = None
            # Bare-but-normalised first (fixes the bracket case with one call),
            # then prefecture-qualified until something plausible comes back.
            for candidate in (plain, *(p + plain for p in PREFECTURES)):
                row = fetch_station(candidate, fetcher, when)
                if row and plausible(row["total_min"], r["distance_km"]):
                    if best is None or row["total_min"] < best["total_min"]:
                        best = row
                    break
            if best:
                best["station"] = r["station"]        # keep the catalogue's name
                _save(best, refined=1)
                fixed.append({"station": r["station"], "was": r["total_min"],
                              "now": best["total_min"], "via": best["via"]})
                log.info("repaired %s: %s -> %s min",
                         r["station"], r["total_min"], best["total_min"])
            else:
                # Nothing plausible came back. A wrong number is worse than no
                # number — it would silently rank listings — so drop the value
                # and leave the row as a record that this station is unresolved.
                conn = init_db()
                try:
                    conn.execute("UPDATE station_commute SET total_min=NULL, "
                                 "transit_min=NULL, via=NULL WHERE station=?",
                                 (r["station"],))
                    conn.commit()
                finally:
                    conn.close()
                log.warning("could not resolve %s — value cleared", r["station"])
    return fixed


def build_isochrone(cutoff_min: int = COARSE_CUTOFF_MIN, min_delay: float = 2.0,
                    max_delay: float = 3.0, limit: int | None = None) -> dict:
    """Fill the commute table for every catalogued station. Resumable."""
    when = _next_weekday()
    done = table()
    todo = [s["station"] for s in catalog() if s["station"] not in done]
    if limit:
        todo = todo[:limit]
    n_coarse = 0
    with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
        for station in todo:
            row = _coarse(station, fetcher, when)
            if row:
                _save(row, refined=1 if station in DESTINATIONS else 0)
                n_coarse += 1
                if n_coarse % 25 == 0:
                    log.info("phase 1: %d/%d", n_coarse, len(todo))

        # Phase 2 — only the plausible ones are worth three more requests each.
        conn = connect()
        try:
            near = [r[0] for r in conn.execute(
                "SELECT station FROM station_commute WHERE refined=0 AND total_min<=?",
                (cutoff_min,))]
        finally:
            conn.close()
        n_refined = 0
        for station in near:
            row = fetch_station(station, fetcher, when)
            if row:
                _save(row, refined=1)
                n_refined += 1
                if n_refined % 25 == 0:
                    log.info("phase 2: %d/%d", n_refined, len(near))
    return {"coarse": n_coarse, "refined": n_refined,
            "total_cached": len(table())}


def refresh(only_missing: bool = True, min_delay: float = 2.0,
            max_delay: float = 4.0) -> list[dict]:
    """Populate the cache for every station the crawl has seen."""
    have = table() if only_missing else {}
    todo = [s for s in known_stations() if s not in have]
    out = []
    if not todo:
        return out
    with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
        for station in todo:
            row = fetch_station(station, fetcher)
            if row:
                save(row)
                out.append(row)
                log.info("commute %s -> %s via %s: %d min",
                         station, LFIT, row["via"], row["total_min"])
            else:
                log.warning("no route found for %s", station)
    return out
